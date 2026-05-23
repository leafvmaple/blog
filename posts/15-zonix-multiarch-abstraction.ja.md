# 2 つ目のアーキテクチャは `kernel/` の裸 `inb` を 1 行残らず暴く

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`arch/*/include/asm/arch.h` / `arch/*/kernel/arch_init.cpp` / `kernel/init.cpp` / 全体の `arch/` レイアウト

`kernel/` ディレクトリには **`inb` / `lcr3` / `sti` を 1 行たりとも書いてはならない** —— ハードウェアに触れる動作はすべて 3 つの対称な `arch_*()` HAL の背後に収束する：

```
$ wc -l arch/*/include/asm/arch.h
  174 arch/x86/include/asm/arch.h
  150 arch/aarch64/include/asm/arch.h
  205 arch/riscv64/include/asm/arch.h
  529 total

$ for a in x86 aarch64 riscv64; do
>   grep -cE '^\s*(static inline )?\w+ +arch_\w+\s*\(' arch/$a/include/asm/arch.h
> done
32
33
34
```

3 つのアーキで 32 / 33 / 34 関数、差は ±1。3 命令セットのメモリモデル、特権レベル、割り込みコントローラ、ブート方式はまったく違うが、カーネルコアの同一コードが 3 セット上で走る。この記事はその継ぎ目をどう引いたかを述べる：何がコンパイル時に消えるか（`static inline` の単一命令）、何が各アーキで関数定義を 1 つずつ書くしかないか、抽象できない部分をどうテーブル駆動データで収めるか。

---

## 1. 継ぎ目の三層：インライン化できるもの、できないもの、抽象できないもの

`arch_*()` HAL（[`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) / [`1941793`](https://github.com/leafvmaple/zonix-plus/commit/1941793) で導入）は一律の「ラッパー層」ではなく、「コンパイル時に消えるか否か」で三層に分かれます。

**第一層：単一命令にインライン化できる —— `static inline` にする。** これらは純粋な命令ラッパーで、ゼロコスト。

```cpp
// arch/x86/include/asm/arch.h
static inline void     arch_load_cr3(uintptr_t cr3) { lcr3(cr3); }      // → mov %rax,%cr3
static inline uint64_t arch_irq_save(void)          { return read_eflags(); }
static inline void     arch_irq_disable(void)       { cli(); }
static inline void     arch_spin_hint(void)         { __asm__ volatile("pause"); }
static inline uintptr_t arch_fault_addr(void)       { return rcr2(); }   // フォルトアドレスは CR2
```

aarch64 のそのヘッダでは、`arch_load_cr3` は `msr ttbr0_el1, x0`、`arch_spin_hint` は `yield`、`arch_fault_addr` は `FAR_EL1` を読む。**呼び出し側は一字も変えない**、なぜなら `arch_load_cr3(cr3)` と書くだけで、コンパイル時に `-I arch/<ARCH>/include` で対応ヘッダが選ばれ、inline 後は関数呼び出しすら消えるからです。

**第二層：アーキ固有状態へのアクセスが要りインライン化できない —— `arch.h` で宣言、各アーキの `arch_init.cpp` で定義。** 例えば割り込み復帰用カーネルスタックの切替：

```cpp
void arch_switch_rsp0(uintptr_t rsp0);   // x86: tss::set_rsp0()  —— TSS に触れる
void arch_irq_eoi(int irq);              // x86: i8259::send_eoi() —— PIC に触れる
void arch_setup_kthread_tf(TrapFrame*, uintptr_t entry, uintptr_t fn, uintptr_t arg);
```

`arch_switch_rsp0` は x86 で TSS の `rsp0` フィールドを書く、これは具体的なハードウェア構造を持つもので、インライン化できない；aarch64 にはそもそも TSS という概念が無く、その実装は別物。宣言を公共 `arch.h` に置き、定義を各アーキに残し、呼び出し側（スケジューラ）は依然一つの関数名しか見ない。

**第三層：抽象できない —— ブートアセンブリ、割り込み入口、コンテキストスイッチ。** `head.S`、`trapentry.S`、`switch.S`、`vectors.S` は**本質的にアーキ専用**で、「汎用の書き方」が一切無い。それらは素直にアーキごとに一つずつ、`arch/<ARCH>/kernel/` に住む。「この部分は抽象できない」と正直に認める方が、穴だらけの偽抽象を無理に作るよりずっと良い。

> 鍵となる判断：**抽象の目標は差異を消すことではなく、差異を隔離すること。** 第三層のアセンブリファイルの存在は抽象の失敗を意味しない —— それらが `arch/` に厳格に閉じ込められ、`kernel/` が決して触れない限り、継ぎ目はきれいです。失敗した抽象は別の姿をしている：`kernel/` に `#ifdef __x86_64__` が散らばっている。Zonix の `kernel/` には**一箇所も `#ifdef <アーキ>` が無い**、全アーキ分岐は `arch/` 境界の外へ押し出されています。

---

## 2. `<asm/...>` 名前空間：同一行の include、異なる物理ヘッダ

ソースコード層での継ぎ目の体現は、Linux に倣った include 規約（[`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) で統一）です。`kernel/` の全アーキ依存参照はこう書きます。

```cpp
#include <asm/arch.h>     // "x86/arch.h" ではなく、中立的な <asm/...>
#include <asm/page.h>
#include <asm/mmu.h>
```

そしてビルドシステムが対象アーキに応じて `-I` を異なる物理ディレクトリへ向ける。

```makefile
# x86 ビルド時
-I arch/x86/include       # <asm/...> → arch/x86/include/asm/...
# aarch64 ビルド時
-I arch/aarch64/include   # <asm/...> → arch/aarch64/include/asm/...
```

こうして `kernel/mm/vmm.cpp` の `#include <asm/page.h>` は、x86 ビルドでは x86 のページテーブルビット定義、aarch64 ビルドでは aarch64 のものを得る —— **同一行のソース、コンパイル時に異なるファイルへ解決**。これは一つのヘッダに `#ifdef` を積むよりずっときれい：各アーキの `asm/page.h` は完全・自己完結・独立して読める定義であって、プリプロセッサ指令で断片に切られた寄せ集めではない。

リポジトリ全体のディレクトリレイアウトもこの原則で組織されています（[`a92a814`](https://github.com/leafvmaple/zonix-plus/commit/a92a814) で Linux 風の `arch/` レイアウトへ）。

```
arch/
  x86/      { boot/ include/asm/ kernel/{head.S,switch.S,idt.cpp,...} }
  aarch64/  { boot/ include/asm/ kernel/{head.S,...} }
  riscv64/  { ... }
kernel/     # アーキ非依存：sched/ mm/ fs/ sync/ cons/ drivers/ —— #ifdef ゼロ
include/    # アーキ非依存の公共ヘッダ：base/ kernel/ uefi/
```

アーキ追加 = `arch/<新アーキ>/` サブツリーを追加し、その `asm/` ヘッダ + ブートアセンブリ + `arch_*()` 実装を提供する。`kernel/` は一切変わらない。

---

## 3. テーブル駆動 init：アーキ差異は「どのデバイスを初期化するか」までデータに収めた

[#11 本編](https://github.com/leafvmaple/blog/issues/11) で初期化に `InitStep` テーブルを使うと述べました。このテーブルのマルチアーキ的価値はここで完全に展開します：**アーキが異なれば初期化すべき早期デバイスはそもそも別の集合**。x86 は 8259 PIC と 8253 PIT を初期化；aarch64 は GIC + generic timer を使い、8259 など存在しない。

解：**汎用の初期化手順は `kernel/init.cpp` の公共テーブルに、アーキ固有の手順は各アーキがサブテーブルを提供**し、メイン側は `arch_early_steps()` で実行時に取得する。

```cpp
// kernel/init.cpp —— アーキ非依存、三アーキ共用
static const InitStep KERN_STEPS[] = {
    {"early_init", early_init, true},   // ← この手順が内部で arch_early_steps() を呼ぶ
    {"pmm", pmm::init, true}, {"vmm", vmm::init, true}, {"vfs", vfs::init, true},
    {"blk", blk::init, true}, {"swap", swap::init, false}, {"sched", sched::init, true},
};

static int early_init() {
    size_t n = 0;
    const InitStep* steps = arch_early_steps(&n);   // 各アーキが一つずつ提供
    run_steps(steps, n);
    return 0;
}
```

```cpp
// arch/x86/kernel/arch_init.cpp —— x86 だけがこのテーブルを持つ
const InitStep ARCH_STEPS[] = {
    {"i8259", i8259::init, true},   // aarch64 の arch_init.cpp のテーブルは GIC で、この行は無い
    {"i8253", i8253::init, true},
    {"idt",   idt::init,   true},
    {"tss",   tss::init,   true},
};
const InitStep* arch_early_steps(size_t* count) { *count = array_size(ARCH_STEPS); return ARCH_STEPS; }
```

`run_steps()` は公共の走査器で、`[OK]`/`[FAIL]` を統一印字し、`required` に応じて失敗時に halt か降格かを決める。**「x86 は aarch64 より 8250 時代のチップを 2 つ多く初期化する」という差異が、1 行の `#ifdef` ではなく、二つのデータテーブルの内容差になった。** アーキ分岐を「データ化」する典型 —— [#13](https://github.com/leafvmaple/blog/issues/13) で「割り当てかスワップインか」の判定を PTE 値に隠したのと同じ発想です。

PCI デバイス探索も同じ仕組み（`arch_pci_steps`）：x86 は AHCI を登録、aarch64 は SDHCI + virtio を登録。ブロックデバイス層（[`6ae17b5`](https://github.com/leafvmaple/zonix-plus/commit/6ae17b5) で早期 init を集中、[`aa54209`](https://github.com/leafvmaple/zonix-plus/commit/aa54209) でプラットフォームドライバをデバイス名で `arch/` へ移動）は上層へ統一の `BlockDevice` インターフェースを呈し、swap とファイルシステムは自分の下が SATA ディスクか SD カードかを知らない。

---

## 4. 三アーキが「同じ問題」をどう解くか

抽象の良し悪しは、同じ低レベル難題に対して三アーキの解法を統一継ぎ目が吸収できるかで分かります。実例をいくつか。

| 問題 | x86_64 | aarch64 | riscv64 |
|---|---|---|---|
| 高位半マッピング | ソフト規約：PML4[511] が高位を指す、リンカスクリプトと連携 | ハード支援：**TTBR0/TTBR1 二つのページテーブルベースレジスタ**、高位アドレスは自動で TTBR1 | `satp` + Sv39/Sv48 |
| アドレス空間切替 | `CR3` 書き込み | `TTBR0_EL1` 書き込み | `satp` 書き込み |
| フォルトアドレス | `CR2` | `FAR_EL1` | `stval` |
| ブートファームウェア | BIOS + UEFI 両経路 | UEFI（QEMU virt、EL1） | SBI / ボード |
| シリアル | 16550 COM1 | PL011 UART | SBI console / UART |
| ブート期シンボル再配置 | `REALLOC` マクロ（仮想 - KERNEL_BASE） | `adrp/adr` PC 相対 | PC 相対 |
| システムコール陥入命令 | `int $0x80` | `svc #0` | `ecall` |
| ELF マシン型検証 | `EM_CURRENT` = 0x3E | `EM_CURRENT` = 0xB7 | `EM_CURRENT` = 0xF3 |

最も面白いのは高位半マッピングの行です。x86 では「カーネルが高位にある」は**ソフトウェア規約** —— PML4 最終項にマッピングを手で埋め、リンカスクリプトでカーネルを `0xFFFFFFFF80000000` へリンクせねばならない（[#14](https://github.com/leafvmaple/blog/issues/14) 参照）。一方 aarch64 はこれを**ハードウェアに作り込んだ**：二つのページテーブルベースレジスタを持ち、`TTBR0_EL1` が低位、`TTBR1_EL1` が高位を管理し、上位全 1 のアドレスは自動で TTBR1 へ。同じ「ユーザー/カーネルアドレス空間分離」の要求を、x86 はソフトで凑え、aarch64 はハードウェアネイティブ支援を持つ —— だが `arch_load_cr3()` / `arch_fault_addr()` の継ぎ目の上では、**スケジューラとフォルトハンドラは同一の意味論を見て**、下が一方はソフト規約、一方はハードウェアレジスタだとは一切知らない。

この表は「二つ目・三つ目の実装が抽象を検証する」最良の証拠だ。x86 だけなら `CR2`、`CR3` という名前を汎用コードに直接書き、「どうせ全部ページテーブルでしょ」と自己満足してしまいやすい；aarch64 の `FAR_EL1`/`TTBR` と riscv64 の `stval`/`satp` がそれらを `arch_fault_addr()`/`arch_load_cr3()` へ抽象させた。二つ目のアーキは無料の設計レビュー、三つ目のアーキは無料の回帰テスト —— riscv64 を追加した日（[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311)）、真の継ぎ目はすべて一発で通り、当初手を抜いて残した x86 前提はすべて即座にエラーを出した。

---

## 5. 細部：`memcpy` すらアーキ最適実装に分けた

抽象が行き届くと、逆に各アーキへ性能の裏口を残せます。`arch_memcpy`/`arch_memset` は単純な逐バイトループではなく、x86 では `rep movsq`/`rep stosq` で 8 バイトブロック単位で猛烈にコピーします。

```cpp
static inline void* arch_memcpy(void* dst, const void* src, size_t n) {
    auto* d = (char*)dst; auto* s = (const char*)src;
    size_t qwords = n / 8;
    if (qwords) __asm__ volatile("rep movsq" : "+D"(d),"+S"(s),"+c"(qwords) :: "memory");
    n &= 7;
    while (n--) *d++ = *s++;   // 8 バイト未満の末尾を逐バイトで仕上げ
    return dst;
}
```

カーネルの全 `memcpy` 呼び出し（Clang が構造体代入時にこっそり挿入するものも含む、[#17](https://github.com/leafvmaple/blog/issues/17) 参照）は最終的に `arch_memcpy` に落ちる。これが階層化継ぎ目の複利：上層は `memcpy` を呼ぶだけ、下層は各アーキが自分の最速命令でそれを実装でき、互いに干渉しない。aarch64 は `dc zva`（キャッシュライン clear）付きの版に替えられ、呼び出し側は依然ゼロ感知。

---

## 6. 更新履歴

<!-- マルチアーキ / HAL の今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-04-08：ユーザーモード実行が実現し、§4 の「同じ問題への三つの解」表に二行追加 —— **システムコール陥入命令**（`int $0x80` / `svc #0` / `ecall`、[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）と **ELF マシン型検証**（`EM_CURRENT` コンパイル時解決、[`67608c2`](https://github.com/leafvmaple/zonix-plus/commit/67608c2)）。`handle_syscall` は `tf->syscall_nr()`/`syscall_arg()` アクセサでアーキ非依存を保つ。完全な経路は [#18](https://github.com/leafvmaple/blog/issues/18) を参照。
- 2026-04-02：[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311) で **riscv64** という三つ目のアーキを追加、[`5b32167`](https://github.com/leafvmaple/zonix-plus/commit/5b32167) でボード抽象を補完しついでに VFS ディレクトリインターフェースをリファクタ。本記事の継ぎ目の究極の検証：`kernel/` コアはほぼ無変更。
- 2026-03-16：[`aa54209`](https://github.com/leafvmaple/zonix-plus/commit/aa54209) プラットフォームドライバを `arch/` へ移しデバイス名でリネーム；[`bb4986e`](https://github.com/leafvmaple/zonix-plus/commit/bb4986e) Makefile をアーキ別に分割し出力ディレクトリを隔離（§3 参照）。
- 2026-03-15：[`6ae17b5`](https://github.com/leafvmaple/zonix-plus/commit/6ae17b5) 早期 init を集中しアーキごとにブロックドライバを分離。
- 2026-03-13：[`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) arch 抽象層を導入し `asm/` include 名前空間を統一（§1/§2 参照）；[`04372ef`](https://github.com/leafvmaple/zonix-plus/commit/04372ef) 可搬な `VM_*` ページテーブルフラグを導入し aarch64 の骨格を組む（§4 参照）。
- 2026-03-04：[`a92a814`](https://github.com/leafvmaple/zonix-plus/commit/a92a814) Linux 風の `arch/` ディレクトリレイアウトを採用。

---

*リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本記事は [Zonix OS シリーズ](https://github.com/leafvmaple/blog/issues/11) の一篇。*
