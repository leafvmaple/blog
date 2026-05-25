# 1 枚のエイリアスヘッダ：mini-cocos を hosted と freestanding の間で切り替える総スイッチ

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`base/ZCStd.h` / `third_party/zstl` サブモジュール / エンジン全 STL 呼出点

mini-cocos の現在の STL 収束状況（grep 実測）：

```
$ grep -rE "\bmstd::" src/ | wc -l
468                             # mstd:: の参照数
$ grep -rE "\bstd::" src/2d src/base src/scripting src/ui src/math | wc -l
48                              # platform 以外で残存する裸 std:: —— 90% は収束済み
$ wc -l src/base/ZCStd.h
53                              # 50 行のエイリアスヘッダ 1 枚で切り替え全体を支える
```

この縫い目は mini-cocos 自身より長線の目標から来る —— **自作 OS の UI フレームワークとして組み込む**。OS には host の libstdc++ が無いので、エンジン内の全 `std::vector` / `std::string` / `std::unordered_map` に置き換え可能な代替を備えておく必要がある。この刀をどう入れ、hosted ビルドへの日常的な影響を回避し、freestanding コンパイル時に全体を切り替えるか —— それが本稿の主題。残る 48 箇所の裸 `std::` は文字列ユーティリティ、`std::function` スロット、IO 境界に集中、これが freestanding 化の次のボトルネックだ。

## 1. 目標と非目標

**目標**：

- mini-cocos の「データ構造 + アルゴリズム + メモリ」レイヤの標準ライブラリ呼び出しを、すべて自分が制御できる別名（`mstd::`）に通す。host の `std::` も、自前の精簡実装（[zstl](https://github.com/leafvmaple/zstl)）も同じ別名で指す。
- 切替はコンパイルスイッチで完結、コード変更を伴わない —— 既定挙動は不変、hosted ビルドへのコストはゼロ。
- 1 個のヘッダで読み切れる：全別名は `src/base/ZCStd.h` に集中、どの STL 型を使っているかが一目で分かる。

**非目標**：

- `<filesystem>` / `<system_error>` / `<wstring>` のような宿主と密結合な API を書き直す気は無い。これらは `platform/win32/` でのみ使用、そのレイヤでは `std::` のままに保つ。
- 「libstdc++ と完全 ABI 互換」は追わない。zstl は mini-cocos が実際に使うサブセットだけをカバー、ビルドして走れば十分。
- 日常開発で zstl を使う気は無い —— hosted ビルドは引き続き `std::`、成熟実装の最適化、デバッガフレンドリ性、`std::format` 等のエコシステムを享受。

## 2. コア機構：別名ヘッダ 1 個 + スイッチ 1 個 + PCH 1 個

`src/base/ZCStd.h`（[`be88a31`](https://github.com/leafvmaple/mini-cocos/commit/be88a31)）約 50 行：

```cpp
#pragma once

#ifdef ZOCOS_USE_SYS_STL
    #include "zstl/vector.h"
    #include "zstl/string.h"
    #include "zstl/unordered_map.h"
    // ... zstl がカバーする全ヘッダ
    namespace mstd = sys;
#else
    #include <vector>
    #include <string>
    #include <unordered_map>
    #include <set>
    #include <array>
    #include <algorithm>
    #include <utility>
    #include <functional>
    #include <memory>
    #include <new>
    #include <limits>
    namespace mstd = std;
#endif
```

エンジン内の**全て**の従来書き方：

```cpp
#include <vector>
#include <unordered_map>
std::vector<Entry> _entries;
std::unordered_map<int, Texture*> _cache;
```

を機械的に書き換え：

```cpp
#include "base/ZCStd.h"
mstd::vector<Entry> _entries;
mstd::unordered_map<int, Texture*> _cache;
```

50+ ファイル、平均 +/- 1 桁、純粋な機械的操作。手作業ではなく `tools/refactor_to_mstd.ps1` で一括処理 —— commit メッセージにも "Mechanically rewrite" と明記。再現可能 + 監査可能。

### 2.1 なぜ `namespace alias`、`#define std mstd` ではなく

最も誘惑される横着方法：

```cpp
#define std mstd     // 絶対に駄目
```

醜いだけでなく、third-party ヘッダ内の `std::` も置換してしまい、奇怪なエラーを引き起こす（GLFW ヘッダの `std::function`、Vulkan ヘッダの `std::array` など）。`namespace alias` こそ唯一のクリーンな解：

- 別名は「自分側」コードにのみ作用。
- third-party ヘッダ内の `std::` を汚染しない。
- IDE で `mstd::vector` をジャンプすれば、スイッチに応じて `std::vector` か `sys::vector` に正しく到達。

### 2.2 PCH：hosted ビルドコストをゼロに

`ZCStd.h` を PCH（precompiled header）に登録、CMakeLists：

```cmake
target_precompile_headers(zocos PRIVATE src/base/ZCStd.h)
```

効果：

- 各 `.cpp` コンパイル時、STL ヘッダのパースは 1 回のみ。
- mini-cocos の 80+ ファイル全部が `mstd::` を使っている、「STL ヘッダの重複パース」コストが 0 に。
- hosted ビルド実測で ~28s（cold）→ ~19s、純粋な利得。

PCH の代償：**ZCStd.h への変更で全量再ビルド**。だがこのファイルはほぼ変更されない —— スイッチ + 別名表それだけ。

### 2.3 サブモジュール：zstl は本リポジトリに置かない

zstl は別 repo（[leafvmaple/zstl](https://github.com/leafvmaple/zstl)）、git submodule で導入：

```
.gitmodules
[submodule "third_party/zstl"]
    path = third_party/zstl
    url = https://github.com/leafvmaple/zstl
```

CMake では「submodule が init 済み」と「submodule が未取得だが sibling repo `../zstl` がある」の双方をサポート、後者はローカルで mini-cocos と zstl を同時開発時に便利：

```cmake
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/zstl/CMakeLists.txt")
    add_subdirectory(third_party/zstl)
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../zstl/CMakeLists.txt")
    add_subdirectory(../zstl ${CMAKE_BINARY_DIR}/zstl)
endif()
target_link_libraries(zocos PUBLIC zstl::zstl)
```

zstl は INTERFACE library —— 全 header-only テンプレート、.lib を生成しない。

## 3. 踩んだ穴：clangd は MSVC PCH を認知しない

機械的書き換え後、MSVC ビルドは通る、Vulkan/OpenGL も動く。だが VS Code を開くと clangd が全画面赤くなる：

```
use of undeclared identifier 'mstd'
```

原因：**clangd は MSVC の `/Yc` プリコンパイルヘッダを消費しない**。各ファイルをスキャンする時、ファイル内の明示的 `#include` だけを見る。あの mechanical rewrite スクリプトは「`<vector>` を include していれば置換」、5 ファイルが STL 導入経路（間接 include、または非標準的な `<vector.h>`）の都合で置換正規表現にマッチせず、`#include "base/ZCStd.h"` を持たないまま `mstd::` を使う状態に。

修正（[`d98b2b7`](https://github.com/leafvmaple/mini-cocos/commit/d98b2b7)）：もう 1 本スクリプト `tools/ensure_zcstd_include.ps1` を書き、全ファイルを走査、`mstd::` を使っているが `ZCStd.h` を include していない者には `#pragma once` の直後（ヘッダ）またはファイル先頭（.cpp）に挿入。

教訓：**PCH はビルド期の最適化、意味論的保証ではない**。PCH 依存でしかコンパイルできないコードは本質的に IDE 非親和。ルールは「include は明示」、PCH が決めるのは「再パースの要否」のみ。

## 4. zstl が実際にカバーすべきは？

`ZCStd.h` の `#else` 分岐は使った全 STL ヘッダの一覧 = zstl が提供する最小集合：

| 型 / 関数 | 出現頻度 | zstl カバー |
|---|---|---|
| `vector` | 極高 | ✅ |
| `string` | 極高 | ✅ |
| `unordered_map` | 高（cache 類） | ✅ |
| `set` | 中（重複除去） | ✅ |
| `array` | 中（小固定配列） | ✅ |
| `pair`, `move`, `forward`, `swap` | 極高 | ✅ |
| `min`, `max`, `clamp` | 高 | ✅ |
| `sort`, `stable_sort` | 中（レンダリングソート） | ✅ |
| `find`, `find_if`, `remove`, `remove_if` | 中 | ✅ |
| `hash`, `less`, `equal_to` | 中 | ✅ |
| `function` | 中（callback） | ✅ |
| `unique_ptr`, `make_unique` | 中 | ✅ |
| `size_t`, `numeric_limits`, `nothrow` | 高 | ✅ |
| `to_string` | 低（debug） | ✅ |

無いもの：`shared_ptr`、`map`（赤黒木が要る）、`deque`、`thread`、`mutex`、`chrono`、`filesystem`、`regex`、`iostream`。mini-cocos が使わないか、freestanding 化を明示的に放棄したか。

> このリスト自体が設計の成果物 —— 「このエンジンの最小 STL 依存」を私（と OS 側）に教える。古い問い「自分のエンジンに必要な runtime はどのくらいか」がこの表で正確に量化された。

## 5. ABI 隔離：テンプレートは header-only、例外があれば一旦立ち止まる

zstl が header-only テンプレートなのは意図的：

- テンプレート実体化はエンジン側で完了、zstl からビルドされた `.a` に依存しない。エンジンがコンパイラ／C++ 標準を変えても zstl の ABI と衝突しない。
- 「zstl がバイナリ実装を提供せざるを得ない」もの（最終的に syscall に行く allocator など）は `extern "C"` フックで露出、宿主層（OS / app）が注入：

```cpp
// zstl/allocator.h
extern "C" {
    void* z_malloc(size_t n) noexcept;     // 宿主が提供
    void  z_free(void* p) noexcept;
}
```

hosted ビルドでは z_malloc は `::operator new` に流す、freestanding ビルドでは OS 自身の物理ページアロケータに流す。エンジン本体は完全に無自覚。

> ある要素が header-only にできないと分かったら、一度立ち止まる —— 9 割は API 設計をもう一段切る必要がある。

## 6. なぜ EASTL / mio / abseil を直接使わない

検討した数案：

- **EASTL**：品質高く std 寄りの API、だがコード 6 万行 +、ビルド依存だけで mini-cocos 自身より大きい。OS 路線は「ちょうど足りる」を明確化。
- **abseil**：Google 製、だが目標は「std の拡張」であって「std の代替」ではない、host runtime 依存が深く freestanding 不適。
- **STL を手書きで mini-cocos 内に内製（zstl を分けない）**：最もクリーン、だが**再利用すべきものを全てコピーする羽目に**。zstl を切り出した後、将来他プロジェクト（自作 OS 自身のカーネルユーティリティライブラリ含む）も直接 link 可能。

zstl 路線は「再利用最大化、依存最小化」の折衷。

## 7. まとめ：スイッチ 1 個で一夜にエンジンを引越し

今回の改造の形：

```
src/base/ZCStd.h               ─┐
                                │  唯一の別名アンカー
src/**/*.{h,cpp}                │
  - #include "base/ZCStd.h"     │  明示 include
  - mstd::vector<...>           │  あちこちで別名
  - mstd::string                │
                                ├─ -DZOCOS_USE_SYS_STL ─→ namespace mstd = sys
                                │
                                └─ 既定             ─→ namespace mstd = std

third_party/zstl/               ─→ header-only sys::* 実装
tools/refactor_to_mstd.ps1      ─→ 機械改写スクリプト（再実行可）
tools/ensure_zcstd_include.ps1  ─→ 漏れ補い（clangd 親和）
```

「将来自作 OS に組み込める」だけが利得ではない。**即時に見える** 利得：

- エンジン全体で使用している STL 要素が、50 行のヘッダ 1 つで読み切れる。
- どの STL 呼出も実装を差し替えたい（unordered_map を robin_hood に等）なら、1 ファイル改修でエンジン全域に反映。
- 「どの STL を使ったか」の監査、license check、freestanding 評価が `mstd::` の grep で完了。

> **抽象レイヤの最大価値は、しばしば「将来差し替えできる」ではなく「今、自分が何を使っているか見えるようになる」**。
>
> 自作 OS にエンジンを乗せるところまで実際にはやっていない（OS 側は page allocator を書いている最中）。だが「これを完遂させた」 —— `std::` の用法を可算な別名に集約させた —— だけで元は取れた。

## 8. イテレーション記録

<!-- mstd / zstl の今後の進化をここに追記。zstl コンテナ追加、freestanding の実落とし、allocator hook インターフェイス拡張など。 -->

- 2026-05-22：パッチ [`d98b2b7`](https://github.com/leafvmaple/mini-cocos/commit/d98b2b7) —— 機械改写が漏らした 5 ファイルに明示的に `#include "base/ZCStd.h"` を補填、`tools/ensure_zcstd_include.ps1` を新設して再発防止。教訓：clangd は MSVC PCH を消費しない、include は全て明示すべし。
- 2026-05-22：初版 [`be88a31`](https://github.com/leafvmaple/mini-cocos/commit/be88a31) —— `mstd::` 別名 + `third_party/zstl` サブモジュール + PCH 連結を導入；50+ エンジンファイルを機械改写。

---

*リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本記事は [mini-cocos シリーズ](https://github.com/leafvmaple/blog/issues/2) の一篇；[#3 3 つのメモリモデル](https://github.com/leafvmaple/blog/issues/3) と強く関連 —— 本稿は「標準ライブラリ依存」の縫い目を切り、#3 は「オブジェクトライフタイム」の縫い目を切っている。*
