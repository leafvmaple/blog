# 1500行のC++でmini cocos2d-xを書く：mini-cocos 設計振り返り

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> コミット期間：2026-03-25 → 2026-05-14、有効コミット22回
> 規模：~1500行のC++17、CMake + GLFW + Lua 5.4、OpenGL 3.3 / Vulkan デュアルバックエンド

## 目次

- [1500行のC++でmini cocos2d-xを書く：mini-cocos 設計振り返り](#1500行のcでmini-cocos2d-xを書くmini-cocos-設計振り返り)
  - [目次](#目次)
  - [0. なぜ「古いやつ」を再実装するのか](#0-なぜ古いやつを再実装するのか)
  - [1. まずは三角形を描画させる (`aee61f3`)](#1-まずは三角形を描画させる-aee61f3)
  - [2. メモリ管理 + スケジューラ (`e8b36a2`)](#2-メモリ管理--スケジューラ-e8b36a2)
    - [2.1 Ref + AutoreleasePool：なぜ `shared_ptr` を直接使わないのか](#21-ref--autoreleasepoolなぜ-shared_ptr-を直接使わないのか)
    - [2.2 Scheduler：ダーティフラグ + ペンディングキュー](#22-schedulerダーティフラグ--ペンディングキュー)
  - [3. イベントシステムの2回の改修 (`fb4300f` → `b3cc36c` → `4b1fc47` 系列)](#3-イベントシステムの2回の改修-fb4300f--b3cc36c--4b1fc47-系列)
    - [3.1 第1版：生のコールバック](#31-第1版生のコールバック)
    - [3.2 第2版：型ごとにサブクラス化、callback をフィールド化](#32-第2版型ごとにサブクラス化callback-をフィールド化)
    - [3.3 第3版：cocos2dx に寄せた二重リンクの EventDispatcher (`4b1fc47` / `db6b6dd` / `90acab7`)](#33-第3版cocos2dx-に寄せた二重リンクの-eventdispatcher-4b1fc47--db6b6dd--90acab7)
    - [3.4 親子ノードの遮蔽 (`bacb0f9`)](#34-親子ノードの遮蔽-bacb0f9)
  - [4. レンダリングキュー：64-bit sortKey で struct 比較を置き換える (`db7892d`)](#4-レンダリングキュー64-bit-sortkey-で-struct-比較を置き換える-db7892d)
  - [5. フォントとリソース：動的 glyph cache vs 事前焼き込みアトラス (`f91253a` / `3a5bedd`)](#5-フォントとリソース動的-glyph-cache-vs-事前焼き込みアトラス-f91253a--3a5bedd)
  - [6. Action：「時間」を組み合わせ可能なオブジェクトにする (`05c476e` / `495a6e9`)](#6-action時間を組み合わせ可能なオブジェクトにする-05c476e--495a6e9)
  - [7. Lua バインディング：手書き糊 vs sol2 (`eb546b2` / `82839bc`)](#7-lua-バインディング手書き糊-vs-sol2-eb546b2--82839bc)
  - [8. TextureCache + Animation：参照カウントを使うべきでない場面 (`983b63e`)](#8-texturecache--animation参照カウントを使うべきでない場面-983b63e)
  - [9. プラットフォーム非依存の FileUtils：検索パスと解像度の優先度 (`1154c98`)](#9-プラットフォーム非依存の-fileutils検索パスと解像度の優先度-1154c98)
  - [10. OpenGL を抽出し、デフォルトを Vulkan に切り替える (`eb0053e` / `bd9cdff` / `1831a70`)](#10-opengl-を抽出しデフォルトを-vulkan-に切り替える-eb0053e--bd9cdff--1831a70)
  - [11. 「小さな」コミットに宿る工学的美意識](#11-小さなコミットに宿る工学的美意識)
    - [11.1 `c724ecb` —— 冗長なコンストラクタを削除](#111-c724ecb--冗長なコンストラクタを削除)
    - [11.2 `bf4b46a` —— `std::erase_if` で erase-remove を置き換え](#112-bf4b46a--stderase_if-で-erase-remove-を置き換え)
    - [11.3 `6c1d2b3` —— キーボードとマウスを2ファイルに分割](#113-6c1d2b3--キーボードとマウスを2ファイルに分割)
  - [12. 振り返り：3週間で1500行、結局何を学んだのか](#12-振り返り3週間で1500行結局何を学んだのか)

---

<a id="sec-0"></a>
## 0. なぜ「古いやつ」を再実装するのか

私はゲーム業界で Gameplay / エンジン関連の仕事を10年やっていて、cocos2d-x は避けて通れない歴史だ。エンジン自体はすでに「時代遅れ」になったが、その中の抽象 —— `Ref` + `AutoreleasePool`、`EventDispatcher` の二重優先度リンク、`Action / ActionInterval` のタイムライン、`Scheduler` の統一されたコールバック表 —— は今でも 2D エンジンの中で非常にまっとうな工学的パラダイムだと思っている。Unity の `Coroutine`、UE の `Timeline`、Unreal Slate のイベントバブリング、その多くの設計の源流を cocos2d-x の中に見つけることができる。

ただ、私はこれらを自分の手で「育てた」ことがなかった。エンジンのソースを読むのと、エンジンのソースを書くのは、完全に別物の理解だ。だから cocos2d-x を設計の参照に、OpenGL/Vulkan をレンダリングバックエンドにして、3週間で **骨格だけを残し、シーンをロードでき、Action を回し、Lua をバインドし、ボタンを押せる** という最小のエンジンを書いた。この記事は「エンジンの書き方」のチュートリアルではなく、各ステップで **なぜそう書いたのか、なぜそう書かなかったのか** という取捨を文字に起こして、自分の仕事の仕方を外在化する試みだ。

---

<a id="sec-1"></a>
## 1. まずは三角形を描画させる (`aee61f3`)

最初のバージョンでやったのは3つだけ：GLFW でウィンドウを開く、OpenGL 3.3 Core をロードする、フルスクリーンの正射影下で四角形を1枚描く。シーングラフなし、イベントなし、メモリ管理なし。

このバージョンで語る価値があるのは **2つのファクトリエントリ** だ：

```cpp
View*         createDefaultView();
RenderDevice* createDefaultRenderDevice();
```

最初の1行から View（ウィンドウ／入力の抽象）と RenderDevice（レンダリング抽象）を分離したのは、**あとで Vulkan を書くときに main.cpp を直す言い訳を自分に与えないため** だ。実際この決断は1度自分を救ってくれた：後で Vulkan に切り替えたとき、エンジンのエントリポイントは一切変更せず、プラットフォーム層に `createVulkanRenderDevice()` のファクトリを足しただけで済んだ。

> 経験則：抽象は最初から完成している必要はないが、**継ぎ目** は初日に引いておかなければならない。後から「抽象層を1枚足す」ことになると、ほぼ確実に2回書き直すことになる。

---

<a id="sec-2"></a>
## 2. メモリ管理 + スケジューラ (`e8b36a2`)

これはプロジェクト2つ目のコミットで、個人的にも一番重要だと思っている —— エンジン全体の「いつデストラクトするか、いつ時間を進めるか」を決定するからだ。

<a id="sec-2-1"></a>
### 2.1 Ref + AutoreleasePool：なぜ `shared_ptr` を直接使わないのか

```cpp
class Ref {
public:
    void retain();           // ++_referenceCount
    void release();          // カウントが0になったら delete this
    void autorelease();      // 自分を現フレームの AutoreleasePool に入れる
private:
    unsigned int _referenceCount = 1;
};
```

純粋にモダン C++ の発想なら、この層は `std::shared_ptr` + `std::enable_shared_from_this` であるべきだ。それを使わなかった理由は2つある：

1. **Lua バインディングのライフサイクル**：Lua userdata の `__gc` が走るタイミングは GC が決めるので、C++ が期待するタイミングよりずっと後になることがある。`shared_ptr` で所有権を共有してしまうと、Lua 側が1つでも余計に持っている限り、エンジン側は「今すぐシーンを破棄する」ということができなくなる。`Ref` の明示的な retain/release なら、C++ 側が常に主であり続け、Lua が持っているのは本質的には弱参照になる。
2. **autorelease の「フレーム粒度の遅延破棄」は 2D エンジンの必需品**。`auto* s = Sprite::create()` で返ってきたオブジェクトを呼び出し側が解放を気にする必要はない；このフレームの終わりにプールを drain すれば、誰も retain していないものは消える。`shared_ptr` ではこの「1フレーム待つ」というセマンティクスを表現できない。

代償は明らかだ：**retain を忘れたり release を多くしたりすれば UAF になる**。私はこの代償を受け入れる —— cocos2d-x を再実装する目的の1つは、このメカニズムが真剣に使えるものなのかを体感することだったから。実際、「`create()` が返したオブジェクトはすでに autorelease されている、メンバとして保持するなら retain する」という規約さえ守れば、ほとんどのオブジェクトのライフサイクルは明確になる。

<a id="sec-2-2"></a>
### 2.2 Scheduler：ダーティフラグ + ペンディングキュー

```cpp
struct Entry {
    std::function<void(float)> callback;
    float interval, delay, elapsed;
    int   repeat, priority;
    bool  cancelled;       // <- この bool ひとつでメカニズム全体が支えられている
};
```

第1版で最も古典的な罠を踏んだ：**update のさなかに呼び出し側が callback の中でさらに entry を登録／解除する** ケースだ。`_entries` に直接 `push_back` するとイテレータが無効になるし、いま反復中の entry に `erase` するのも UAF だ。

cocos2d-x の解法をそのまま持ってきた：
- 新しい entry の登録 → まず `_pendingEntries` に入れ、次のフレームでマージ。
- entry の解除 → `cancelled = true` を立てるだけ、本物の erase は全 callback が走り終わった後。
- 優先度の並び替えは `_dirtyOrder` のダーティフラグで管理し、**1フレームに1回しか並び替えない**。登録ごとに O(n log n) を払わない。

> このパターンは後の `EventDispatcher` でもう一度登場する。**「コンテナを反復しながらコンテナを変更する」あらゆるシステム** は同じ作りに行き着く：書き込み操作のバッファリング + ソフト削除 + ダーティフラグでの並び替え。

---

<a id="sec-3"></a>
## 3. イベントシステムの2回の改修 (`fb4300f` → `b3cc36c` → `4b1fc47` 系列)

<a id="sec-3-1"></a>
### 3.1 第1版：生のコールバック

```cpp
class EventListener {
    enum class Type { Keyboard, Mouse };
    std::function<void(Event&)> onEvent;
};
```

第1版はわざと雑に書いた：イベントは全部 `Event&` に統一し、listener 側で型を判別する。動くは動くが、typed callback がほしいと `dynamic_cast` の連打になり、アプリケーション層がとてもつらい。

<a id="sec-3-2"></a>
### 3.2 第2版：型ごとにサブクラス化、callback をフィールド化

```cpp
class EventListenerKeyboard : public EventListener {
public:
    std::function<void(EventKeyboard&)> onKeyPressed;
    std::function<void(EventKeyboard&)> onKeyReleased;
};
```

なぜ virtual `onKeyPressed()` をユーザに継承させないのか？これは cocos2d-x のよく考え抜かれた取捨だ：**関数オブジェクトのメンバ変数** は仮想関数継承より、Lua クロージャを受けやすく、無名 listener を作りやすく、「1つのオブジェクトが複数のイベントを聞く」ことをやりやすい。代償は `std::function` 1段の間接呼び出しコスト —— だが1フレームのイベント数は1桁〜数十程度なので、このコストは無視してよい。

<a id="sec-3-3"></a>
### 3.3 第3版：cocos2dx に寄せた二重リンクの EventDispatcher (`4b1fc47` / `db6b6dd` / `90acab7`)

```cpp
struct EventListenerVector {
    std::vector<ListenerEntry> _fixedListeners;   // 固定優先度
    std::vector<ListenerEntry> _nodeListeners;     // シーングラフ優先度
    bool _dirtyFixedPriority;
    bool _dirtyNodePriority;
};
std::unordered_map<int /*event type*/, EventListenerVector> _listenerMap;
```

なぜ listener を「固定優先度」と「シーングラフ優先度」の2本に分けるのか？

- **固定優先度**：シーンをポーズしても止まるべきでないもの（デバッグオーバーレイ、グローバルショートカットなど）；優先度は手動で指定する整数。
- **シーングラフ優先度**：Node に紐づき、**z-order が前にあるほど優先度が高い**、シーンの構造変化に応じて自動的に変わる。

1本のリンクに詰め込むと、シーングラフの構造が変わるたびに全表を並び替える必要がある。分けておけば：
- 固定リンクはほぼ変化しない、ほぼ並び替え不要。
- シーングラフリンクは変化があったらダーティを立てて、次の `dispatchEvent` 前にまとめて並び替える。

この設計の影響はパフォーマンスだけにとどまらない：「ポーズ／レジューム」のセマンティクスや、「モーダルダイアログがすべてのイベントを食う」セマンティクスを、独立して実装できるようになる。**機能性のほうが性能より大事だ**。

<a id="sec-3-4"></a>
### 3.4 親子ノードの遮蔽 (`bacb0f9`)

最後のコミットで足したのは UI コントロールの遮蔽関係：Button A の上にある Button B をクリックしたら、B が先にイベントを食って、A には届かないようにする。

実装の鍵は、hit-test を **上から下にシーングラフ順で走査** し、ヒットしたら swallow すること。これを正しくやるためには、前述の「z-order でソート済みの nodeListeners」がそのまま使える —— 追加の空間インデックスは要らず、走査順がそのまま命中の優先順位になる。

> 設計には複利がある。EventDispatcher を cocos2dx 風にしたのは **真似たいから** ではなく、その一見冗長に見える継ぎ目（priority リンク／ダーティフラグ／二重リンク）が、後で機能を1つ足すごとに 1回の作り直しを節約してくれるからだ。

---

<a id="sec-4"></a>
## 4. レンダリングキュー：64-bit sortKey で struct 比較を置き換える (`db7892d`)

```cpp
struct RenderCommand {
    RenderCommandType type;
    RenderSortKey     sortKey;          // (pass << 48) | (layer << 32) | material
    uint32_t          submissionIndex;
    union {
        DrawSpriteCommand sprite;
        DrawQuadsCommand  quads;
    };
};
```

古典的な「ビットフィールド sortKey」のパッキング：上位ビットがレンダリング pass、中段が layer、下段がマテリアル hash。ソート時は `uint64_t` を直接比較すればよく、**CMP 1命令で済む**、メンバごとの `operator<` を踏まずに済む。

`submissionIndex` は stable sort のための tiebreak —— sortKey が完全に同じコマンドが提出順を保つ。これは batched 2D 描画でとても重要だ。さもなくば毎フレーム glyph の並びがチカチカする可能性がある。

設計の取捨：
- **instancing はしていない**。Sprite ごとに draw call 1回。初期の工学的整備 vs レンダリングスループットの綱引きで、私はデバッグしやすさ／Lua 化しやすさを取った。
- **マルチスレッド提出もしていない**。Vulkan バックエンドで worker thread を使うのは後の話で、まずシングルスレッドのパスを安定させる。

> 工学的経験則：**まず正しいことを正しくやりやすくし、その後で重要なことを速くする**。

---

<a id="sec-5"></a>
## 5. フォントとリソース：動的 glyph cache vs 事前焼き込みアトラス (`f91253a` / `3a5bedd`)

```cpp
class FontAtlas {
    std::unordered_map<char32_t, GlyphInfo> _glyphs;   // codepoint ごとにキャッシュ
};
```

`stb_truetype` で必要に応じてラスタライズし、アトラスに詰め、UV をそのままレンダリングキューに送る。

なぜ事前焼き込みのビットマップフォントを使わないのか？

- **中国語・日本語**。常用6000字を入れたビットマップアトラスは巨大か精度が悪いかになりがちで、CJK 文字を扱うシーンでは on-demand ラスタライズはほぼ必須。
- **字号の切り替えが楽**：同じ字号のときだけ FontAtlas を共有し、別の字号は自動的にそれぞれキャッシュを持つ。

代償：初出の文字に1回ラスタライズコストがかかる。UI テキストには全く問題なく、フローティングダメージ数値のように **文字集合が小さく固定** な場面では、初出後は安定する。

---

<a id="sec-6"></a>
## 6. Action：「時間」を組み合わせ可能なオブジェクトにする (`05c476e` / `495a6e9`)

```cpp
class Action            : public Ref          { virtual void step(float dt) = 0; virtual bool isDone() const = 0; };
class FiniteTimeAction  : public Action       { float _duration; };
class ActionInterval    : public FiniteTimeAction {
    float _elapsed; bool _firstTick;
    virtual void update(float t) = 0;     // t ∈ [0,1]
};
```

この3層の継承は過剰設計ではない、各層が **本質的に異なる時間のセマンティクス** に対応している：

| クラス | 何のためにあるか | 典型例 |
|---|---|---|
| `Action` | 全てのスケジュール対象アクションの基底 | `CallFunc`（瞬時） |
| `FiniteTimeAction` | 「持続時間」の概念を持つ | `DelayTime` |
| `ActionInterval` | 持続時間 + 補間可能な進捗 t | `MoveTo`, `RotateTo`, `FadeIn` |

`update(t)` が elapsed seconds ではなく正規化時間を取るのが鍵 —— **これによって `EaseIn / EaseOut / Sequence / Spawn / Repeat` が何も考えずに組み合わせられる**。任意の ActionInterval を Ease で1枚包めるし、Repeat で1枚包めるし、Sequence で繋げられる。

`495a6e9` の「ActionInterval の位置を調整」という小コミットは、実はこの層の `update(t)` を綺麗に抽出して、EaseAction が時間軸を正しく「歪める」ことができるようにするためのものだ。

> この節で一番強く感じたのは、**良いエンジンの抽象とは、ユーザに間違ったコードを書かせない設計** だということ。Action 体系のインターフェースは「先に Spawn してから Sequence」のような考え方を強制する。手書きで `if (frame > 30 && frame < 90) ...` のステートマシンを書かずに済むようになる。

---

<a id="sec-7"></a>
## 7. Lua バインディング：手書き糊 vs sol2 (`eb546b2` / `82839bc`)

sol2 は使わず、tolua++ も使わず、metatable を手で書いた：

```cpp
constexpr const char* kNodeMeta   = "zocos.Node";
constexpr const char* kSpriteMeta = "zocos.Sprite";

bool isCompatibleMetatable(lua_State* L, int idx, const char* expected) {
    if (hasMetatable(L, idx, expected)) return true;
    // 継承チェーンを上に辿る：Sprite も Node である
    if (!strcmp(expected, kNodeMeta)) {
        return hasMetatable(L, idx, kSceneMeta)
            || hasMetatable(L, idx, kSpriteMeta)
            || hasMetatable(L, idx, kLabelMeta);
    }
    return false;
}
```

なぜ sol2 を使わないのか？

1. **依存のコントロール**：sol2 は header-only だがテンプレート展開がとても重く、コンパイル時間が悲惨になる。
2. **型互換**：Lua 側で `node:addChild(sprite)` と書いたとき、`sprite`（`zocos.Sprite` metatable を持つ）を `Node` として受け入れてほしい。テンプレート系の自動バインディングは RTTI か CRTP 登録に頼ることになるが、この辺は手書きが一番直感的だ。
3. **エラーメッセージを制御できる**：手書きの type-check ならまともなエラー（"expected Node, got string"）を出せる。Lua でアプリケーション層を書くなら最も価値の高い工学的能力の1つだ。

代償はもちろん書く量が多くなることだが、mini-cocos が露出するクラスは合わせて十数個、メソッドは数十個ほどしかないので、手書きで書くほうが sol2 のテンプレートエラーと1週間格闘するよりずっと割に合う。

---

<a id="sec-8"></a>
## 8. TextureCache + Animation：参照カウントを使うべきでない場面 (`983b63e`)

```cpp
struct Entry {
    TextureHandle texture;
    Size          pixelSize;
    int           refCount;     // 手書きカウント、Ref は継承していない
};
std::unordered_map<std::string, Entry> _entriesByKey;
```

**TextureCache の Entry はわざと `Ref` を継承していない**。

なぜか？`Ref::autorelease()` はオブジェクトの破棄を次のフレームまで遅延させる。GPU リソースの解放タイミングは呼び出し側が明確にコントロールしなければならない —— 「シーンを読み込み終えたら即 unload」したとき、古いシーンのテクスチャが GPU メモリに 1フレーム余分に残るのは困る。だからここは **明示的・即時** の手書き参照カウントを使う。

Animation はその逆だ：

```cpp
class Animation : public Ref {
    std::vector<Rect> _frames;     // UV メタデータの集まりにすぎない
    float _delayPerFrame;
};
```

これはメタデータの集まりに過ぎないので、autorelease で全く問題ない。

> この経験則は特に強調しておきたい：**ref-counting は宗教ではなく道具だ**。**リソース**（GPU メモリ、ファイルハンドル、ソケット）のライフサイクルは多くの場合決定的な解放が必要で、**値オブジェクト**（アニメーションメタデータ、設定、メッセージ）は autorelease プールに投げ込むのが適している。1つのエンジンの中に2つのメモリモデルが共存するのは普通のことで、設計の欠陥ではない。

---

<a id="sec-9"></a>
## 9. プラットフォーム非依存の FileUtils：検索パスと解像度の優先度 (`1154c98`)

```cpp
class FileUtils {
    std::vector<std::string> _searchPaths;
    std::vector<std::string> _searchResolutionsOrder;
    virtual bool readBinaryFileImpl(const std::string& path, std::vector<unsigned char>& out) const = 0;
};
```

`_searchPaths` と `_searchResolutionsOrder` の2つの配列は、cocos2d-x が「リソース解決」を正しく作るための核心だ：

- 呼び出し側は `loadImage("ui/button.png")` と書く。
- フレームワークは `_searchResolutionsOrder` でプレフィックス（`"hd/"`、`"sd/"`）を連結し、`_searchPath` を順に試す。

効果：**同じコードで、解像度パックを差し替えれば retina / 普通解像度に対応できる；MOD パックを差し替えれば見た目を差し替えられる**。この「呼び出し側が意識しないアセットルーティング」は、2D エンジンがスケールできるかどうかの分水嶺だ。

---

<a id="sec-10"></a>
## 10. OpenGL を抽出し、デフォルトを Vulkan に切り替える (`eb0053e` / `bd9cdff` / `1831a70`)

```cpp
class RenderDevice {
    virtual void          beginFrame(const Mat4& proj, int w, int h)     = 0;
    virtual void          submit(const RenderCommand& cmd)               = 0;
    virtual TextureHandle createTexture(const TextureCreateInfo& info)   = 0;
    virtual void          endFrame()                                     = 0;
};
```

抽象を作り終えたのが `eb0053e`、次のコミット (`bd9cdff`) でデフォルトを Vulkan に切り替えた。

この順序は意図的だ：**抽象の本当の難しさは抽象クラスを書くことではなく、その抽象が 2つ目の実装で動くかを保証することにある**。1つのバックエンドにしか使えない RHI は、抽象がないのと同じ。先に OpenGL を抽出し、次に Vulkan をデフォルトに据えると、構造上の不合理が即座に露呈する：

- Vulkan の framebuffer は明示的なリソースで、OpenGL のような「デフォルト framebuffer 0」がない。`beginFrame` のインタフェースは強制的に `acquireSwapchainImage` のステップを切り出すことになった。
- Vulkan の SPIR-V シェーダには GLSL のようなランタイムコンパイルがない。最小の fullscreen quad shader は SPV バイト定数として `ZCVulkanMinimalSpv.inl` に直接インライン化し、**ランタイムのシェーダコンパイル依存を持ち込まない** ようにした。
- OpenGL の immediate 風 draw call と Vulkan の command buffer record は同じ `submit()` プロトコルに収束させなければならない —— 最終的には GL バックエンドにも「command buffer があるふり」をさせ（内部では即座に GL call に翻訳）、Vulkan のセマンティクスに揃えた。

`1831a70` の「OpenGL と Vulkan のコード構造を調整」はこの抽象揃えの結果だ。

> エンジン設計の経験則：**2つ目の実装がないなら、抽象は存在しない**。1つ目の実装は設計図、2つ目の実装が合格証だ。

---

<a id="sec-11"></a>
## 11. 「小さな」コミットに宿る工学的美意識

<a id="sec-11-1"></a>
### 11.1 `c724ecb` —— 冗長なコンストラクタを削除

C++17 以降、以下の2つはほぼ等価：

```cpp
// 旧
class Foo {
public:
    Foo() : _x(0), _y(0) {}
private:
    int _x, _y;
};
// 新
class Foo {
private:
    int _x = 0;
    int _y = 0;
};
```

ただし得られるものは数行の節約だけではない：**クラス内初期化** は「メンバのデフォルト値」と「メンバの宣言」を同じ行に置く、新人がコードを読むときコンストラクタに飛んで照らし合わせなくて済む。

<a id="sec-11-2"></a>
### 11.2 `bf4b46a` —— `std::erase_if` で erase-remove を置き換え

```cpp
// C++17
v.erase(std::remove_if(v.begin(), v.end(), pred), v.end());
// C++20
std::erase_if(v, pred);
```

EventDispatcher と Scheduler では「キャンセル済みの entry を掃除する」操作が毎フレーム発生する。erase-remove は書き慣れていても書き間違える（`v.end()` を漏らす、erase を忘れる）、`std::erase_if` にすれば **1行で意図を完全に表現** でき、書き間違えようがない。

<a id="sec-11-3"></a>
### 11.3 `6c1d2b3` —— キーボードとマウスを2ファイルに分割

`EventListenerKeyboard.cpp` と `EventListenerMouse.cpp` を1つのファイルから分けるのは、潔癖症のように見えるが、実際の意義は **リンク時にプラットフォーム依存を分離する** ことだ。後で macOS 移植をするなら、マウスは NSEvent、キーボードは IOKit になるかもしれない；ファイルを分けておけば、プラットフォーム差はそうあるべき場所に閉じ込められる。

---

<a id="sec-12"></a>
## 12. 振り返り：3週間で1500行、結局何を学んだのか

自分の今後のエンジン／Gameplay 仕事への教訓としていくつかにまとめるなら：

1. **継ぎ目は初日に引く、抽象は2つ目の実装で完成する**。最初から抽象すると過剰設計に、抽象しないと2回書き直す羽目になる。
2. **「反復中に変更する」システム** は一律 pending queue + ソフト削除 + ダーティソートで対処する。エンジンの中で繰り返し現れるパターンだ。
3. **ライフサイクルに単一解はない**：autorelease は値オブジェクトに、明示的 ref-counting は GPU/IO リソースに、`shared_ptr` はスクリプト言語を埋め込む場面ではむしろ邪魔になる。
4. **ビットフィールド sortKey、二重優先度リンク、正規化時間 t** といった「小さな仕掛け」は、それぞれ後で1つ機能を足すごとにリファクタリング 0 を引き換えてくれる。
5. **API 設計の最高目標はユーザに間違ったコードを書かせないこと**。Action 体系がその最良の例だ。
6. **2つ目の実装がない抽象は単なるプレースホルダ**。OpenGL → Vulkan のこの一手は、プロジェクト全体で最大の収穫の1つだった。

古いエンジンを再実装することは、プロダクトの結果から見ればなんの「成果」もない —— ユーザもつかないし、PR ももらえない。だが工学能力の観点から言うと、これは一連の **他人が代わりに済ませてくれた取捨** を自分の手でもう一度やり直し、**1つ1つの誤った決定の結末を自分で引き受ける** ことを強いる。これはどれだけソースを読んでも代替できない経験だ。

次に mini-cocos に足そうとしているのは：パーティクルシステム、Spine ボーンアニメーション、そして Lua だけで完全な demo を書けるサンプルプロジェクトだ。終わったらまた次の記事を書く。

---

*この記事は [leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos) の設計についての思考を記録したものです。自分でエンジンを書いている方や、もっとエレガントな実装のアイデアがある方は、ぜひリポジトリの Issue で話しましょう。*
