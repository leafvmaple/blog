# Zonix：ゼロから作るマルチ ISA OS カーネル

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> コミット期間：2026-01-28 → 2026-05-22、91 コミット、現在 v0.11.x "Genesis"
> 規模：~24,000 行の C++17 freestanding + アセンブリ、Clang/LLD/LLVM ツールチェーン、**x86_64 / aarch64 / riscv64 の三アーキテクチャ**
> 機能：BIOS + UEFI デュアルブート、4 レベルページテーブル + ページフォルト + swap、プリエンプティブ優先度スケジューラ、fork/exit/wait プロセスライフサイクル、Spinlock/WaitQueue/Semaphore/Mutex、VFS + FAT32 読み書き、AHCI/IDE/PCI ドライバ、**ユーザーモード ELF 実行 + システムコール**

この記事は Zonix OS の**メインインデックス**である。カーネル全体の骨格を貫く三つの工学的判断 —— HAL の継ぎ目、テーブル駆動 init、`Result<T>` エラー処理 —— はそれぞれ §1 / §2 / §3 に。各サブシステムの詳細は独立記事に分割した（§4 シリーズ記事参照）。

本文に入る前に、まずプロジェクトの指標を並べておく。データは 2026-05-22 時点：

| 指標 | 値 | 意味 |
|---|---|---|
| コミット数 | **91** | 期間 2026-01-28 → 2026-05-22 |
| `kernel/` + `include/` の C++ 行数 | **12,794** | アーキテクチャ非依存、三つの ISA で同一のものを共用 |
| `arch/` の C++ + アセンブリ行数 | **10,723** | x86 + aarch64 + riscv64 の三つの並列実装、加えて BIOS + UEFI の独立ローダー二本 |
| `kernel/` における裸の特権命令の出現数 | **0** | 「裸の特権命令」とは `inb` / `outb` / `lcr3` / `sti` / `cli` / `hlt` / `invlpg` / `wbinvd` / `lgdt` / `lidt` 等、直接ハードウェアへアクセスする命令を指す |
| `arch/` における同種命令の出現数 | **51** | 8 ファイルに集中：`head.S` / `io.h` / `arch.h` / `cpu.h` と BIOS boot 四点セット |
| 各アーキテクチャの `arch_*()` HAL 関数数 | **32 / 33 / 34** | x86 / aarch64 / riscv64 各自の `arch/<isa>/include/asm/arch.h` 内 `arch_xxx()` 宣言数、差は ±1 |

特に 2 行は単独で述べておく：

- `kernel/` のその 0 は lint で強制されているのではない —— [`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) 以降、**ハードウェアに触れる動作はすべて `arch/<isa>/include/asm/arch.h` 内のあの `arch_*()` 関数群を通らなければならない**、というシンプルな取り決めで守られている。この規約が 51 個の裸特権命令を `arch/` 内の 8 ファイルへ閉じ込めている。
- 三つのアーキテクチャでの 32/33/34 という近一対一の対称性こそ、この取り決めが本当に成立している物証である。もし漏れた抽象なら、新アーキテクチャの移植時（最近は riscv64 [`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311)）に「x86 にも aarch64 にも存在せず、riscv64 のためだけに生やされた」奇妙な関数が必要になっていたはずだ。実際それは無かった。

下の三つの判断が、この取り決めが単一 x86_64 ポートから三つの ISA まで耐えた理由を説明する。

## 目次

- [0. 設計上の制約](#sec-0)
- [1. 最初の決断：カーネルコアはアーキテクチャ非依存でなければならない (`dbaa726`)](#sec-1)
- [2. 二つ目の決断：初期化順序はコードではなくデータ (`6ae17b5`)](#sec-2)
- [3. 三つ目の決断：カーネルにも現代的な C++ のエラー処理を (`ff916fa`)](#sec-3)
- [4. シリーズ記事](#sec-4)
- [5. 3 つの ISA を実装し終えてなお成立する事実](#sec-5)

---

<a id="sec-0"></a>
## 0. 設計上の制約

Zonix の目標は「使える OS を作ること」ではない。カーネルの最も古典的な機構 —— ブート、仮想メモリ、スケジューリング、同期、ファイルシステム —— を、実機相当のハードウェア抽象（QEMU + OVMF/EDK2）の上で一つずつ育て、しかも**そのどれもが複数の CPU アーキテクチャで動く**ようにすることだ。

最後の制約が肝になる。単一アーキテクチャのカーネルは「汎用に見えて実は全部 x86 前提」のコードを簡単に量産する —— `outb 0x20` を「割り込み完了の通知」と書き、`mov %rax, %cr3` を「アドレス空間切替」と書き、`pause` を「スピン時に CPU へ譲る合図」と書く。この三つは aarch64 では `msr ICC_EOIR1_EL1`、`msr TTBR0_EL1`、`yield` に対応し、riscv64 では `csrw sip`（実体は PLIC の `claim/complete` MMIO 経由）、`csrw satp`、`pause`（Zihintpause 拡張。無ければ nop に退化）に対応する。この種の細部の差は、ハードウェアに触れるあらゆるコードに浸透している。

**二つ目のアーキテクチャこそが抽象の唯一の検証手段**である。下の三つの判断が「同一の `kernel/` を三つの ISA で走らせる」ことを支える最重要の三つの継ぎ目である。

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

スケジューラの `arch_load_cr3(next_cr3)` という 1 行は、x86 では CR3 書き込み、aarch64 では `TTBR0_EL1`、riscv64 では `satp` への書き込みになる —— **スケジューラは一切それを知らなくてよい**。これが [#15 マルチアーキテクチャ抽象](https://github.com/leafvmaple/blog/issues/15) で扱う継ぎ目である。

この決断の見返りは [`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311)（riscv64 port）の日に回収された。三つ目のアーキテクチャ追加時、`kernel/` コアはほぼ無変更で、新規コードは `arch/riscv64/` が提供する 32~34 個の `arch_*()` 実装とブートアセンブリに集中した。

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

`run_steps()` が一括で走査し、整列した `[OK]`/`[FAIL]` を出力、`required` の失敗は `arch_halt()`、非必須の失敗は降格して続行する。**サブシステム追加 = テーブルに 1 行**。順序は一目瞭然、エラー処理は一箇所、各アーキの差分は自分のサブテーブルに閉じ込められる —— このやり方は mini-cocos のレンダリングキューの 64-bit sortKey、Action システムの正規化時間 `t` と同源である：**順序・依存・エラー処理をデータとして表現し、制御フローには書かない**。

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

`wrap_tryable` のオーバーロードにより、`TRY` は `Result<T>`（`T` を取り出す）と裸の `Error`（値なし、純粋に伝播）の両方を受ける。詳細・なぜ C++ 例外を使わないか（freestanding には unwinding ランタイムが無く `-fno-exceptions`）・カーネルにおける `[[nodiscard]]` の価値は [#17 freestanding C++ カーネル](https://github.com/leafvmaple/blog/issues/17) で扱う。

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
| [#20](https://github.com/leafvmaple/blog/issues/20) **(配套ツールチェーン)** | zcc：Zonix で走らせる ELF を吐く C コンパイラ | 3,100 行の C++ で SysY/C0 サブセットフロントエンド + LLVM IR 後段 + 自前 freestanding runtime（`crt0`/`linker.ld`/`libzccrt.a`）、Zonix と 1 枚の `syscall.h` を共有して体系閉環。**zcc は独立リポジトリ、独立サブシリーズ**、記事 #21（ABI 継ぎ目）/#22（LLVM codegen）/#23（C0 進化） |

---

<a id="sec-5"></a>
## 5. 3 つの ISA を実装し終えてなお成立する事実

以下のいくつかをここに置いたのは、**メイン記事の第一版を書いた時点ではまだ推測だったが、ここまで書く間に三つの ISA それぞれによって反例で検証されてきた**ものだからである。

1. **`kernel/` 内の裸特権命令は 0、`arch/` では 51 で 8 ファイルに集中**（`head.S` / `io.h` / `arch.h` / `cpu.h` に BIOS boot 四点セットを加えたもの）。この二つの数字が並んで初めて、HAL の継ぎ目が本当にそこに引かれている物証になる —— lint で強制されているのではなく、毎回のリファクタで自覚的に収束させてきた結果である（詳細は [#15](https://github.com/leafvmaple/blog/issues/15)）。

2. **GCC → Clang は一度の無料の fuzzing**。`switch_to` の RSP off-by-8 は GCC の `leave;ret` epilogue の下で三ヶ月静かにしていたが、[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c) で Clang/LLD/LLVM に切り替えた当夜、即座に triple fault した。同じツールチェーン移行で、未実装の `__cxa_*` スタブ、UEFI loader の RWX セグメント違反、いくつかの `-Winline-new-delete` 警告も同時に露呈した —— 一つのコンパイラがもう一つのコンパイラの暗黙の前提を照らし出した（詳細は [#12](https://github.com/leafvmaple/blog/issues/12) §2 と [#17](https://github.com/leafvmaple/blog/issues/17)）。

3. **swap サブシステムに `<va, swap_slot>` の逆引きテーブルは存在しない**。`kernel/mm/swap.cpp` + `swap_fifo.cpp` は合計 273 行で、その中に「どの仮想アドレスがどのスロットへスワップされたか」を保持する map / array は一つも無い。swap entry とは `(slot << 8)` をそのまま PTE に書き戻したものであり、ハードウェアは present=0 を見て fault を起こし、ソフトウェアは PTE の上位ビットからスロット番号を取り戻す。同種のトリックは Linux の [`include/linux/swapops.h`](https://github.com/torvalds/linux/blob/master/include/linux/swapops.h) でも使われているが、Linux は下位ビットに swap type 用のビットを数個余分に詰めている点だけが違う（詳細は [#13](https://github.com/leafvmaple/blog/issues/13)）。

4. **ページテーブルを切り替えるのと同じ拍でスタックも切り替えなければならない**。CR3 を書いた瞬間、旧スタックの仮想アドレスが新しいページテーブルにマップされていなければ即座に無効化される。BIOS 経路では偶々スタックが物理アドレス低位 1MB にあり新旧両方のページテーブルで恒等マップされているので地雷を踏まないが、UEFI 経路ではスタックがファームウェアから渡された高位アドレスにあるため、CR3 を書く前にデュアルマップ領域へスタックを移しておかないと、次の `push %rbp` で page fault する（詳細は [#14](https://github.com/leafvmaple/blog/issues/14)）。

5. **`Spinlock::acquire` の第一歩は割り込み無効化、第二歩がようやく TAS**。単一コアでは前者だけで十分であり、後者は SMP のために用意した「死んだコード」である。だが呼び出し側 `LockGuard<Spinlock>` の 11 ヶ所のプロダクション利用は、単一コアから多コアへ移しても一字も変える必要が無い —— 変えるのは `Spinlock` 内部の TAS 実装である（詳細は [#16](https://github.com/leafvmaple/blog/issues/16)）。

6. **`Result<T>` + `TRY` のランタイムオーバーヘッドはほぼ 0**。`Result<T>` は `[[nodiscard]]` を付けた POD、`TRY` は lambda ではなくマクロ + 文式、`Error` は `enum class : int`。三つ合わせると：成功経路は裸の `int` に比べてレジスタ読み込みが 1 回（ok フラグ）増え、失敗経路は条件分岐が 1 回増えるだけ。代償として得たのは、[`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) 以前の「`if (ret)` を `if (!ret)` と書き間違える」類の silent エラーコードバグが、コンパイル時に `-Wunused-result` で直接打ち落とされること（詳細は [#17](https://github.com/leafvmaple/blog/issues/17)）。

7. **ブートストラップ鎖の物証は 6 行の `syscall.h`、zcc の 1,500 行 codegen ではない**。zcc が吐いた ELF が Zonix `exec()` でロードされ `printf("Hello\n")` を通せる経路で、**境界をまたいでずれ得る**常数の取り決めは 6 つのシステムコール番号だけ —— それらは zcc リポジトリの `src/runtime/syscall.h` と Zonix リポジトリの `include/abi/syscall.h` がそれぞれ物理コピーを保ち、番号同形、[`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh) が `make user` 時に両者の一致を自動検証。**二つの物理ファイル、一つの論理契約、自動化兜底** —— この継ぎ目の誠実な振り返り（crt0 の `NR_EXIT = 1` リテラルが契約に入っていないという現状未自動化の細部を含む）は [#21](https://github.com/leafvmaple/blog/issues/21) に。

> **2026-05 更新**：前版ここに「本物のユーザーモード ELF を走らせる試み」と書いたが、今やそれが実現した。`exec` サブシステムはディスク上の信頼できない ELF を隔離アドレス空間へ招き、ring 3 へ降格して走らせ、システムコールでカーネルへ戻れる（→ 新規記事 [#18](https://github.com/leafvmaple/blog/issues/18)）。併せて**自作 C コンパイラ zcc**（独立リポジトリ、サブモジュール）も「もう一つの大きな穴」から完全なサブシリーズ [#20](https://github.com/leafvmaple/blog/issues/20) に独立 —— カーネル + コンパイラで「自作コンパイラが自作カーネル上で走るプログラムをコンパイルする」雛形のブートストラップ鎖を構成する。次：スケジューラのプリエンプション全経路検証、riscv64 PLIC の補完、zcc の C サブセットを busybox サブセットがコンパイルできる程度まで拡張。

---

## 更新履歴

<!-- 本記事はインデックス + メタ経験の記事であり、具体的サブシステムの結論は蓄積しない。
     サブシステム単位の進化は各記事へ。横断的な構造変更（アーキ追加、init 変更）はここに 1 行索引。 -->

- 2026-05-23：配套ツールチェーン **zcc** が [#18 §6](https://github.com/leafvmaple/blog/issues/18) の一筆紹介から完全なサブシリーズに独立：メインインデックス [#20](https://github.com/leafvmaple/blog/issues/20) + 記事 [#21](https://github.com/leafvmaple/blog/issues/21) ABI 継ぎ目 / [#22](https://github.com/leafvmaple/blog/issues/22) LLVM codegen / [#23](https://github.com/leafvmaple/blog/issues/23) C0 進化。同時に新規追加 [`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh) + `user/Makefile` フック、zcc / Zonix 二つの `syscall.h` 同期を自動検証（§5 第 7 条 + [#21 §3](https://github.com/leafvmaple/blog/issues/21) 参照）。
- 2026-05-22：直交する新サブシステム **ユーザーモード ELF 実行 + システムコール** を追加、記事 [#18](https://github.com/leafvmaple/blog/issues/18) を起こす。「カーネルスレッドのみ」から「信頼できないユーザープロセスを走らせる」への質的転換（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) exec、[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) syscall ABI、[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) zcc コンパイラサブモジュール統合）。[#12](https://github.com/leafvmaple/blog/issues/12) が当初カーネルスレッドのために引いた `arch_setup_user_tf` / `trapret` 継ぎ目を実現 —— ユーザーモード追加時この経路は一行も変わらなかった。
- 2026-04-07：[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311) で **riscv64** という三つ目のアーキテクチャを追加、[`5b32167`](https://github.com/leafvmaple/zonix-plus/commit/5b32167) でボード抽象を補完。[#15](https://github.com/leafvmaple/blog/issues/15) で述べる HAL 継ぎ目のさらなる検証であり、`kernel/` コアはほぼ無変更。
- 2026-04-07：[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa) / [`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) で全カーネルのエラー処理を `int` 戻り値から `Result<T>` + `TRY` へ移行（§3 と [#17](https://github.com/leafvmaple/blog/issues/17) 参照）。横断的変更であり、各サブシステムへの影響は各記事の更新履歴に記す。

---

*リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。*
