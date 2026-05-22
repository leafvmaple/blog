# BIOS から三アーキテクチャカーネルまで：Zonix OS の設計振り返り

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> コミット期間：2026-01-28 → 2026-05-22、91 コミット、現在 v0.11.x "Genesis"
> 規模：~24,000 行の C++17 freestanding + アセンブリ、Clang/LLD/LLVM ツールチェーン、**x86_64 / aarch64 / riscv64 の三アーキテクチャ**
> 機能：BIOS + UEFI デュアルブート、4 レベルページテーブル + ページフォルト + swap、プリエンプティブ優先度スケジューラ、fork/exit/wait プロセスライフサイクル、Spinlock/WaitQueue/Semaphore/Mutex、VFS + FAT32 読み書き、AHCI/IDE/PCI ドライバ、**ユーザーモード ELF 実行 + システムコール**

この記事は Zonix OS の**メインインデックス**です。以前書いた [mini-cocos シリーズ](https://github.com/leafvmaple/blog/issues/2) と同様、各サブシステムの詳細は独立記事に分割し（末尾の「シリーズ記事」参照）、ここではカーネル全体を貫く骨格と、全体に効いている工学的判断だけを残します。

mini-cocos が「他人が代わりにやってくれた取捨選択を、自分でもう一度やる」訓練だったとすれば、Zonix は別種の訓練です。**libc も std も、フォールバックしてくれる OS も無い**ところで、すべての抽象を「CPU 起動後の最初の 1 命令」から育てなければならない。エンジンがクラッシュすれば 1 フレーム黒画面ですが、カーネルがクラッシュすれば triple fault で再起動し、ログ 1 行すら残らないこともある。この環境が強いる工学的規律は、アプリ層とは桁が違います。

## 目次

- [0. なぜゼロからカーネルを書くのか](#sec-0)
- [1. 最初の決断：カーネルコアはアーキテクチャ非依存でなければならない (`dbaa726`)](#sec-1)
- [2. 二つ目の決断：初期化順序はコードではなくデータ (`6ae17b5`)](#sec-2)
- [3. 三つ目の決断：カーネルにも現代的な C++ のエラー処理を (`ff916fa`)](#sec-3)
- [4. シリーズ記事](#sec-4)
- [5. 振り返り：三アーキテクチャ + 24k 行で何を学んだか](#sec-5)

---

<a id="sec-0"></a>
## 0. なぜゼロからカーネルを書くのか

私はゲーム業界で Gameplay / エンジンを 10 年やってきましたが、普段ハードウェアに最も近い場所でも RHI 層止まりです。その下 —— ページテーブル、コンテキストスイッチ、割り込みベクタ、DMA —— は私にとってずっと「概念は知っているが自分で書いたことのない」ブラックボックスでした。*Understanding the Linux Kernel* を読む、xv6 を読む、OSDev wiki を読む。それと、**自分で（仮想）マシンを電源投入から shell プロンプトまで走らせる**ことは、まったく別種の理解です。

なので Zonix の目標は最初から「使える OS を作る」ことではなく、カーネルの最も古典的な機構 —— ブート、仮想メモリ、スケジューリング、同期、ファイルシステム —— を**実機相当のハードウェア抽象（QEMU + OVMF/EDK2）**の上で一つずつ育て、しかも**そのどれもが複数の CPU アーキテクチャで動く**ようにすることでした。最後の制約が肝です。単一アーキテクチャのカーネルは、「汎用に見えて実は全部 x86 前提」のコードを簡単に量産してしまう。**二つ目のアーキテクチャこそが抽象の唯一の検証手段**であり、これは mini-cocos の「OpenGL → Vulkan を経て初めて RHI 抽象が成立した」のと同じ教訓です。

Zonix は今、**x86_64（BIOS + UEFI 両経路）、aarch64（QEMU virt UEFI）、riscv64** の三命令セットで同一のカーネルコアにブートし、同じスケジューラ・同じページテーブルロジック・同じ shell を走らせます。これを支える最重要の判断が以下の三つです。

---

<a id="sec-1"></a>
## 1. 最初の決断：カーネルコアはアーキテクチャ非依存でなければならない (`dbaa726`)

`kernel/` ディレクトリ全体（スケジューラ、メモリ、ファイルシステム、同期、shell）には、**`inb`、`lcr3`、`sti` を 1 行たりとも書いてはならない**。ハードウェアに触れる動作はすべて一群の `arch_*()` 関数の背後に収束させます。

```cpp
// arch/x86/include/asm/arch.h — 各アーキテクチャが実装を 1 つ提供する
static inline void     arch_load_cr3(uintptr_t cr3);   // x86: mov %rax,%cr3 / aarch64: msr ttbr0_el1
static inline uint64_t arch_irq_save(void);            // 割り込みを保存して無効化、旧状態を返す
static inline void     arch_irq_restore(uint64_t f);   // 割り込み状態を復元
static inline void     arch_spin_hint(void);           // x86: pause / aarch64: yield
void                   arch_switch_rsp0(uintptr_t sp); // カーネルスタックポインタ切替 (x86 は TSS)
void                   arch_setup_kthread_tf(TrapFrame*, ...);  // カーネルスレッドの初期トラップフレーム構築
```

スケジューラの `arch_load_cr3(next_cr3)` という 1 行は、x86 では CR3 書き込み、aarch64 では `TTBR0_EL1`、riscv64 では `satp` への書き込みになります —— **スケジューラは一切それを知らなくてよい**。これが [#15 マルチアーキテクチャ抽象](https://github.com/leafvmaple/blog/issues/15) で扱う継ぎ目です。

> 教訓：HAL（ハードウェア抽象層）は「見た目のため」のラッパーではなく、**アーキテクチャ前提を明示的に書き出すことを強制する**ツールです。`kernel/` に裸の `inb` が出た瞬間、汎用コードに x86 の地雷をこっそり埋めたことになり、二つ目のアーキテクチャ移植時に初めて爆発する。`dbaa726` はその地雷をすべて前倒しで爆発させた一手です。

この決断の見返りは `2422311`（riscv64 port）の日に回収されました。三つ目のアーキテクチャ追加時、`kernel/` コアはほぼ無変更で、作業は `arch/riscv64/` の `arch_*()` 実装とブートアセンブリに集中しました。

---

<a id="sec-2"></a>
## 2. 二つ目の決断：初期化順序はコードではなくデータ (`6ae17b5`)

カーネル起動は厳密な依存関係を持つ長い手順の連鎖です。割り込みコントローラは割り込み有効化の前に、ページアロケータは仮想メモリの前に、ブロックデバイスは swap の前に、スケジューラは最後に。最も素朴な書き方は `kern_init()` で `xxx_init()` を一行ずつ呼ぶことですが、それでは**順序・エラー処理・ログがすべて制御フローにハードコードされ**、しかも早期手順はアーキテクチャごとに異なります（x86 は i8259/i8253 が要るが aarch64 は要らない）。

Zonix は初期化を**テーブル**にしました。

```cpp
struct InitStep {
    const char* name;
    int (*fn)();
    bool        required;   // 失敗時に halt するか、降格して続行するか
};

static const InitStep KERN_STEPS[] = {
    {"early_init", early_init, true},   // アーキテクチャ依存の手順（下記）
    {"pmm",        pmm::init,  true},
    {"vmm",        vmm::init,  true},
    {"vfs",        vfs::init,  true},
    {"pci_init",   pci::init,  false},  // PCI が無くても動く
    {"blk",        blk::init,  true},
    {"swap",       swap::init, false},  // swap デバイスが無ければ無効化
    {"sched",      sched::init,true},
};
```

そして**アーキテクチャ依存の早期手順は各アーキテクチャが自前のサブテーブルを提供**し、メイン側は `arch_early_steps()` でそれを受け取ります。

```cpp
// arch/x86/kernel/arch_init.cpp
const InitStep ARCH_STEPS[] = {
    {"i8259", i8259::init, true},   // 8259 PIC —— aarch64/riscv64 のテーブルにこの行は存在しない
    {"i8253", i8253::init, true},
    {"idt",   idt::init,   true},
    {"tss",   tss::init,   true},
};
```

`run_steps()` が一括で走査し、整列した `[OK]`/`[FAIL]` を出力、`required` の失敗は `arch_halt()`、非必須の失敗は降格して続行します。**サブシステム追加 = テーブルに 1 行**。順序は一目瞭然、エラー処理は一箇所、各アーキの差分は自分のサブテーブルに閉じ込められる。

> 教訓：「順序があり、依存があり、エラーを統一処理したい」一連の流れは、**制御フローではなくデータとして表現することを優先せよ**。これは mini-cocos でレンダリングキューに 64-bit sortKey を使い、Action に正規化時間 `t` を使ったのと同じ趣味 —— 「方針」を「機構」から絞り出すことです。

---

<a id="sec-3"></a>
## 3. 三つ目の決断：カーネルにも現代的な C++ のエラー処理を (`ff916fa` → `b1ea334`)

カーネル初期は Linux 風の `int` 戻り値（0 で成功、負で errno）を使っていました。問題は**型安全が無い**こと。関数の戻り値は「エラーコード」なのか「個数」なのか「fd」なのか —— コメントと記憶頼みです。`if (ret)` を `if (!ret)` と書き間違えてもコンパイラは何も言わない。

`ff916fa` で `Result<T>` + `Error` enum + `TRY` マクロを導入し、`b1ea334` で全カーネルの `int` 戻り値を移行しました。

```cpp
enum class Error : int { None = 0, IO = -1, NoMem = -2, NotFound = -4, /* ... */ };

template<typename T>
class [[nodiscard]] Result {        // [[nodiscard]] —— チェック忘れはコンパイル警告
    T     val_{};
    Error err_{Error::None};
    bool  ok_{false};
public:
    Result(const T& v) : val_(v), ok_(true) {}   // 成功：T から暗黙構築
    Result(Error e)    : err_(e)  {}              // 失敗：Error から暗黙構築
    bool  ok() const;
    T&    value();
    Error error() const;
};
```

対になる `TRY` マクロは GCC/Clang の文式（statement expression）で Rust の `?` 風の早期 return を実現します。

```cpp
#define TRY(expr) __extension__({                   \
    auto _r = ::detail::wrap_tryable(expr);         \
    if (!_r.ok()) [[unlikely]] return _r.release_error();  \
    _r.release_value();                             \
})

// 使い方：
Result<int> fd = TRY(files.alloc(file));   // エラーなら即 return、成功なら int を取得
```

`wrap_tryable` のオーバーロードにより、`TRY` は `Result<T>`（`T` を取り出す）と裸の `Error`（値なし、純粋に伝播）の両方を受けます。詳細・なぜ C++ 例外を使わないか（freestanding には unwinding ランタイムが無く `-fno-exceptions`）・カーネルにおける `[[nodiscard]]` の価値は [#17 freestanding C++ カーネル](https://github.com/leafvmaple/blog/issues/17) で扱います。

> 教訓：**「カーネル = 裸の C スタイルでなければならない」は時代遅れの迷信**です。freestanding では `std::` は使えませんが、テンプレート・RAII・`[[nodiscard]]`・constexpr は使えます。これらのゼロコスト抽象はカーネルでこそアプリ層より価値が高い —— 未チェックのエラーコード 1 つが silent なデータ破損になり得るからです。

---

<a id="sec-4"></a>
## 4. シリーズ記事

カーネルで最も技術的に濃いサブシステムをそれぞれ独立記事に展開しました。まずこの骨格記事を読み、興味に応じて任意の記事へ。互いに参照し合いますが、各記事は独立して読めます。

| # | テーマ | 一言で |
|---|---|---|
| [#12](https://github.com/leafvmaple/blog/issues/12) | コンテキストスイッチ + プリエンプティブスケジューリング | Clang の epilogue が暴き、GCC の `leave;ret` が数ヶ月隠していた `switch_to` の RSP off-by-8 バグ。そして forkret/trapret のスタックフレーム偽造術 |
| [#13](https://github.com/leafvmaple/blog/issues/13) | 仮想メモリ + ページフォルト + swap | PTE の present ビットで「未マップ / スワップアウト済み」を区別し、スワップ済みページ番号を PTE に直接エンコード。FIFO 置換 + ページテーブル逆走査で victim の仮想アドレスを探す |
| [#14](https://github.com/leafvmaple/blog/issues/14) | ブートチェーン + boot_info 統一プロトコル | MBR→VBR→bootloader→long mode のリレー、BIOS/UEFI 両経路を同一の `BootInfo` に収束。`head.S` の恒等マップ + 高位半デュアルマップによる「ページテーブルとスタックの同時切替」魔術 |
| [#15](https://github.com/leafvmaple/blog/issues/15) | マルチアーキテクチャ抽象 | `arch_*()` HAL、テーブル駆動 init、`asm/` include 名前空間。同一の `kernel/` を x86_64 / aarch64 / riscv64 で走らせる |
| [#16](https://github.com/leafvmaple/blog/issues/16) | 同期プリミティブのスタック | Spinlock（割り込み無効化 + TAS）→ WaitQueue（侵入型リスト）→ Semaphore / Mutex。単一コアカーネルでなぜ spinlock が要るか、lost-wakeup の防止 |
| [#17](https://github.com/leafvmaple/blog/issues/17) | freestanding C++ カーネル | グローバル `new`/`delete` を kmalloc へ、`.init_array` でグローバルコンストラクタ実行、`cxxrt` ランタイムスタブ、`Result<T>`/`TRY`、GCC→Clang/LLD ツールチェーン移行 |
| [#18](https://github.com/leafvmaple/blog/issues/18) | ユーザーモード ELF 実行 + システムコール | 信頼できない ELF を ring 3 へ：ユーザーアドレス空間（高位半カーネルマッピング共有）、ELF ロードの二本の安全線、#12 の `trapret` を再利用し `iretq` で降格、syscall ABI 唯一の真実源、「ユーザーポインタを決して信じない」信頼境界 |

---

<a id="sec-5"></a>
## 5. 振り返り：三アーキテクチャ + 24k 行で何を学んだか

1. **二つ目のアーキテクチャが抽象の唯一の審判**。単一アーキテクチャでの「汎用」は自己満足に過ぎない。aarch64、続いて riscv64 が実際に動いて初めて、何が真の継ぎ目で、何が継ぎ目を装った x86 前提かが分かる（→ [#15](https://github.com/leafvmaple/blog/issues/15)）。
2. **最も難しいバグは自分のロジックではなく、ツールチェーンの前提に潜む**。`switch_to` の RSP off-by-8 は GCC の `leave;ret` に完璧に隠され、Clang に替えた途端 triple fault。**コンパイラを替えるのは無料の fuzzing**（→ [#12](https://github.com/leafvmaple/blog/issues/12)）。
3. **PTE は「アドレス + 権限ビット」より汎用なデータ構造**。present=0 のとき、残り 63 ビットは何でも入れられる —— Zonix はそこにスワップ済みページ番号を入れ、swap に逆引きテーブルが一切不要になった（→ [#13](https://github.com/leafvmaple/blog/issues/13)）。
4. **「ページテーブルとスタックを同時に切り替える」のがブート期で最も直感に反する一歩**。CR3 を書いた瞬間、旧スタックの仮想アドレスが即座に無効化され得るので、まずスタックを新旧両方のページテーブルがマップする低位アドレスへ移す必要がある。これは UEFI 経路で特に致命的（→ [#14](https://github.com/leafvmaple/blog/issues/14)）。
5. **単一コアでも spinlock は要る**。マルチコア排他のためではなく、**割り込みハンドラ**との排他のため —— spinlock は acquire 時に割り込みを無効化する、本質的に「割り込み無効化 + 占有」の複合プリミティブ（→ [#16](https://github.com/leafvmaple/blog/issues/16)）。
6. **freestanding は C への後退ではない**。RAII で割り込み状態を守る（`intr::Guard`）、`Result<T>` でエラーを伝播、テンプレート化した `LockGuard<T>` —— これらの抽象はカーネルでこそ負担が軽く見返りが大きい（→ [#17](https://github.com/leafvmaple/blog/issues/17)）。

研究室の外に出ないカーネルを書くのは、プロダクト視点では何の成果もありません。しかしそれは、ずっとブラックボックスとして使ってきた「オペレーティングシステム」を、**アセンブリ層の一命令まで自分で責任を負う**粒度まで分解させてくれます。この「1 バイトずつに責任を負う」訓練は、アプリ層コードを 10 年書いても得られないものです。

> **2026-05 更新**：前版ここに「本物のユーザーモード ELF を走らせる試み」と書いた —— 今やそれが実現した。`exec` サブシステムはディスク上の信頼できない ELF を隔離アドレス空間へ招き、ring 3 へ降格して走らせ、システムコールでカーネルへ戻れる（→ 新規記事 [#18](https://github.com/leafvmaple/blog/issues/18)）。併せて**自作 C コンパイラ zcc**（[独立リポジトリ](https://github.com/leafvmaple/zcc)、サブモジュール）を統合しユーザープログラムをコンパイル —— カーネル + コンパイラで「自作コンパイラが自作カーネル上で走るプログラムをコンパイルする」雛形のブートストラップ鎖を構成する。

次にやる予定：スケジューラを協調的からタイマプリエンプション全経路の検証へ、riscv64 に割り込みコントローラ（PLIC）を補完、そして zcc により完全な C サブセットを補完。やり終えたら次を書きます。

---

## 更新履歴

<!-- 本記事はインデックス + メタ経験の記事であり、具体的サブシステムの結論は蓄積しない。
     サブシステム単位の進化は各記事へ。横断的な構造変更（アーキ追加、init 変更）はここに 1 行索引。 -->

- 2026-05-22：直交する新サブシステム **ユーザーモード ELF 実行 + システムコール** を追加、記事 [#18](https://github.com/leafvmaple/blog/issues/18) を起こす。「カーネルスレッドのみ」から「信頼できないユーザープロセスを走らせる」への質的転換（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) exec、[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) syscall ABI、[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) zcc コンパイラサブモジュール統合）。[#12](https://github.com/leafvmaple/blog/issues/12) が当初カーネルスレッドのために引いた `arch_setup_user_tf` / `trapret` 継ぎ目を実現 —— ユーザーモード追加時この経路は一行も変わらなかった。
- 2026-04-07：[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311) で **riscv64** という三つ目のアーキテクチャを追加、[`5b32167`](https://github.com/leafvmaple/zonix-plus/commit/5b32167) でボード抽象を補完。[#15](https://github.com/leafvmaple/blog/issues/15) で述べる HAL 継ぎ目のさらなる検証であり、`kernel/` コアはほぼ無変更。
- 2026-04-07：[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa) / [`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) で全カーネルのエラー処理を `int` 戻り値から `Result<T>` + `TRY` へ移行（§3 と [#17](https://github.com/leafvmaple/blog/issues/17) 参照）。横断的変更であり、各サブシステムへの影響は各記事の更新履歴に記す。

---

*本記事は [leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus) の設計思考の記録です。あなたも自作カーネルを書いているなら、あるいはある取捨選択に違う見解があるなら、ぜひリポジトリの Issue で。*
