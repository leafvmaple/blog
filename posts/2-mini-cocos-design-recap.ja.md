# 1500 行の C++ で mini cocos2d-x を書く：mini-cocos の設計復盤

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> コミット期間：2026-03-25 → 2026-05-14、有効コミット 22 件
> 規模：~1500 行の C++17、CMake + GLFW + Lua 5.4、OpenGL 3.3 / Vulkan の二系統バックエンド

本稿は mini-cocos の**インデックス記事**である。各サブシステムの深堀りは独立した記事に分割した（末尾「シリーズ記事」を参照）。ここではプロジェクト全体を貫く骨格と、最も普遍的な工学経験のみを残す。

## 目次

- [0. なぜ「旧時代の遺物」を作り直すのか](#sec-0)
- [1. 出発点：継ぎ目は初日に引いておく (aee61f3)](#sec-1)
- [2. シリーズ記事](#sec-2)
- [3. いくつかの「小さな」コミットに見える工学的審美](#sec-3)
- [4. 復盤：3 週間、1500 行で何を学んだか](#sec-4)

---

<a id="sec-0"></a>
## 0. なぜ「旧時代の遺物」を作り直すのか

私はゲーム業界でゲームプレイ／エンジン関連の仕事を 10 年してきたが、cocos2d-x は避けて通れない一段の歴史である。エンジン自体はすでに「時代遅れ」とされているが、そこに息づく抽象 —— `Ref` + `AutoreleasePool`、`EventDispatcher` の二優先度チェーン、`Action / ActionInterval` のタイムライン、`Scheduler` の統一コールバック表 —— は今なお 2D エンジンとして極めて立派な工学的範型である。Unity の `Coroutine`、UE の `Timeline`、Unreal Slate のイベントバブリング —— 多くの設計は cocos2d-x にその源流を見出せる。

しかし私はこれらを自分の手で「育てた」ことが一度もなかった。エンジンのソースを読むのと、エンジンのソースを書くのは、まったく別種の理解である。そこで cocos2d-x を設計参照とし、OpenGL/Vulkan をレンダリングバックエンドとして、3 週間で**骨格のみを残し、シーンをロードでき、アクションを動かし、Lua をバインドし、ボタンが押せる**最小限のエンジンを書いた。この一連のブログは「エンジンの書き方」のチュートリアルではなく、各ステップで**なぜこう書いたか、なぜこう書かなかったか**のトレードオフを書き残し、自分の働き方の外化として残すものである。

---

<a id="sec-1"></a>
## 1. 出発点：継ぎ目は初日に引いておく (`aee61f3`)

初版はたった三つのことしかしていない：GLFW でウィンドウを開く、OpenGL 3.3 Core をロードする、正射影下の全画面四角形を一枚描く。シーングラフも、イベントも、メモリ管理も無い。

この版で唯一語る価値のある設計は**二つのファクトリ入口**である：

```cpp
View*         createDefaultView();
RenderDevice* createDefaultRenderDevice();
```

最初の一行から View（ウィンドウ／入力抽象）と RenderDevice（描画抽象）を分離したのは、**後に Vulkan を書くとき、main.cpp に手を入れる言い訳ができないように自分を縛るため**だった。事実、この判断は後で一度自分を救った：Vulkan に切り替えるとき、エンジンの入口は一切変わらず、プラットフォーム層に `createVulkanRenderDevice()` ファクトリを一つ足しただけで済んだ。

> 経験：抽象は最初から完成している必要は無い。しかし**継ぎ目**は初日に引いておかなければならない。後から「抽象層を一枚足す」のはほぼ確実に二度書き直しになる。

この経験はこのシリーズ全体を貫いている：複数のメモリモデルの共存、EventDispatcher の二優先度チェーン、RHI のハンドルベース API、Action の正規化時間 t —— **すべて最初からそこに引かれていた継ぎ目**であり、その後のあらゆる機能追加はその継ぎ目を通り抜けただけで、動かしていない。

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
## 4. 復盤：3 週間、1500 行で何を学んだか

今後のエンジン／ゲームプレイ仕事に向けて、自分宛にまとめるとすれば次の通り：

1. **継ぎ目は初日に引き、抽象は二つ目の実装で完成する**。最初から抽象に走ると過剰設計になる。抽象しなければほぼ確実に二度書き直しになる。
2. **「走査中に変更が入る」系のシステム**は一律 pending queue + ソフト削除 + dirty ソートで統一する。エンジン内で繰り返し現れるパターンである（→ [#4](https://github.com/leafvmaple/blog/issues/4)）。
3. **生存期間に唯一の解は無い**：autorelease は値オブジェクト向き、明示 ref-counting は GPU/IO リソース向き、`shared_ptr` はスクリプト言語埋め込みでは却って邪魔になる（→ [#3](https://github.com/leafvmaple/blog/issues/3)）。
4. **ビットフィールド sortKey、二優先度チェーン、正規化時間 t** といった「小細工」は、それぞれ後に機能追加するときの「リファクタゼロ」という対価を返してくる（→ [#6](https://github.com/leafvmaple/blog/issues/6) / [#5](https://github.com/leafvmaple/blog/issues/5) / [#7](https://github.com/leafvmaple/blog/issues/7)）。
5. **API 設計の至上目標はユーザに間違ったコードを書かせないことである**。Action 体系がその最高の例である。
6. **二つ目の実装が無ければ、抽象はプレースホルダに過ぎない**。OpenGL → Vulkan の一刀は本プロジェクト最大の収穫の一つである（→ [#6](https://github.com/leafvmaple/blog/issues/6)）。

旧エンジンを作り直すこと自体には何の「成果」も無い —— ユーザは増えないし PR も来ない。しかし工学能力という観点では、**他人が代わりに済ませてくれた一連のトレードオフを自分で再演し、誤った判断の結果を自分で被る**ことを強制される。これはソースをいくら読んでも得られない経験である。

次に mini-cocos に足す予定の機能はパーティクルシステム、Spine スケルトンアニメーション、そして Lua で完結する完全な demo プロジェクトである。出来上がったら次の記事を書く。

---

## 反復記録

<!-- 本主帖の反復規約は posts/README.md に従う。サブシステム単位の進化は対応する子篇に追記。
     サブシステム横断の構造変更（新規 RHI バックエンド、メインループ改修など）はここに一行索引を追加する。 -->

*なし。*

---

*本稿は [leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos) の設計考察を記録したものである。自分自身でエンジンを書いている方、あるいはより優雅な実装案をお持ちの方は、リポジトリの Issue 区で気軽に交流いただきたい。*
