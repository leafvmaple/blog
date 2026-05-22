# Lua バインディング：境界の安全性、メタテーブル継承、リスナーのライフタイム

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`LuaEngine` / `tolua bridge` / `lua_userdata` / `Lua listener` ライフタイム

ゲームエンジンの中で Lua バインディングは「最も単純な API、最も簡単に踏む地雷原」のサブシステムでしょう：表面上は `lua_pushcfunction(L, lua_Sprite_create)` を 1 つ書くだけ、しかし実は **C++ と Lua の 2 種のオブジェクトライフタイム + 2 種の例外モデル + 2 種の thread モデルが交差する境界**。本稿では mini-cocos の binding 設計を、UAF を確実に発生させない 3 つの「境界規則」と、リスナー lifecycle 罠 1 つに焦点を当てて整理します。

## 0. 前提：なぜそもそも Lua なのか

C++ で全てを書く方が高速・型安全・デバッグしやすい。それでも Lua 層を残す理由：

- **熱更新**：プレイヤー在線時に bug 修正を push できる、APK 再パブリッシュ不要。Lua 部分は dofile に投入できる。
- **設計者直接編集**：レベルロジック、ダイアログ分岐、数値表 —— エンジニアの介入不要、設計者が自身で書ける。
- **境界が安全クッション**：crash しても通常 Lua 層、stack trace でフレームを示せる；C++ がいきなりサインアウトされない。

代償は本稿で議論する全境界問題。

## 1. 鍵：C++ オブジェクトを Lua に表現する方法

簡単素朴な方法は `lua_pushlightuserdata(L, sprite_ptr)` で Sprite* を裸ポインタとして渡すこと。30 秒以内に陥落：

- Lua からこのポインタの method 呼び出しが不可（lightuserdata に metatable 不可）。
- C++ 側で Sprite が release されると、Lua 側のポインタはダングリング、次回 method 呼び出しで UAF。

正しい方法は `lua_newuserdata` で wrapper を作成：

```cpp
struct CocosUserdata {
    void* ptr;              // C++ 実オブジェクトへの裸ポインタ
    uint32_t type_hash;     // type 検証用
    bool owns;              // GC 時に release が必要か
    bool alive;             // C++ 側で既に消されたか
};

int lua_Sprite_create(lua_State* L) {
    Sprite* s = Sprite::create();
    s->retain();           // C++ side で 1 retain

    auto* ud = (CocosUserdata*)lua_newuserdata(L, sizeof(CocosUserdata));
    ud->ptr = s;
    ud->type_hash = TypeHash<Sprite>::value;
    ud->owns = true;
    ud->alive = true;

    luaL_getmetatable(L, "Sprite");
    lua_setmetatable(L, -2);
    return 1;
}
```

`alive` フィールドが鍵 —— 全 method 呼び出しはこれを最初にチェック：

```cpp
int lua_Sprite_setPosition(lua_State* L) {
    auto* ud = (CocosUserdata*)luaL_checkudata(L, 1, "Sprite");
    if (!ud->alive) {
        return luaL_error(L, "use of dead Sprite");
    }
    Sprite* s = static_cast<Sprite*>(ud->ptr);
    float x = luaL_checknumber(L, 2);
    float y = luaL_checknumber(L, 3);
    s->setPosition(x, y);
    return 0;
}
```

C++ 側で Sprite を release する時、Lua side の userdata に `alive = false` をマークし、それ以降の呼び出しは UAF せず Lua exception を投げる：

```cpp
void Sprite::~Sprite() {
    if (_luaUserdata) {
        _luaUserdata->alive = false;
        _luaUserdata = nullptr;
    }
}
```

userdata に対する逆方向参照は別の表（`_luaUserdata`）に保持し、循環参照を避ける（後述）。

### 1.1 userdata の `__gc`：所有権逆向き

Lua 側で userdata が GC される時、C++ retain の解放が必要：

```cpp
int lua_Sprite_gc(lua_State* L) {
    auto* ud = (CocosUserdata*)lua_touserdata(L, 1);
    if (ud->alive && ud->owns) {
        Sprite* s = static_cast<Sprite*>(ud->ptr);
        s->_luaUserdata = nullptr;       // 逆向き参照断ち
        s->release();
    }
    return 0;
}
```

`owns` フィールドは「この userdata は対応 C++ オブジェクトを参照しているだけで作成者ではない」場合のため：例えば `node->getChildren()` が返す Sprite list、これら Sprite は node が所有、Lua 側の userdata は単なる view、`owns = false` で GC は release しない。

## 2. metatable 継承：method 検索チェーン

C++ には Node → Sprite → Button の継承関係がある。Lua 側で `button:setPosition(x, y)` が動くべき（setPosition は Node の method）。実装は metatable の `__index` チェーン：

```cpp
void registerSpriteMetatable(lua_State* L) {
    luaL_newmetatable(L, "Sprite");
    lua_pushstring(L, "__index");
    lua_newtable(L);
        lua_pushcfunction(L, lua_Sprite_setTexture);
        lua_setfield(L, -2, "setTexture");
        // Sprite 専用 method...
    lua_settable(L, -3);

    // 親 metatable 連結
    luaL_getmetatable(L, "Node");
    lua_setmetatable(L, -2);     // Sprite metatable の metatable は Node metatable

    lua_pushcfunction(L, lua_Sprite_gc);
    lua_setfield(L, -2, "__gc");
    lua_pop(L, 1);
}
```

Lua が `button:setPosition` を見つける流れ：
1. button userdata の metatable（Button）の `__index` テーブルを見る → 無し
2. Button metatable の metatable（Sprite）の `__index` テーブルを見る → 無し
3. Sprite metatable の metatable（Node）の `__index` テーブルを見る → 見つけた、`lua_Node_setPosition` を返す

完全に C++ の virtual method 検索を模倣、ただし完全に table 検索で実装、shadow / 自前 override を許容。

### 2.1 型変換：「子クラスが親クラス引数を受ける」を許容

C++ で `addChild(Node* child)` の引数が Node、Sprite を渡せる。Lua 側はチェック関数を緩める必要あり：

```cpp
template <class T>
T* checkUserdata(lua_State* L, int idx) {
    auto* ud = (CocosUserdata*)lua_touserdata(L, idx);
    if (!ud || !ud->alive) {
        luaL_error(L, "argument %d: expected live %s", idx, typeName<T>());
        return nullptr;
    }
    if (!isSubclassOf(ud->type_hash, TypeHash<T>::value)) {
        luaL_error(L, "argument %d: type mismatch", idx);
        return nullptr;
    }
    return static_cast<T*>(ud->ptr);
}
```

`isSubclassOf` は C++ 側で事前生成した type tree 表（小 hash table）に基づくクエリ。RTTI の dynamic_cast に依存しない、なぜなら（a）RTTI を切るプラットフォームを互換、（b）速い。

## 3. 致命的罠：Lua closure リスナーのライフタイム

これは私が最も長く debug した bug：

```lua
local sprite = cc.Sprite.create("hero.png")
node:addChild(sprite)
local listener = cc.EventListenerTouchOneByOne.create()
listener.onTouchBegan = function(touch, event)
    sprite:setColor(cc.c3b(255, 0, 0))   -- ← sprite を upvalue としてキャプチャ
    return true
end
dispatcher:addEventListenerWithFixedPriority(listener, 1)
```

`onTouchBegan` は Lua closure、その upvalue は sprite を retain（Lua side で）。C++ 側で何が起きる？

- listener は EventDispatcher が retain。
- listener->_onTouchBegan は C++ では C function、内部は `lua_rawgeti(L, LUA_REGISTRYINDEX, closure_ref)` で closure を取り出して呼ぶ。
- closure は Lua registry が固定 ref で hold、upvalue sprite は Lua の GC に保護される（C++ side で sprite が release されてもダメ、Lua side でこの ref がまだ生きていれば、Lua GC は sprite userdata を回収しない）。
- 逆に、C++ Sprite ライフタイムは Lua の sprite refcount に「束縛」される、たとえ scene 切り替えで誰も sprite を使わなくとも、closure 1 つが捨てられない限り。

これは **「Lua 側がうっかり C++ オブジェクトのライフタイムを延長する」典型** の bug。症状：scene 切り替え後 memory が下がらない、ある listener が removeAllEventListeners() でも release されない、profile で誰も使わない Sprite が retainCount = 1 で生き続ける。

### 3.1 mini-cocos の解決：明示的所有エッジ

binding 層を強制：listener を作成する時に **bound node** を明示的に与え、node 破棄で listener を auto remove：

```lua
local listener = cc.EventListenerTouchOneByOne.create()
listener.onTouchBegan = function(t, e) sprite:setColor(...); return true end
dispatcher:addEventListenerWithFixedPriority(listener, 1, sprite)  -- 第 3 引数：所有者
```

C++ 側で：

```cpp
void EventDispatcher::addEventListener(EventListener* l, int priority, Node* owner) {
    l->_owner = owner;
    owner->_attachedListeners.push_back(l);
    // ...
}

void Node::~Node() {
    for (auto* l : _attachedListeners) {
        dispatcher->removeEventListener(l);
    }
}
```

これで owner node が破棄 → 全 listener auto remove → C++ 側の listener retainCount 0 → Lua registry の ref も解放 → upvalue sprite が GC 可能。**ライフタイムが明確化、ループから DAG に**。

C++ にだけ書くと、これは EventDispatcher の必須 API ではない（純 C++ 使用者は cleanup を手書きできる）。Lua があるからこそ強制になる。

## 4. 例外境界

C++ の `throw` は Lua stack を直接通過してはならない（Lua stack unwind は longjmp ベース、混合するとどんなクラッシュも可能）。逆も同じ：Lua の `lua_error` を C++ stack に直接 longjmp 通過させてはならない（C++ destructor 不発火、resource leak）。

mini-cocos の解：**全ての C++ → Lua 関数呼び出しを `lua_pcall` で包む、全 Lua → C++ 呼び出しを `try / catch` で包む**。

```cpp
// Lua → C++ 入口
int lua_Sprite_setTexture(lua_State* L) {
    try {
        auto* sprite = checkUserdata<Sprite>(L, 1);
        const char* path = luaL_checkstring(L, 2);
        sprite->setTexture(path);             // C++ 内で throw 可
        return 0;
    } catch (const std::exception& e) {
        return luaL_error(L, "C++ exception: %s", e.what());
    }
}

// C++ → Lua 入口
bool EventListener::callLua(int closureRef, Event* e) {
    lua_rawgeti(L, LUA_REGISTRYINDEX, closureRef);
    pushEvent(L, e);
    if (lua_pcall(L, 1, 1, 0) != LUA_OK) {
        log("Lua error in listener: %s", lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }
    bool result = lua_toboolean(L, -1);
    lua_pop(L, 1);
    return result;
}
```

両境界は **直接呼出を許容しない**。少しの繰り返しコードと引き換えに「Lua scripter のあらゆる typo（nil method 呼び出し、wrong type arg）も C++ engine の crash に変換しない、Lua exception になる」を保証。

## 5. パフォーマンス：Lua call overhead を許容範囲に保つ

`lua_pcall` を 1 呼ぶ overhead はおよそ 100 ~ 500 ns（Lua 版とプラットフォームによる）、C++ virtual call の 1ns に比べ 2 ~ 3 桁遅い。Lua で 1 万回 `node:getPosition()` を呼ぶと数 ms 食う。

mini-cocos の Lua call 性能戦略：

- **熱経路は C++ 直書き**：物理 update、レンダリング、メイン loop。Lua に行かせない。
- **Lua はイベント / ロジック driven**：「ボタンクリックでメニュー pop」「対話遷移」など、frequency が秒級。
- **常用 read-only 属性をキャッシュ**：`node:getName()` のような不変属性は Lua side で 1 回呼んで Lua table に保存。

実測：典型ゲームの 1 フレームで Lua 部分が引き起こすトータル overhead < 0.5 ms、tolerable。

### 5.1 LuaJIT は使うべき？

LuaJIT は速度 5 ~ 10 倍、JIT 後熱コードは C++ にほぼ近い。なぜ使わない：

- LuaJIT は iOS で JIT が disable（Apple ban）、純 interpreter 回帰、本家 Lua より遅い。
- LuaJIT bytecode は本家 Lua と非互換、binding layer の差別化扱いが必要。
- mini-cocos の Lua workload は性能 sensitive でない（前項参照）、ROI 不十分。

将来サーバ side workload や JIT 友好プラットフォームに移植時、binding layer 自体は再書き不要、Lua runtime 差し替えのみ。

## 6. 経験

Lua バインディングを書き終えての最大の経験：

> **全境界 API には明示的な「所有者」が必要**。
>
> リスナーには owner node が必要、coroutine には owner scene、timer には owner、async task には owner。すべて owner を渡さない API は中長期的に必ず lifecycle bug を起こす。
>
> 「キャプチャしさえすれば自動的に正しい」は嘘 —— 2 言語の GC モデルが交叉した瞬間に、自動正確は無くなる。

その他の小さな経験：

- type 検証は省略不可、たとえ「同じプロジェクトのスクリプトで型は確実」と思っても。type mismatch のクラッシュは debug 不能、明示的 error が 100 倍ユーザフレンドリー。
- Lua side で `print = function(...) log.info(...) end` を override、全 Lua print を C++ log システムに統一、debug 時の filter / file 出力が便利。
- C++ exception を Lua error に変換する時、`what()` を必ず error message に持つ。さもなくば Lua side で `lua_pcall` 失敗時に「無音」、何が壊れたか分からない。

## 7. イテレーション記録

<!-- 今後の Lua binding 進化をここに追記。新規エンジン feature の bind、性能最適化、 Lua-C++ debug ツールなど。 -->

*まだ無し。*

---

*本記事は [mini-cocos 設計復盤](https://github.com/leafvmaple/blog/issues/2) シリーズのサブ記事です。listener lifetime 問題は EventDispatcher（[#5](https://github.com/leafvmaple/blog/issues/5)）と memory model（[#3](https://github.com/leafvmaple/blog/issues/3)）に強く関連。*
