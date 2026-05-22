# リソースパイプライン：FontAtlas インクリメンタルラスタライズと FileUtils の searchPath

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`FontAtlas` / `FreeType bridge` / `FileUtils` / `searchPath`

リソースパイプライン部分の 2 個のサブシステムを 1 緒に説明します：**FontAtlas のインクリメンタルラスタライズ**（事前に全グリフを焼かず、要求された時のみ焼く + 動的 atlas に置く）と **FileUtils の searchPath メカニズム**（多解像度 / 多言語 / mod システムを少量コードで支える）。両者は機能上無関係ですが、設計哲学が同じ：**「全部前処理」より「ジャストインタイム」のほうが工学的負担が小さい**。

## 1. なぜ TTF を事前に焼かないか

CJK ゲームで最初に陥る最大の罠：

> 「フォントを Texture に焼く必要があるんだろう？じゃあ起動時に全 6000 漢字を 1 枚 2048×2048 の texture に焼いて、Sprite と同じく使えばいい」

3 件で陥落：

- 2048×2048 RGBA = 16 MB、フォント 1 種だけで。bold / italic / 大小 2 種で 4 倍、64 MB。モバイル端末は startup memory budget でブロックされる。
- 6000 漢字に GB18030 第三面の珍しい字を含めると 27000 字、2048×2048 に詰めきれない、複数 texture が必要。グリフ ID → texture id + UV の hash table が必要。
- ゲームに使うのは実際 1500 字（プレイヤー名 + UI + 翻訳テキスト）、26000 字焼いて 0% 使う、純粋な無駄。

正しい工学：**プレイヤーに 1 個の字が必要になった時、その時に焼く**。

## 2. FontAtlas インクリメンタル骨格

```cpp
class FontAtlas {
    FT_Face _face;                           // FreeType フォントオブジェクト
    std::vector<Texture2D*> _pages;          // 動的に増える texture リスト
    int _currentPageX = 0, _currentPageY = 0, _currentRowH = 0;
    int _pageW = 1024, _pageH = 1024;

    struct GlyphInfo {
        int pageIndex;
        Rect uv;                             // texture 上 px 矩形
        int advance, bearingX, bearingY;
    };
    std::unordered_map<uint32_t, GlyphInfo> _glyphs;   // unicode → 情報

public:
    const GlyphInfo* getGlyph(uint32_t codepoint) {
        if (auto it = _glyphs.find(codepoint); it != _glyphs.end())
            return &it->second;
        return rasterize(codepoint);         // ジャストインタイム焼き
    }

private:
    GlyphInfo* rasterize(uint32_t cp) {
        FT_Load_Char(_face, cp, FT_LOAD_RENDER);
        auto& bmp = _face->glyph->bitmap;
        int w = bmp.width, h = bmp.rows;

        // 現 page に収まらなければ新 page
        if (_currentPageX + w > _pageW) {
            _currentPageX = 0;
            _currentPageY += _currentRowH + 1;
            _currentRowH = 0;
        }
        if (_currentPageY + h > _pageH) {
            _pages.push_back(createBlankTexture(_pageW, _pageH));
            _currentPageX = _currentPageY = _currentRowH = 0;
        }

        Texture2D* page = _pages.back();
        page->uploadSubImage(_currentPageX, _currentPageY, w, h, bmp.buffer);

        GlyphInfo g{
            .pageIndex = (int)_pages.size() - 1,
            .uv = { _currentPageX, _currentPageY, w, h },
            .advance  = _face->glyph->advance.x >> 6,
            .bearingX = _face->glyph->bitmap_left,
            .bearingY = _face->glyph->bitmap_top,
        };
        _currentPageX += w + 1;
        _currentRowH = std::max(_currentRowH, h);
        _glyphs[cp] = g;
        return &_glyphs[cp];
    }
};
```

数 KB のコード、6000 字を焼く問題を解決：

- 起動 0 ms（最初のフレームで初使用字を焼くのみ）。
- メモリ実使用 = 使用字数 × ~256 B（平均）+ 動的 atlas page。プレイヤーが 1500 字使うなら 384 KB + 1 ~ 2 個の 1024×1024 page（1 ~ 4 MB）。
- 使われない字は永遠に焼かない。

### 2.1 shelf packing：見過ごされがちな最適化

上記コードの packing 戦略は最素朴な「shelf」：横並びで 1 行、満ちたら 1 行下がる。利点はジャストインタイム書込みで再 layout が無い。欠点は **空間使用率が悪い**（行高度が最高 char で決まり、当行の小さい char の上方が浪費）。

shelf の空間使用率はおよそ 60-70%、これは Skyline / MaxRects（85-95%）に劣る。しかしより複雑な packer は **インクリメンタル不可**：新 char 追加で既存 char を移動する可能性、移動したら GPU memory 上で再 upload、加えてキャッシュ済み UV を全更新。Sprite が古い UV を引き続き使うと表示エラー。

shelf を選ぶのはこの一致性の代償を払いたくないから：**1 ピクセル焼いたら、その UV は永遠に動かない**。

### 2.2 1 px padding（重要）

`_currentPageX += w + 1` の `+1` が極めて重要。bilinear filter で隣 char の縁色が混入する：

- texture sampler が tex(u, v) を採る時、隣接 texel との重み付き平均を行う。
- 2 個 char が隣接（padding 無し）、char A の右縁 texel と char B の左縁 texel が「相互汚染」、表示すると char A の右側に幽霊 1 列の char B 縁、char B の左側に幽霊 1 列の char A 縁。
- 1 px の透明 padding で sample 範囲を分離。

これは「焼き上げた効果が変だが画像処理 SW では問題無し」典型 bug。私が初版で陥った穴、padding を加えて解決。

### 2.3 LRU 退避？

理論上：atlas page が一定数（例えば 8 個）に達したら、長く未使用の char を退避して空間を回収できる。mini-cocos では未実装、理由：

- 退避には全 Sprite が現使用 char の UV を持つ追跡が必要、複雑性高。
- 実プレイ中の文字頻度は重い長尾分布、よく使う字 1500 後はほぼ静止しない。退避が解放するメモリは少ない。
- atlas page 上限を 8 に設定、超過なら startup で OOM 早期失敗 —— 真にこんな多くの字が必要なら設計を見直すべき（複数フォント、複数言語、もしフォント分離していないか）。

将来必要時の予約：`GlyphInfo` に `lastUsedFrame: uint32_t` を追加、LRU はその時に書く、ボトルネック前ではなく。

## 3. FileUtils の searchPath

ゲームエンジンのリソースパスは恐らく最も「単純な機能、複雑な需要」の領域：

- **多解像度**：iPhone は @2x の png が欲しい、iPad は @3x、デスクトップは standard 版。
- **多言語**：UI 画像 i18n（ボタン上のテキストが pic に焼かれている）、`button_ok.zh.png` と `button_ok.en.png`。
- **mod / DLC**：プレイヤー mod を base resources にオーバーレイ、置換時に基底ファイルを変更しない。
- **テスト用 mock**：テストで実 ttf / png を逆らわず、テスト sub-folder で全置換。

cocos2d-x の解：**searchPath リスト + resolutionOrder リスト**。

```cpp
class FileUtils {
    std::vector<std::string> _searchPaths = {""};   // 既定はカレントディレクトリ
    std::vector<std::string> _resolutionOrder = {""};

public:
    void setSearchPaths(std::vector<std::string> paths) { _searchPaths = std::move(paths); }
    void setResolutionOrder(std::vector<std::string> order) { _resolutionOrder = std::move(order); }

    std::string fullPathForFilename(const std::string& filename) {
        for (auto& sp : _searchPaths) {
            for (auto& res : _resolutionOrder) {
                auto candidate = sp + res + filename;
                if (fileExists(candidate)) return candidate;
            }
        }
        return "";   // 未発見
    }
};
```

初期化時：

```cpp
fileUtils->setSearchPaths({
    "mods/awesome_mod/",   // 最高優先度
    "dlc/episode2/",
    "assets/",             // 基礎リソース
});
fileUtils->setResolutionOrder({
    "ipad/", "iphonehd/", "",   // 大屏優先、フォールバック default
});
```

`getTexture("ui/button.png")` の検索順：

```
mods/awesome_mod/ipad/ui/button.png
mods/awesome_mod/iphonehd/ui/button.png
mods/awesome_mod/ui/button.png
dlc/episode2/ipad/ui/button.png
dlc/episode2/iphonehd/ui/button.png
dlc/episode2/ui/button.png
assets/ipad/ui/button.png
assets/iphonehd/ui/button.png
assets/ui/button.png
```

このリストの **意味論的属性**：

- **早期発見＝高優先度**：mod は base を override できる、ファイル一致だけで OK、メタデータ宣言不要。
- **明示的 fallback**：ipad 版が無くても iphonehd へフォールバック、それも無ければ default。「リソース欠落で空が表示」を避ける。
- **ゼロ設定**：既定の `_searchPaths = [""]`, `_resolutionOrder = [""]`、Hello World で何も設定せず動く。
- **入口集中**：あらゆる resource load（fopen 含む）が `fullPathForFilename` を通る、デバッグ時のみ 1 行のログで全 resource 検索を観察可能。

書くコード量：30 行ほど；解決問題：多解像度、多言語、mod、テスト mock 全四件。本稿で個人的に最も気に入っている設計。

### 3.1 negative case：絶対パスは searchPath を経由しない

```cpp
std::string fullPathForFilename(const std::string& filename) {
    if (isAbsolute(filename)) return filename;
    // ...
}
```

開発機上の絶対パス（hot reload で `/tmp/test.png` 渡し）と「永遠に同じパスを返す」debug log ファイルパスを許容。

### 3.2 大文字小文字に関わる罠

Windows / macOS（既定 APFS）の filesystem は大小無関、Android / iOS / Linux は大小有関。`getTexture("UI/Button.png")` と `getTexture("ui/button.png")` は開発機で同じ、Android で 1 つ found 1 つ not。

mini-cocos の処理：debug ビルドで found pathname を実 filename と比較、不一致なら warning：

```cpp
#ifndef NDEBUG
if (caseInsensitiveMatch(candidate, filename) && !exactMatch(candidate, filename)) {
    log("[FileUtils] case mismatch: requested '%s', found '%s'", filename, candidate);
}
#endif
```

リリースで沈黙。Android で初遭遇する大小バグは多くが Windows / Mac の事前 warning で見つかる。

### 3.3 ZIP に対応すべき？

cocos2d-x 原版はあり、`searchPath` に `.zip` ファイルパスを書け、エンジンが ZIP 中 file をマウント。mini-cocos には書いていない、理由 2 つ：

- DLC 配布は OS パッケージシステム（hpk、bundle）に任せる方がよく、エンジンが自前で解凍する必要は無い。
- ZIP support は inflate library を持ち込み +200 KB binary、利得との不釣り合い。

将来 mod システムが必要になればその時に追加、`SearchPathEntry` を抽象化（普通 dir or zip）、上層は変えない。

## 4. 設計哲学：Lazy + 統一入口

両サブシステムの哲学：

| | FontAtlas | FileUtils |
|---|---|---|
| Lazy | 字は使う時に焼く | path は要求時に検索 |
| 統一入口 | 全 char 取得 `getGlyph(cp)` | 全 path 取得 `fullPathForFilename(name)` |
| 観測可能 | （unrasterized 表 + page 数） | 1 行のログで全検索 |
| 拡張点 | LRU、複数フォント | SearchPathEntry 抽象、zip / 暗号化 |

統一入口の利点が最大：エンジン全体の任意の場所で `getTexture(...)`、最終的に唯一の `fullPathForFilename` を経る；任意の場所で text を描く、最終的に唯一の `FontAtlas::getGlyph` を経る。デバッグ時にこの 2 個の関数に breakpoint や log を入れれば、リソース系統全体の挙動が見える。

> 「全 IO は 1 個の関数を経るべき」これは強い軌道、しかし極めて有用。
>
> 違反した実例：エンジン内に 3 経路の cache 戦略の異なる texture load 関数があり、それぞれメンテされ、最終的に「ある PNG はこの経路で load すると正しく、あの経路では真っ黒」というバグが残った。
>
> 「便利のため」抽象を回避するのが最も陰険なエラー源。

## 5. イテレーション記録

<!-- 今後の resource pipeline 進化をここに追記。SDF font、async load、texture compression など。 -->

*まだ無し。*

---

*本記事は [mini-cocos 設計復盤](https://github.com/leafvmaple/blog/issues/2) シリーズのサブ記事です。「統一入口」哲学は EventDispatcher の `dispatch()` も同様です（[#5](https://github.com/leafvmaple/blog/issues/5)）。*
