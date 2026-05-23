# freestanding は C への後退ではない：カーネルでも RAII と `Result<T>` は動く

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`kernel/cxxrt.cpp` / `kernel/init.cpp` / `lib/result.h` / `lib/memory.h` / ツールチェーン

Zonix のカーネル全体は C++17 freestanding —— `-ffreestanding -fno-exceptions -fno-rtti -nostdinc -nostdinc++`、libc も STL も例外も RTTI も無いが、テンプレート、RAII、`constexpr`、`[[nodiscard]]`、名前空間は一つも欠けていない。欠けたランタイムを補う代償は `kernel/cxxrt.cpp` の 94 行のみ：6 つの C 関数（`memset` / `memcpy` / `memmove` / `memcmp` / `__cxa_pure_virtual` / `atexit`）+ 8 つの `operator new`/`delete` オーバーロード。本記事ではこの 94 行で何故十分かを述べる —— そしてなぜこれらゼロコスト抽象がカーネルでこそアプリ層より価値が高いかも。

---

## 1. freestanding は何を欠くのか

`-ffreestanding` はコンパイラに「対象環境に標準ライブラリの庇護は無い」と告げます。具体的に欠けるのは：

- **`std::` が無い**：`std::vector`、`std::string`、`std::unordered_map` が無い。コンテナは自作（Zonix は `Array<T,N>`、侵入型 `ListNode` を持つ）。
- **`operator new`/`delete` のデフォルト実装が無い**：`new Foo` という式はコンパイラが認めるが、生成される `operator new` 呼び出しを誰も提供しない —— リンク時 undefined reference。
- **例外と RTTI が無い**：`-fno-exceptions -fno-rtti`。スタック巻き戻し（unwinding）ランタイムが無く `throw` の行き先が無い；`dynamic_cast`/`typeid` も無い。
- **グローバルコンストラクタの自動呼び出しが無い**：`static SchedulerPolicy policy;` のようなコンストラクタ付きグローバルオブジェクトのコンストラクタは**自動で走らない** —— hosted 環境では C ランタイム（crt0）が走らせる、freestanding に crt0 は無い。
- **`memcpy`/`memset` 等の C ライブラリ関数が無い** —— なのにコンパイラは**自らそれらの呼び出しを生成する**（構造体代入、配列ゼロ化時）。

後半三つが最も隠れた罠です：それらは「使いたいが無い」のではなく「**コンパイラが存在を仮定して呼び出しを挿入したが、実は誰も実装していない**」。これらを補うのが、カーネルで C++ を「生き返らせる」鍵です。

---

## 2. ランタイムを補う（一）：グローバル `new`/`delete` を kmalloc へ繋ぐ

`kernel/cxxrt.cpp` は `operator new`/`delete` の全套をカーネルヒープ `kmalloc`/`kfree` へ繋ぎます。

```cpp
void* operator new(__SIZE_TYPE__ size, const std::nothrow_t&) noexcept { return kmalloc(size); }
void* operator new(__SIZE_TYPE__ size)                                 { return operator new(size, std::nothrow); }
void* operator new[](__SIZE_TYPE__ size)                               { return operator new[](size, std::nothrow); }

void  operator delete(void* p) noexcept              { kfree(p); }
void  operator delete(void* p, __SIZE_TYPE__) noexcept { kfree(p); }   // C++14 sized delete
void  operator delete[](void* p) noexcept            { kfree(p); }
```

いくつかの細部：

- **通常 `new` は nothrow 版へ転送**。hosted では `new` 失敗で `std::bad_alloc` を投げるが、我々は `-fno-exceptions`、投げられない。だから通常 `new` を直接 nothrow 経路へ流し、失敗で `nullptr` を返し、呼び出し側がチェックする（カーネルには至る所に `if (!p) return Error::NoMem;`、[#11](https://github.com/leafvmaple/blog/issues/11) の `Result<T>` と連携）。
- **sized delete**（`operator delete(void*, size_t)`）は必須。C++14 以降コンパイラは size 付き delete 呼び出しを生成し得る、一つ欠けてもリンクエラー。
- **non-inline で `.cpp` に定義せねばならない。** これはツールチェーン移行が炙り出した教訓 —— Clang の `-Winline-new-delete` は inline な `new`/`delete` に警告する。最初これらの定義は `memory.h` ヘッダ（暗黙 inline）にあり、Clang に替えた途端警告、よって `cxxrt.cpp` へ移し唯一の non-inline 定義にした。

繋いだ後、カーネルで普通に `new TaskStruct()`、`delete proc` ができ、`Result<T>`、`LockGuard<T>` 等のテンプレートが new すべきを new し delete すべきを delete し、hosted C++ とほぼ変わらず書ける。

---

## 3. ランタイムを補う（二）：コンパイラがこっそり要求する `memcpy` と純粋仮想スタブ

`-fno-builtin` でも、Clang は構造体代入・配列初期化のために `memset`/`memcpy` 呼び出しを生成し、これらシンボルへのリンクを期待し得る。さらに `__cxa_pure_virtual`（純粋仮想関数が呼ばれた際のフォールバック）、`atexit`（グローバルデストラクタ登録）。すべて自前で提供せねばならない。

```cpp
extern "C" {
void* memset(void* s, int c, size_t n) { return arch_memset(s, c, n); }   // アーキ最適実装へ転送
void* memcpy(void* d, const void* s, size_t n) { return arch_memcpy(d, s, n); }
void* memmove(void* d, const void* s, size_t n) { /* 重複を処理 */ }
int   memcmp(const void*, const void*, size_t);

void __cxa_pure_virtual() { arch_halt_forever(); }   // 純粋仮想が呼ばれた = 重大バグ、見えるよう停止
int  atexit(void (*)()) { return 0; }                // カーネルは決して終わらない → グローバルデストラクタは走らない → 空実装
}
```

`memset`/`memcpy` は [#15](https://github.com/leafvmaple/blog/issues/15) で述べたアーキ最適 `arch_memset`/`arch_memcpy`（x86 では `rep stosq`/`rep movsq`）へ転送。`atexit` は 0 を返すだけ —— カーネルは起動後決して return せず、グローバルオブジェクトのデストラクタは決して走らない、よって登録は純粋な無駄、空実装が最も正直。`__cxa_pure_virtual` は静黙ではなく停止 —— 純粋仮想が呼ばれたのはオブジェクトが構築/破棄期に誤って多態呼び出しされた証拠、暴かねばならないバグ。

> この節のメタ教訓：**freestanding は「C++ の機能を控えめに使う」ではなく「ホスト環境が代わりにやってくれるわずかなランタイム下支えを、自分で明示的にやる」。** この薄い `cxxrt` 一層を補えば、その上で完全な C++ オブジェクトモデルが走る —— これこそ「あらゆる抽象の実装コストを自分で負う」訓練です。

---

## 4. ランタイムを補う（三）：`.init_array` グローバルコンストラクタ連鎖を手動で走らせる

コンストラクタ付きグローバルオブジェクト（例：スケジューラポリシー `static SchedulerPolicy policy;`）について、コンパイラはそのコンストラクタポインタを `.init_array` という section に集める。hosted 環境では crt0 がこれを走査して構築する；freestanding では**自分で走らせねばならない**。

```cpp
extern "C" {
using ctor_func = void (*)();
extern ctor_func __init_array_start[];    // リンカスクリプトが提供する境界シンボル
extern ctor_func __init_array_end[];
}

static void cxx_init() {
    for (auto* fn = __init_array_start; fn < __init_array_end; fn++)
        (*fn)();                           // グローバルコンストラクタを逐次呼ぶ
}

extern "C" [[noreturn]] int kern_init(struct BootInfo* bi) {
    if (!bi || bi->magic != BOOT_INFO_MAGIC) arch_halt();
    cxx_init();                            // ★ いかなるグローバルオブジェクト使用の前に呼ぶ必須
    cons::init();
    run_steps(KERN_STEPS, ...);            // その後で [#11] のテーブル駆動初期化
    ...
}
```

`cxx_init()` は `kern_init` 冒頭、いかなるグローバルオブジェクトが使われる前に置かねばならない。漏らすと、コンストラクタ付きグローバルオブジェクトはすべて**未構築のランダムメモリ**になり、症状は千差万別で極めて特定しにくい（コードは完全に正常に見え、ただオブジェクトのフィールドがゴミ値だから）。これは freestanding C++ で最も忘れやすい一歩 —— 「グローバルオブジェクトにコンストラクタを持たせる」便利さを享受したなら、そのコンストラクタを実際に走らせる責任を自分で負う。

---

## 5. 現代的なエラー処理：なぜ例外ではなく `Result<T>` か

freestanding に例外は無い（スタック巻き戻しランタイムが存在しない）が、カーネルこそ厳密なエラー伝播を最も必要とする —— 無視された一つのエラーコードが silent なデータ破損になり得る。Zonix の答えは `Result<T>` + `TRY` マクロ（[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa)、[#11 §3](https://github.com/leafvmaple/blog/issues/11) で概観済み、ここでは機構を述べる）。

```cpp
template<typename T>
class [[nodiscard]] Result {       // [[nodiscard]]：戻り値無視 → コンパイル警告
    T val_{}; Error err_{Error::None}; bool ok_{false};
public:
    Result(const T& v) : val_(v), ok_(true) {}   // 成功：T から暗黙構築
    Result(Error e)    : err_(e) {}               // 失敗：Error から暗黙構築
    bool ok() const; T& value(); Error error() const;
    T release_value(); Error release_error();
};

template<> class [[nodiscard]] Result<void> {     // Result<void> 特殊化：成否のみ伝播、値なし
    Error err_{Error::None};
public:
    Result() {} Result(Error e) : err_(e) {}
    bool ok() const { return err_ == Error::None; }
};
```

`TRY` マクロは GCC/Clang の**文式**（statement expression、`({ ... })` という評価可能な文ブロック）で Rust の `?` 風の早期 return を実現します。

```cpp
#define TRY(expr) __extension__({                       \
    auto _r = ::detail::wrap_tryable(expr);             \
    if (!_r.ok()) [[unlikely]] return _r.release_error();   \
    _r.release_value();                                 \
})
```

`wrap_tryable` はオーバーロードにより、`TRY` が**`Result<T>` を受け**（`T` を取り出す）**かつ裸の `Error` を受ける**（値なしの `ErrorResult` に包み、純粋に伝播）。

```cpp
inline ErrorResult wrap_tryable(Error e);            // 裸 Error → TRY 可能なラッパー
template<typename T> Result<T> wrap_tryable(Result<T> r);   // Result<T> はそのまま

auto fd   = TRY(files.alloc(file));   // alloc は Result<int> を返す、エラーなら return、成功で int 取得
TRY(swap_device->read(sector, kva, n)); // read は Error を返す、エラーなら return、成功で値なし
```

付随して `TRY_LOG`（伝播前にログを 1 行）、`ENSURE(cond, err)`（条件不成立でエラー返却、assert に似るがクラッシュしない）もある。`ENSURE` は後に**可変引数オーバーロード**もした（[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）—— `_ENSURE_SELECT(_1, _2, NAME, ...)` という古典的な「引数個数でディスパッチ」マクロ技で、`ENSURE(cond)` がデフォルトで `Error::Invalid` を返し、`ENSURE(cond, err)` が指定エラーコードを保つ：

```cpp
#define _ENSURE1(cond)      do { if (!(cond)) [[unlikely]] return Error::Invalid; } while (0)
#define _ENSURE2(cond, err) do { if (!(cond)) [[unlikely]] return (err);          } while (0)
#define _ENSURE_SELECT(_1, _2, NAME, ...) NAME
#define ENSURE(...) _ENSURE_SELECT(__VA_ARGS__, _ENSURE2, _ENSURE1)(__VA_ARGS__)
```

こうして「引数不正なら Invalid を返す」検査の大半が `ENSURE(ptr)` だけで済み、特定エラーコードが要る少数は `ENSURE(cond, Error::NoMem)` と書く —— `exec`/FAT ドライバの一巡（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)）はこれで大量の `if (!x) return ...` を一行に畳んだ。機構全体が**純粋にコンパイル時 + 実行時コストゼロ** —— 例外テーブルもスタック巻き戻しも無く、展開後は数個の `if + return` だが、書く分には例外に似た「エラーが自動的に泡立つ」体験があり、しかも例外より明示的で制御可能。

> 立場：**例外は freestanding カーネルで使えない（ランタイムが無い）し使うべきでない（予測不能な巻き戻し経路、隠れた制御フロー）。** だが「例外を使わない」は「C の `if (ret < 0) goto fail` へ後退」を意味しない。`Result<T>` + `TRY` はテンプレートとマクロで、ゼロコストの前提で型安全（`[[nodiscard]]` がチェックを強制）と合成性（`TRY` の連鎖伝播）を取り戻す。freestanding 環境で「現代 C++ の見返りが最大、コストが最小」の一角です。

---

## 6. ツールチェーン：GCC/GNU ld から Clang/LLD/LLVM へ全面移行 (`9fae90c`)

`9fae90c` はカーネル・arch コード・BIOS boot のコンパイル鎖を `gcc`/`g++`/`ld`/`objcopy` から `clang`/`clang++`/`ld.lld`/`llvm-objcopy` へ全面的に替えました。UEFI bootloader はさらに進み（[`1437166`](https://github.com/leafvmaple/zonix-plus/commit/1437166)）、MinGW GCC クロスコンパイルから `clang --target=x86_64-pc-windows-msvc` + `lld-link` へ —— **同一の Clang が ELF カーネルも PE32+ の UEFI アプリも編める**、`--target` を替えるだけで、MinGW ツールチェーン一式を入れる必要がなくなった。

この移行の真の価値は「コンパイラを替える」ことではなく、それが**無料のコード監査のように、潜伏していた問題群を一度に炙り出した**ことです。

- **`switch_to` の RSP off-by-8**：GCC の `leave;ret` epilogue が数ヶ月隠したスタックバグが、Clang の RSP-relative epilogue でその場で triple fault に。プロジェクト中最も劇的なバグで、[#12 §2](https://github.com/leafvmaple/blog/issues/12) で完全に語った。
- **`-Winline-new-delete`**：Clang は inline な `new`/`delete` を嫌い、それらをヘッダから `cxxrt.cpp` へ移すよう迫った（§2 参照）。
- **符号比較警告、RWX segment 警告、欠けた `.note.GNU-stack`**：GCC が黙って通し、Clang/LLD が厳しく咎める小問題の連鎖（[`b69882e`](https://github.com/leafvmaple/zonix-plus/commit/b69882e) で全警告を一掃）。

コンパイラを替えることは、ほぼ無料の fuzzing だ。異なるコンパイラは「未定義/未規定の振る舞い」にまったく異なるが等しく合法な選択をする ——「GCC でたまたま動く」コードは、本質的に標準に書かれていない暗黙の前提に依存している。Clang に替えるのは、別の合法的前提集合で全コードを再検査させること。発見されたものは一つ残らず実在し、いつか爆発する隠れた危険だ。

最後の関連する進化は [`2e809ca`](https://github.com/leafvmaple/zonix-plus/commit/2e809ca)：マクロ群を `inline constexpr`/`inline` 関数へ置換。`#define PAGE_SIZE 4096` を `inline constexpr size_t PAGE_SIZE = 4096;` へ、マクロ関数を inline 関数へ —— 型チェック・スコープ・デバッガ可視性を取り戻し、同時に実行時コストゼロ。これも「freestanding はプリプロセッサ時代へ後退しなくてよい」の脚注：現代 C++ のゼロコスト抽象は、カーネルで使えるし、むしろ使うべきです。

---

## 7. 更新履歴

<!-- C++ runtime / ツールチェーンの今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-05-22：[`dd6ccee`](https://github.com/leafvmaple/zonix-plus/commit/dd6ccee) で ELF 検証を `ElfHdr::is_valid()`/`is_executable()` メンバ関数へ封装 —— 「freestanding でも現代 C++ を使う」の延長（[#18](https://github.com/leafvmaple/blog/issues/18) に関連）。
- 2026-04-08：[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) `ENSURE` に可変引数オーバーロードを追加（単引数はデフォルト `Error::Invalid`、§5 参照）；[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) でそれを使い `exec`/FAT のエラー処理を一括簡素化；[`5f15c72`](https://github.com/leafvmaple/zonix-plus/commit/5f15c72) で一群のブールアクセサに `[[nodiscard]]` を付与。
- 2026-04-07：[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa) `Result<T>` + `Error` + `TRY`/`ENSURE` マクロを導入、[`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) で全カーネルの `int` 戻り値を移行（§5 参照）。
- 2026-03-24：[`1437166`](https://github.com/leafvmaple/zonix-plus/commit/1437166) UEFI を `clang --target=x86_64-pc-windows-msvc` へ。
- 2026-03-12：[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c) ツールチェーンを Clang/LLD/LLVM へ全面移行し `switch_to` バグを暴く（§6 / [#12](https://github.com/leafvmaple/blog/issues/12) 参照）；`cxxrt.cpp` を新設しランタイムスタブ + non-inline な `new`/`delete` を収める（§2/§3 参照）。
- 2026-03-11：[`2e809ca`](https://github.com/leafvmaple/zonix-plus/commit/2e809ca) マクロを `inline constexpr`/inline 関数で置換し、アーキ最適 memops を補う（§6 参照）。
- 2026-03-05：[`b69882e`](https://github.com/leafvmaple/zonix-plus/commit/b69882e) v0.9.0 で全コンパイル/リンク警告を一掃（§6 参照）。
- 2026-03-04：[`7138771`](https://github.com/leafvmaple/zonix-plus/commit/7138771) 各サブシステムを名前空間に封じ、カーネル基礎ライブラリを `lib/` へ整理。

---

*リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本記事は [Zonix OS シリーズ](https://github.com/leafvmaple/blog/issues/11) の一篇。*
