# mini-cocos の 3 つのメモリモデル：`Ref`、autorelease、そして `shared_ptr` が合わない場所

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`Ref` / `AutoreleasePool` / `TextureCache` / `Animation`

この記事を書いた発端は、mini-cocos の中に **3 種類のメモリ管理スタイルが共存している** ことです：cocos2d-x 風の `Ref` + autorelease、TextureCache の手書き refcount、そして一部の STL / Lua 境界で散発的に出現する `std::shared_ptr`。このミックスはコードレビューでよく「なぜ統一しないのか」と聞かれます。答えは：**対象オブジェクトごとに最適解が違うから**、無理に統一すると必ずどこかで意味論が犠牲になります。

以下、各モデルが mini-cocos で何を担っているかを明確にし、「いつ参照カウントを **使ってはいけないか**」を独立して論じます —— 体系の中で最も見落とされやすく、ミスると一番見つけにくい部分です。

## 1. `Ref` + AutoreleasePool が担うもの

```cpp
class Ref {
public:
    void retain();           // ++_referenceCount
    void release();          // 0 になったら delete this
    void autorelease();      // 自分を現フレームの AutoreleasePool に投げ込む
private:
    unsigned int _referenceCount = 1;
};
```

このコードだけ見ると、手書きの `std::shared_ptr` に見えるでしょう。しかし `autorelease()` こそ cocos2d-x 抽象の核心です：

- `Sprite::create()` の内部は `obj->autorelease(); return obj;`。呼び出し側が受け取るのは「このフレーム終了時に誰も retain しなければ消える」オブジェクト。
- そのフレーム内で `addChild(sprite)` すれば親ノードが `retain` する；呼び出し側がローカル変数を捨てるだけなら、pool drain で自然に消滅、リークなし。
- AutoreleasePool 自体は **明示的スコープ** オブジェクト。エンジンはメインループで毎フレーム 1 つ push し、特定の重い場面（バッチコンストラクト／逆シリアライズ）では手動でネスト pool を push/pop して、短命オブジェクトをフレーム末を待たず即回収できる。

この機構の最大の利点 —— `shared_ptr` には永遠に真似できないもの —— は **オブジェクトのデフォルト寿命を「このフレーム」に定める** こと。2D エンジン内の一時的ジオメトリ、一時 label、effect オブジェクトの 90% はこのパターンに合致します：呼び出し側はそもそも解放を考えたくない。

## 2. なぜ `std::shared_ptr` を直接使わないのか

純粋にモダン C++ の視点では、この層は `std::shared_ptr` + `std::enable_shared_from_this` が「あるべき姿」です。使わなかった理由は 2 つ、いずれも **代替不可能** です：

### 2.1 Lua バインディングが「C++ が常に主」を要求する

Lua userdata の `__gc` のタイミングは Lua GC が決めます —— C++ が期待する破棄タイミングよりかなり後ろにずれる可能性があります。`shared_ptr` で所有権を表現すると：

```lua
local s = Sprite:create()
scene:addChild(s)
-- しばらく後：
scene:removeAllChildren()
-- ただし Lua ローカル変数 s はまだ生きていて、shared_ptr の refcount >= 1
-- エンジンが「シーン全体を即解放」したくてもできない
```

C++ 側は Lua が何個所有権を持っているか知らない。`Ref` に変えれば、**Lua userdata はバインディング層で明示的に `retain()` 1 回**、`__gc` で `release()` 1 回。結果：

- シーン破棄 → エンジンが全ノードを能動的に `release()`；
- Lua ローカル変数 s はまだ存在 → 持っている userdata は retain 済みハンドル、**オブジェクト本体は既に release されて 0 まで落ち、delete されているかもしれない**；
- これは Lua 側が「is-alive チェック」をしてからでないと使えないことを意味する —— mini-cocos はバインディング層に `_alive` フラグを追加し、死んだオブジェクトへのアクセスは UAF ではなく Lua エラーを投げる。

設計の本質：**所有権は C++ 側、Lua が持つのは本質的に弱参照**。`shared_ptr` の対称所有権意味論は、この目的と根本的に衝突します。

### 2.2 「フレーム粒度の遅延破棄」を `shared_ptr` で表現できない

```cpp
auto* s = Sprite::create();   // refcount=1, autorelease 済み
if (some_cond) {
    scene->addChild(s);       // retain → refcount=2
}
// スコープ離脱；s はどの変数にも保持されていない
// フレーム末で pool drain → release → refcount=1（add した場合）or 1（しなかった場合）
// add：scene が 1 つ保持、生存；
// 未 add：refcount→0、delete。
```

等価コードを `shared_ptr` で書くと、add しない分岐では `auto s = std::make_shared<Sprite>(...)` と書いて RAII に任せる必要がある —— **しかし add した瞬間、add 関数の戻りで参照が増え、呼び出し側の RAII は意味を失う**。本質的に `shared_ptr` は「保持されているか」の判定タイミングを各代入／破棄点に置きますが、autorelease は「フレーム末」に統一する。**ゲームループにとって、フレーム末こそ自然な判定タイミング**。

### 2.3 引き受ける代償

- retain 忘れ／release 過剰 → UAF。
- 循環参照は手動で断つ（mini-cocos では parent → child が強参照、child → parent は生ポインタ）。

これらは cocos2d-x の歴史で繰り返し現れた実問題です。mini-cocos では裏支えとして 1 つの規約だけ採用：**`create()` が返すオブジェクトは全て autoreleased；メンバ変数に保存する場合は即 `retain()`、デストラクタで `release()`**。この規則を守れば 95% のライフタイムバグは消えます。

## 3. TextureCache：GPU リソースに autorelease は使えない

```cpp
struct Entry {
    TextureHandle texture;
    Size          pixelSize;
    int           refCount;     // 手書き計数、Ref を継承しない
};
std::unordered_map<std::string, Entry> _entriesByKey;
```

**TextureCache の Entry は意図的に `Ref` を継承していません**、手書き・即時の参照カウントを使います。

なぜ？autorelease の意味論は「フレーム末まで破棄を遅延」だから。GPU リソースはこれが許されません：

- シーン切替時、旧シーンの unload は **その場で GPU メモリを解放** する必要がある。さもないと次フレームの新シーンロードで **VRAM ピークが倍になる**。モバイルでは OOM クラッシュ。
- GPU リソースには「GPU が使用中」という制約も含まれる —— Vulkan バックエンドでは texture 解放は fence シグナル（GPU が本当に使い終わった）まで待たねばならず、エンジン内に明示的 `pendingDeletion` キューが必要。この機構と autorelease pool は意味論が衝突する：autorelease は「次フレームまで delete を遅延」、pendingDeletion は「GPU が使い終わるまで delete を遅延」。混ぜると曖昧。

そこで TextureCache は **明示 refcount**：
- 呼び出し側は Entry を受け取ったら自分で `++refCount`；
- unload 時 `--refCount`、0 になったら **その場で pendingDeletion キューに入れる**（Vulkan）か **その場で glDeleteTextures**（GL）。
- TextureCache 自身がキャッシュ内に 1 個の論理参照を持ち、`purgeUnreferenced()` で外部参照 0 の entry を一掃する API を提供する。

これは cocos2d-x 原版の `TextureCache` 設計と同じです。違うのは `Ref` サブクラスから POD struct + 手書き計数に降格させたことで、**表面の API を減らし autorelease の曖昧性を排除した** 点だけ。

## 4. Animation：値オブジェクトは autorelease に任せる

```cpp
class Animation : public Ref {
    std::vector<Rect> _frames;     // UV メタデータ
    float _delayPerFrame;
};
```

`Animation` は UV メタデータと 1 つのフレーム間隔定数の塊で、外部リソースハンドルは持ちません。破棄が何フレーム遅れても影響なし。`Ref` 継承後：

```cpp
auto* anim = Animation::createWithFrames(frames, 0.1f);  // autoreleased
sprite->runAction(Animate::create(anim));                 // Animate 内部で retain
// 呼び出し側は何もしなくて良い
```

これが `Ref` 体系で最も気持ち良い使い方：一時生成、対象に消費させ、自分は保持しない —— 呼び出しコード上にライフタイム関連の記述がほぼ出てきません。

> この経験を特に取り上げたい：**ref-counting は宗教ではなく道具**。
>
> - **リソース**（GPU VRAM、ファイルハンドル、socket）→ 明示・即時解放必須、手書き refcount。
> - **値オブジェクト**（アニメメタデータ、設定、メッセージ）→ autorelease pool が向く。
> - **C++/スクリプト境界をまたぐオブジェクト** → `Ref`、C++ 側に所有権主導を残す。
>
> 1 つのエンジンに 2 〜 3 種のメモリモデルが共存するのは常態であり、設計欠陥ではありません。**1 つのモデルで全てを解こうとするのが設計欠陥** です。

## 5. 決定マトリクス

mini-cocos では下表に従ってメモリモデルを決めます。新型を追加する時は感覚ではなく表を引く：

| オブジェクト特性 | 推奨モデル | 例 |
|---|---|---|
| GPU/IO リソースを持ち、解放即時性が必要 | 手書き refcount、**`Ref` 継承せず** | Texture、VertexBuffer、Sound |
| メタデータ／計算結果／メッセージのみ | `Ref` + autorelease | Animation、Event、Rect、ValueMap |
| シーングラフノード、add/remove される | `Ref` + autorelease | Node、Sprite、Label、Scene |
| Lua 境界をまたぎ Lua がハンドルを持つ | `Ref`（C++ に所有権主導） | Lua に露出する全クラス |
| 純 C++ 内部、ライフタイムが特定 owner に縛られる | `std::unique_ptr` メンバ | RenderDevice 内部の pipeline cache |
| 複数の独立所有者、ライフタイムが完全対称 | `std::shared_ptr` | mini-cocos 内では **現状無し** |

最後の行は穴埋めではなく設計の立場：**「このオブジェクトには `shared_ptr` が必要そう」と感じたら、まず「本当に対称な複数所有者があるか」を 1 回問い直す**。大抵の場合「無い、誰が主か考えるのが面倒なだけ」が正解。

## 6. イテレーション記録

<!-- 今後 mini-cocos のメモリ管理面の進化を、時系列逆順で 1 行ずつ追記。commit リンク + 一言説明。 -->

- 2026-05-22：[`be88a31`](https://github.com/leafvmaple/mini-cocos/commit/be88a31) でエンジン全体の STL 呼び出しを `std::` から `mstd::` 別名へ集約（[zstl](https://github.com/leafvmaple/zstl) サブモジュールにバックされる）、自作 OS への組み込みへの下地を作る。切ったのは「標準ライブラリ依存」の縫い目、本稿が論じる「オブジェクトライフタイム」の縫い目とは直交。詳細は [#10 Freestanding STL via mstd/zstl](https://github.com/leafvmaple/blog/issues/10) を参照。

---

*本記事は [mini-cocos 設計復盤](https://github.com/leafvmaple/blog/issues/2) シリーズのサブ記事です。シリーズ他記事は主記事末尾のインデックスを参照。*
