# mini-cocos：cocos2d-x をゼロから書き直す ― 設計振り返り

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> コミット期間：2026-03-25 → 2026-05-22、41 コミット
> 規模：~11,000 行の C++17、CMake + GLFW + Lua 5.4、OpenGL 3.3 / Vulkan の二系統バックエンド

本稿は mini-cocos の**インデックス記事**である。各サブシステムの深堀りは独立記事に分割した（§2 シリーズ記事を参照）。ここでは骨格のみを残す。

本文に入る前に、まずプロジェクトの指標を並べておく。データは 2026-05-22 時点：

| 指標 | 値 | 意味 |
|---|---|---|
| コミット数 | **41** | 期間 2026-03-25 → 2026-05-22 |
| `src/` の C++ 行数 | **11,237** | エンジン本体、`third_party/` を含まない |
| OpenGL 3.3 バックエンドの行数 | **900** | `src/platform/opengl/` |
| Vulkan バックエンドの行数 | **2,311** | `src/platform/vulkan/`、GL バックエンドの 2.6×（明示的リソース管理 + descriptor set + pipeline state object + command buffer 録画） |
| `RenderDevice` インターフェースの純粋仮想関数数 | **6** | `src/base/ZCRenderDevice.h`：`beginFrame` / `submit` / `endFrame` / `createTexture` / `destroyTexture` / `updateTextureRegion` |
| `mstd::` 参照数 / 残存 `std::` | **468 / 48** | 90% は [zstl](https://github.com/leafvmaple/zstl) サブモジュールへ収束済み；残る 48 箇所は文字列ユーティリティ、`std::function` スロット、IO 境界に集中 |

特に 2 行は単独で述べておく：

- **6 個の純粋仮想関数が 2.6 倍の規模差を持つ二つのバックエンドを支えている**。`RenderDevice` は GL / Vulkan の概念を一切露出していない（program handle 型も command buffer の概念も無い）。これにより GL バックエンドはコマンドキューを持っているふりをし、Vulkan バックエンドは内部で複数回の `submit` を一度の `vkQueueSubmit` に集約する。この「インターフェースを敢えて両バックエンドより狭く設計する」設計は [#6](https://github.com/leafvmaple/blog/issues/6) で詳述する。
- **二つ目のバックエンドこそが RHI 抽象の唯一の審判**。GL バックエンドだけの時には「汎用」は自己満足に過ぎず、Vulkan が実際に動いて初めて、どの API が真の継ぎ目で、どれが継ぎ目に偽装された GL 前提なのかが分かる。この経験は zonix-plus シリーズの「三つの ISA で同一の `kernel/` を走らせる」と同源である（[#11](https://github.com/leafvmaple/blog/issues/11)）。

## 目次

- [0. プロジェクトの範囲](#sec-0)
- [1. 出発点：継ぎ目は初日に引いておく (`aee61f3`)](#sec-1)
- [2. シリーズ記事](#sec-2)
- [3. いくつかの「小さな」コミットに見える工学的審美](#sec-3)
- [4. Vulkan が落ちた後もなお成立する事実](#sec-4)

---

<a id="sec-0"></a>
## 0. プロジェクトの範囲

mini-cocos は cocos2d-x を設計参照とし、OpenGL / Vulkan をレンダリングバックエンドとして、**骨格のみを残し、シーンをロードでき、アクションを動かし、Lua をバインドし、ボタンが押せる**最小限のエンジンを書くものである。cocos2d-x エンジン自体はすでに「時代遅れ」とされているが、そこに息づく抽象 —— `Ref` + `AutoreleasePool`、`EventDispatcher` の二優先度チェーン、`Action / ActionInterval` のタイムライン、`Scheduler` の統一コールバック表 —— は今なお 2D エンジンとして極めて立派な工学的範型である。Unity の `Coroutine`、UE の `Timeline`、Unreal Slate のイベントバブリングなど、多くの設計は cocos2d-x にその源流を見出せる。

この一連のブログは「エンジンの書き方」のチュートリアルではなく、各ステップで**なぜこう書いたか、なぜこう書かなかったか**のトレードオフを書き残す。

---

<a id="sec-1"></a>
## 1. 出発点：継ぎ目は初日に引いておく (`aee61f3`)

初版はたった三つのことしかしていない：GLFW でウィンドウを開く、OpenGL 3.3 Core をロードする、正射影下の全画面四角形を一枚描く。シーングラフも、イベントも、メモリ管理も無い。

この版で唯一語る価値のある設計は**二つのファクトリ入口**である：

```cpp
View*         createDefaultView();
RenderDevice* createDefaultRenderDevice();
```

最初の一行から View（ウィンドウ／入力抽象）と RenderDevice（描画抽象）を分離したのは、**後に Vulkan を書くとき、`main.cpp` に手を入れる言い訳ができないようにするため**だった。この判断の見返りは Vulkan バックエンド落地時に回収された：エンジンの入口は一切変わらず、プラットフォーム層に `createVulkanRenderDevice()` ファクトリを一つ足しただけで済んだ。

この継ぎ目はこのシリーズ全体を貫いている：複数のメモリモデルの共存、EventDispatcher の二優先度チェーン、RHI のハンドルベース API、Action の正規化時間 `t` —— **すべて最初からそこに引かれていた継ぎ目**であり、その後のあらゆる機能追加はその継ぎ目を通り抜けただけで、動かしていない。

---

<a id="sec-2"></a>
## 2. シリーズ記事

元々一本に詰め込まれていた 9 つのサブシステムを、それぞれ独立した記事に展開した。まずこの骨格篇を読み、その後興味のあるところから任意の篇を開いてほしい。各篇は相互参照するが、いずれも単独で読めるように書いた。

| # | テーマ | 一言要約 |
|---|---|---|
| [#3](https://github.com/leafvmaple/blog/issues/3) | mini-cocos の三系統メモリモデル | `Ref` + autorelease、手書き refcount、`shared_ptr` 各々の境界と判断マトリクス |
| [#4](https://github.com/leafvmaple/blog/issues/4) | 走査中の変更を扱う統一パターン | pending queue + ソフト削除 + dirty ソート。Scheduler / EventDispatcher から ECS / RCU / GC まで通底 |
| [#5](https://github.com/leafvmaple/blog/issues/5) | EventDispatcher 三度の反復 | グローバルコールバック表から二優先度チェーン + ネスト dispatch カウンタへ。ヒットテストとモーダル swallow |
| [#6](https://github.com/leafvmaple/blog/issues/6) | レンダキュー sortKey と RHI 抽象 | 64-bit sortKey 一度の sort で透明分段／state マージ／z 並び順を同時に解決。GL に「コマンドバッファがあるふり」をさせて Vulkan と揃える |
| [#7](https://github.com/leafvmaple/blog/issues/7) | Action / ActionInterval | `update(t)` という契約により Sequence / Spawn / Ease / Repeat が代数的に合成可能な時間演算になる |
| [#8](https://github.com/leafvmaple/blog/issues/8) | リソースパイプライン | FontAtlas の漸進的ラスタライズが中文 Label のパフォーマンス陥穽を解く。FileUtils の検索パスがマルチ解像度／多言語／mod を ops 設定に変える |
| [#9](https://github.com/leafvmaple/blog/issues/9) | 手書きの Lua metatable | sol2 をスキップして得るもの：コンパイル速度、エラーメッセージ、境界跨ぎ lifecycle の `alive` フラグ |
| [#10](https://github.com/leafvmaple/blog/issues/10) | Freestanding STL via mstd / zstl | エンジン全体の `std::` 呼び出しを `mstd::` 別名に集約し、[zstl](https://github.com/leafvmaple/zstl) サブモジュールで裏付け、「mini-cocos を自作 OS へ組み込む」ための下地を作る |

---

<a id="sec-3"></a>
## 3. いくつかの「小さな」コミットに見える工学的審美

以下の幾つかのコミットは、コミット履歴上は地味だが、それぞれ私が長期的に保ちたい工学習慣の象徴である。**新規の小規模リファクタは既定でこの節に追加する**（[posts/README.md の連載・反復規約](https://github.com/leafvmaple/blog/blob/main/posts/README.md) 参照）。

### 3.1 `c724ecb` —— 冗長なコンストラクタを削る

C++17 以降、下の二つはほぼ等価である：

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

ただし収益は数行減らすだけに留まらない：**クラス内初期化**により「メンバのデフォルト値」と「メンバの宣言」が同じ行に並ぶため、新人がコードを読む際にコンストラクタへ跳んで対照する必要が無くなる。

### 3.2 `bf4b46a` —— `std::erase_if` で erase-remove を置き換える

```cpp
// C++17
v.erase(std::remove_if(v.begin(), v.end(), pred), v.end());
// C++20
std::erase_if(v, pred);
```

EventDispatcher や Scheduler ではフレームごとにこの「取り消し済み entry のクリーンアップ」が走る。erase-remove は書き慣れても間違える（`v.end()` を忘れる、erase を忘れる）。`std::erase_if` に置き換えれば**一行で意図を完結に表現**でき、書き間違える余地が無い。

### 3.3 `6c1d2b3` —— キーボードとマウスを別ファイルに分ける

`EventListenerKeyboard.cpp` と `EventListenerMouse.cpp` を 1 ファイルから割いたのは潔癖に見えるが、実質的な意義は **リンク時にプラットフォーム依存を分離できる** ことにある。後に macOS 移植を行う際、マウスは NSEvent、キーボードは IOKit になる可能性が高い。ファイルを分けておけば、プラットフォーム差分は然るべき場所に閉じ込められる。

---

<a id="sec-4"></a>
## 4. Vulkan が落ちた後もなお成立する事実

以下のいくつかをここに置いたのは、**GL 単一バックエンドの初版時にはまだ直感だったが、Vulkan 双バックエンドの現在もなお反例で覆されていない**ものだからである。

1. **OpenGL バックエンド 900 行 vs Vulkan バックエンド 2,311 行、その背後は 6 個の同じ純粋仮想関数**。`RenderDevice` はいかなるバックエンド概念（program handle、command buffer、descriptor set）も露出していない —— GL バックエンドにはコマンドキューを持っているふりをさせ、Vulkan バックエンドには内部で複数回の `submit` を一度の `vkQueueSubmit` に集約させる。この「インターフェースを敢えて両バックエンドより狭く設計する」のは GL 時代には過剰抽象に見えたが、Vulkan 落地のときにその対価が返ってきた（詳細は [#6](https://github.com/leafvmaple/blog/issues/6)）。

2. **二つ目のバックエンドこそが RHI 抽象の唯一の審判**。GL だけの時には「汎用」は自己満足に過ぎず、Vulkan が実際に動いて初めてどの API が真の継ぎ目かが分かる。この経験は zonix-plus シリーズの「三つの ISA で同一の `kernel/` を走らせる」と同源である（[#11](https://github.com/leafvmaple/blog/issues/11)）。

3. **`mstd::` 参照数 468、残存 `std::` 48**。90% は [zstl](https://github.com/leafvmaple/zstl) サブモジュールへ収束済み；残る 48 箇所は文字列ユーティリティ、`std::function` スロット、IO 境界に集中。エンジン全体を freestanding 化するボトルネックは今やこの 48 箇所である（詳細は [#10](https://github.com/leafvmaple/blog/issues/10)）。

4. **Action システム 1,082 行が `Sequence` / `Spawn` / `Ease` / `Repeat` の任意のネストを支える**。すべての合成性の根本前提は `update(t∈[0,1])` という単一の契約である —— `Ease(action, easeFn)` は `update(easeFn(t))` と等価、すなわち高階関数になる（詳細は [#7](https://github.com/leafvmaple/blog/issues/7)）。

5. **Lua バインディング 1,529 行の手書き metatable**。sol2 の「3 行で済む」とは正反対の方向；この 1,529 行が買い戻したのはコンパイル速度、エラーメッセージの可読性、そして Lua/C++ 境界の `_alive` フラグがもたらす「オブジェクトが Lua 側で保持されている最中に C++ 側で delete されているかもしれない」状況への安全性である（詳細は [#9](https://github.com/leafvmaple/blog/issues/9)）。

6. **レンダリングのメインパスで一回の `std::sort` が三つの仕事を同時に片付ける**：透明分段、state マージ、z 並び順。これを支えているのは 64-bit sortKey の bit エンコーディングで、別々の render pass や pipeline キャッシュは不要（詳細は [#6](https://github.com/leafvmaple/blog/issues/6)）。

次：パーティクルシステム、Spine スケルトンアニメーション、そして Lua で完結する完全な demo プロジェクト。

---

## 反復記録

<!-- 本主帖の反復規約は posts/README.md に従う。サブシステム単位の進化は対応する子篇に追記。
     サブシステム横断の構造変更（新規 RHI バックエンド、メインループ改修など）はここに一行索引を追加する。 -->

- 2026-05-22：子篇 [#10 Freestanding STL via mstd/zstl](https://github.com/leafvmaple/blog/issues/10) を新設。サブシステム内部の進化ではなく、**サブシステムを横断する一本の新しい縫い目** —— `std::` を `mstd::` 別名に集約し、新規 [zstl](https://github.com/leafvmaple/zstl) サブモジュールで裏付け、将来 mini-cocos を自作 OS 上の UI フレームワークとして使うための下地とする。現時点で hosted ビルドは以前と完全に等価。
- 2026-05-22：レンダリング層 + Label の一括リファクタ（[`155f650`](https://github.com/leafvmaple/mini-cocos/commit/155f650) / [`6e06290`](https://github.com/leafvmaple/mini-cocos/commit/6e06290) / [`67633ba`](https://github.com/leafvmaple/mini-cocos/commit/67633ba) ほか）—— Label 構造を cocos2d-x 本家よりに揃え、`FontAtlasCache` 抽出、Renderer で Label を跨ぐバッチマージ、ActionInterval / EventDispatcher のちょっとした重複除去。詳細は各子篇（[#6](https://github.com/leafvmaple/blog/issues/6) / [#7](https://github.com/leafvmaple/blog/issues/7) / [#8](https://github.com/leafvmaple/blog/issues/8) / [#5](https://github.com/leafvmaple/blog/issues/5)）のイテレーション記録を参照。

---

*リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。*
