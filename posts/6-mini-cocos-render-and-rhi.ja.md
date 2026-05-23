# 64 ビット整数 1 個でフレーム全 draw call をソートする

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`Renderer` / `RenderQueue` / `RHI` / `OpenGL` / `Vulkan` バックエンド

mini-cocos のレンダリング層は 2 件で「メインスレッドがコマンド構築、レンダースレッドがコマンド消費」のパイプラインを支える：

```
$ wc -l src/platform/opengl/*.cpp src/platform/opengl/*.h
   ...
   900 total                  # OpenGL 3.3 バックエンド
$ wc -l src/platform/vulkan/*.cpp src/platform/vulkan/*.h
   ...
  2311 total                  # Vulkan バックエンド、GL の 2.6×
$ grep -cE "= 0;\s*$" src/base/ZCRenderDevice.h
6                              # RenderDevice インターフェイスの純粋仮想関数数：6 個で 2.6× の規模差を支える
```

2 件とは **sortKey エンコーディング**（1 つの 64-bit 整数が透明分段 / state マージ / z ソートのソートキーを同時に担う）と **RHI 抽象**（6 個の純粋仮想関数が OpenGL の暗黙状態機械 vs. Vulkan の明示的コマンドバッファという全く異なる API モデルを同じ呼び出し集合に収束させる）。前者はデータ、後者はインターフェイス。

## 1. なぜ単純な Z 順では描けないか

最も素朴な「z 昇順で描く」は 2 件で陥落する：

- **半透明オブジェクト** は後から前へ描く必要あり（alpha blend）、不透明オブジェクトは前から後ろが理想（early-Z reject）。
- **state change**（shader 切替、texture 切替、blend mode 切替）が極めて高価 —— GPU ドライバ内で pipeline 再構築、shader 再コンパイル、texture descriptor 再バインドを引き起こす可能性。1 フレームで 200 回切り替えと 20 回切り替えでは性能が桁違い。

レンダーキューは「意味論正しさ（半透明ソート）」を保ちつつ **state マージを最大化** する必要がある。直感的方法：
- 不透明：(shader, texture, vertex format) でバケット分け；
- 半透明：z 厳密降順。

この 2 条件を同時に成立させる最簡実装は **64-bit sortKey にエンコードしてキュー全体を 1 回 `std::sort`** すること。

## 2. sortKey の bit-layout

mini-cocos が現在使う layout（high → low）：

```
| 63           62 | 61 ... 56 | 55 ... 32 |  31 ... 16   |  15 ... 0  |
| translucent flag|   layer   |   depth   | material id  | mesh id    |
| 1 bit           | 6 bit     | 24 bit    | 16 bit       | 16 bit     |
```

- **bit 63（最高位）translucent flag**：0 = 不透明、1 = 半透明。`std::sort` 昇順ソート後、キュー全体は「先不透明、後半透明」の 2 段。
- **bit 62..56（6 bit）layer**：world / UI / debug / particle 等のレンダー層。layer は手動指定優先度 —— UI は常に world の後。
- **bit 55..32（24 bit）depth**：不透明段は z 昇順（前→後、early-Z 親和）；半透明段は z 降順が必要（後→前）、実装上は depth を取反してエンコード（`depth_inv = 0xFFFFFF - depth_quantized`）、これで昇順ソートしても「後→前」になる。
- **bit 31..16（16 bit）material id**：(shader, blend mode) hash。
- **bit 15..0（16 bit）mesh id**：(vertex layout, texture) hash。

この layout は BGFX や Sebastien Aaltonen の幾つかの GDC talk から直接拝借。利点は **1 回の sort で 3 件を同時にこなす**：

1. 透明 / 不透明分段。
2. 不透明段内で state マージ最大化（material → mesh の局所順序で同 shader + texture が自動的に隣接）。
3. 半透明段内で厳密な z ソート。

ソート後 1 周回し、隣接 2 cmd の material id が等しければ state change をスキップ、draw call のみ発行。これがバッチマージの実体。

### 2.1 depth の量子化

depth は float、24-bit 整数に詰める必要がある。やり方：

```cpp
uint32_t quantizeDepth(float z, float zNear, float zFar) {
    float normalized = (z - zNear) / (zFar - zNear);    // [0, 1]
    normalized = std::clamp(normalized, 0.0f, 1.0f);
    return static_cast<uint32_t>(normalized * 0xFFFFFF);
}
```

24 bit 精度は 2D / 半 3D エンジンでは充分（z 差 1 / 16M はピクセル以下）。3D エンジンは logarithmic depth や 2 段 quantize でカメラ近傍の精度集中浪費を回避する。

### 2.2 「radix sort 使うべきか」について

64-bit 整数 + N が 5k 以下なら `std::sort` は radix sort より速い（cache 親和 + 標準ライブラリの最適化）。N > 50k で radix を検討。mini-cocos はこの規模に到達していない、stdsort で充分。

## 3. RenderCommand：メインスレッドが産出する純データ

キュー内 cmd は trivially copyable な POD：

```cpp
struct RenderCommand {
    uint64_t sortKey;
    RenderProgramHandle program;
    TextureHandle       texture;
    BlendMode           blend;
    VertexBufferHandle  vbo;
    IndexBufferHandle   ibo;
    uint32_t            indexOffset;
    uint32_t            indexCount;
    Mat4                modelMatrix;
    // ... uniform デフォルトスロット
};
```

メインスレッドの `visit()` がシーングラフを走査し、各描画可能ノードから 1 個または複数の RenderCommand を `_commands` に `push_back`。**メインスレッドは GL/Vulkan API を直接叩かない**。フレーム末：

```cpp
void Renderer::flush() {
    std::sort(_commands.begin(), _commands.end(),
              [](auto& a, auto& b){ return a.sortKey < b.sortKey; });
    // _commands をレンダースレッドに swap で渡す（ダブルバッファ）
    _rhi->submit(std::move(_commands));
}
```

データと API 呼び出しを分けることの 3 つの利点：

- メインスレッドが GL context に縛られない、ロジックコードは任意のスレッドで走らせ得る。
- コマンドは POD、フレーム録画 / replay を追加できる。
- テストで mock RHI を差し込み、「このフレームは 12 個の draw call、最初 3 個の shader が同じ」とアサートできる。

## 4. RHI：GL と Vulkan を同一インターフェイスに収束

`RenderHardwareInterface` は純仮想 + handle-based の薄い抽象：

```cpp
class RHI {
public:
    virtual TextureHandle createTexture(const TextureDesc&) = 0;
    virtual void          destroyTexture(TextureHandle) = 0;

    virtual ShaderProgramHandle createProgram(const ShaderSource&) = 0;

    virtual VertexBufferHandle createVB(const void* data, size_t bytes) = 0;
    virtual IndexBufferHandle  createIB(const void* data, size_t bytes) = 0;

    virtual void submit(std::vector<RenderCommand> commands) = 0;
    virtual void present() = 0;
};
```

主要な設計選択：

### 4.1 ポインタではなくハンドル

全 GPU リソースが外に晒すのは `uint32_t` typed handle、`Texture*` ではない。理由：

- スレッド間安全 —— 整数コピーに同期不要。
- バックエンドが実リソースを自分の vector / object pool に隠せる、外部コードはバックエンド型を include する必要なし。
- ハンドルに generation bit を埋めて「use after free」検出可能（mini-cocos は現状未実装、ただし予約 bit あり）。

### 4.2 GL バックエンドが「コマンドバッファを持つフリ」

Vulkan バックエンドの `submit` は自然に secondary command buffer 録画。問題は OpenGL にこの概念が無い —— GL 呼び出しは即時、現 context に紐付き。私の方法：

```cpp
class GLBackend : public RHI {
    void submit(std::vector<RenderCommand> cmds) override {
        _pendingCmds = std::move(cmds);      // present() まで遅延
    }
    void present() override {
        for (auto& c : _pendingCmds) executeOne(c);
        _pendingCmds.clear();
        SwapBuffers();
    }
};
```

これで GL バックエンドも外観上 Vulkan と同じ「コマンドパケット提出」、内部では present 時にコマンドを 1 個ずつ `glUseProgram` / `glBindTexture` / `glDrawElements` に翻訳。**対外インターフェイスに「GL 特殊経路」は一切無し**、エンジン側コードは完全に平行移植。

代償：GL バックエンドは「事前 submit でドライバが並列準備」可能性を失う。しかし GL ドライバはそもそも並列性が低い、損失は無視可能。

### 4.3 Vulkan バックエンド：真の同期コスト

Vulkan バックエンドが GL バックエンドより必要とするもの：

- **per-frame command pool + framebuffer**（ダブルバッファ、GPU 使用前のリセット回避）。
- **descriptor set キャッシュ**：(shader, texture set) 組合せ毎に 1 set を再利用、毎フレームの再構築回避。
- **pending deletion キュー**：destroyTexture を即解放できず、fence で GPU 不使用確認を待つ。
- **pipeline キャッシュ**：(shader, vertex format, blend, depth state) 組合せを hash、ヒットすれば VkPipeline を再利用、ミスで初コンパイル（実行時初回のスタッタ要因）。

これらは GL バックエンドに不要。Vulkan バックエンドの内部に閉じ込め、エンジン側は知らない。**将来 Metal / D3D12 バックエンドを追加してもエンジン側は無変更**。

### 4.4 SPV inline vs runtime compile

shader source は GLSL で書き、SPIR-V へのコンパイルで 2 択：
- **runtime**：app に glslang を抱え、ロード時にコンパイル。利点は hot reload 容易、欠点は glslang で実行バイナリが +10MB、起動時にパースも。
- **build time**：CMake で glslangValidator を呼んで .vert/.frag を .spv にし、resource として埋め込む。実行時は `vkCreateShaderModule(spv_bytes)` 直叩き。

mini-cocos は **二系統** 採用：debug ビルドは runtime（hot reload）、release ビルドは build time（小さく速い）。同じ ShaderSource API を内部分岐：

```cpp
ShaderProgramHandle VulkanBackend::createProgram(const ShaderSource& src) {
    if (src.spv.empty()) {
        // debug: runtime compile
        auto spv = glslangCompile(src.glsl);
        return makeProgram(spv);
    } else {
        return makeProgram(src.spv);
    }
}
```

エンジン側呼び出しに知覚なし。

## 5. 1 フレームの完全パイプライン

上記 3 ブロックを連結：

```
フレーム開始
  ↓
シーングラフ visit（メインスレッド）
  - 各描画可能ノード → sortKey 計算 → commands に push_back
  ↓
sort(commands)（メインスレッド）
  ↓
rhi->submit(commands)（メインスレッドがデータを渡す）
  ↓
バックエンドが commands を走査（GL：present 時；Vulkan：command buffer 録画）
  - 隣接 cmd の material id を比較：同じなら state change スキップ
  - RHI 内部の実 draw 関数を呼ぶ
  ↓
present
  ↓
fence シグナル → pending deletion 処理
```

実測の主要収益：シーンに 200 個 sprite、**unsorted で ~150 回 state change、sorted+batched で ~12 回に低下**。draw call 数自体は変わらない（1 sprite 1 draw call）が、state change が真の性能ボトルネック。

## 6. なぜ instancing をしないか

「明白にやるべき」よくあること：同 mesh + texture の複数 sprite を `glDrawElementsInstanced` で 1 回 call、N 個描く。mini-cocos ではやっていない。理由 3 つ：

- 2D シーンでは各 sprite の transform / color / UV offset が皆異なる、instancing には per-instance buffer が必要、複雑性高。
- 真の高頻度シーン（パーティクル）は dedicated particle pipeline へ、汎用 sprite に混ぜるべきでない。
- 現状のバッチマージ + 数百 sprite で充分滑らか、profile でボトルネックに現れない。

「将来必要になれば」予約インターフェイス位置（RenderCommand に `instanceCount` を 1 つ追加、既定 1、既存経路に影響なし）。

## 7. 経験

> **RHI 抽象の成否は 1 件で見る：新バックエンド追加時にエンジン側コードを改修するか否か**。
>
> mini-cocos が GL から Vulkan を追加した時、`src/` の RHI 実装以外 **1 行も変えていない**。これがこの抽象唯一の合格基準。
>
> sortKey 部分の成否は別の 1 件で見る：**新規レンダリング特性を追加する時、ソートロジックを改修する必要があるか**。layer フィールドはこのために予約 —— layer 追加で sort 比較関数を改修する必要は無い。

具体経験：
- handle 設計の「もう 1 段の間接」は完全に元が取れる —— スレッド間、デバッグ、mock 全て恩恵。
- エンジン層でいかなる GL / Vulkan 型も漏らさない。`#include <vulkan/vulkan.h>` は RHI の実装ファイル内でのみ許容。
- sortKey エンコードが確定したら **bit-layout を再度変えない**、なぜなら hash / cache key に使われることが多い、変更は全エンジンキャッシュ無効化に等しい。最初からフィールドを広めに（ここの 6 bit layer は使い切れないが、余裕があると気持ち良い）。

## 8. イテレーション記録

<!-- 今後のレンダリング層 / RHI の進化をここに追記。Metal バックエンド、indirect draw、render graph など。 -->

- 2026-05-22：パッチ [`660ea45`](https://github.com/leafvmaple/mini-cocos/commit/660ea45) —— `Renderer::flush` 内の `transformVerts` が Label をまたぐバッチマージ時に `Color4B` を落としていた。結果、マージ後は全 alpha が 255 にリセットされ Label 不透明度が飛ぶ。sortKey + バッチマージ設計の**同一 per-vertex 属性は transform パスで一括同期しなくてはならない**という要請が露出した事例。見落としソース一コードだがそのまま視覚 bug になる。
- 2026-05-22：[`155f650`](https://github.com/leafvmaple/mini-cocos/commit/155f650) Label に**atlas page をまたぐ quad バッチマージ**を導入。これまで Label がページごとに RenderCommand を emit していたため、ページ跨ぎテキストは N 本の cmd に分裂していた；今回 Label 内部でページ単位バケットに現わし、ページごと 1 本の cmd、Label 間では Renderer 層で隣接同 page 同 material の cmd をさらにマージ。伴って sprite 専用 shader（`shaders/vulkan/sprite.{vert,frag}`）と `tools/compile_shaders.ps1` も追加、OpenGL / Vulkan バックエンドに sprite pipeline パスを付与。これにより「数千文字の Label が数千 draw call に退化しない」が成り立つ。

---

*リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本記事は [mini-cocos シリーズ](https://github.com/leafvmaple/blog/issues/2) の一篇。*
