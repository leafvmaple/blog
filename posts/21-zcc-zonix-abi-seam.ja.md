# `syscall.h` 1 枚、二つの物理コピー、三人の消費者：zcc と Zonix の ABI 継ぎ目

> リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc) + [leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[zcc メインインデックス #20](https://github.com/leafvmaple/blog/issues/20) の継ぎ目深掘り
> 対象サブシステム：`zcc/src/runtime/{syscall.h,printf.c,x64/,riscv64/}` / `zonix-plus/include/abi/syscall.h` / `zonix-plus/kernel/trap/trap.cpp` / `zonix-plus/scripts/check_syscall_abi_sync.sh`

zcc プロジェクトで**本当に体系の閉環を担っているのは ~1,500 行の codegen ではなく、30 行の `syscall.h`**。このヘッダは 6 つのシステムコール番号（`NR_EXIT` / `NR_READ` / `NR_WRITE` / `NR_OPEN` / `NR_CLOSE` / `NR_PAUSE`）と 3 つの fd 定数を定義し、三人がそれぞれ include する：

- Zonix カーネル `kernel/trap/trap.cpp` の `handle_syscall()`、C++ で `case NR_WRITE:` が処理関数へ飛ぶ
- zcc ユーザープログラムの C コード（例：`printf.c` が `sys_write` を呼ぶ）、`.S` スタブ経由で間接的に番号へ
- zcc runtime の `syscall.S` アセンブリスタブ、`movq $NR_WRITE, %rax; int $0x80`

その物理実装には、誠実に告白すべき微妙な事実がある：**二つの物理ファイル、一つの論理契約**。一つは zcc リポジトリの `src/runtime/syscall.h`、もう一つは Zonix リポジトリの `include/abi/syscall.h` —— 番号は同じ、定義の形も同じだが、header guard・コメント・空白は完全に独立した二つのコピー。これは工程上の怠慢ではなく、より強い制約に**押し出された**結果：**zcc は独立リポジトリとしてビルドできなければならず**、Zonix のサブモジュールパスへ逆向きに依存できない。

この一篇では密に噛み合う四つを解きほぐす：契約が三つの境界をどう跨ぐか、なぜ二つのコピーが正しい取捨なのか、30 行の shell スクリプトで「両者が永遠に同期」をどう守るか、そして一つの `hello.c` が zcc のコマンドラインから Zonix の `exec()` までどう流れるか。これは [#20 §2](https://github.com/leafvmaple/blog/issues/20) の決定の物証。

---

## 1. 6 行の `#define`、3 つの include 現場

まず契約そのものを貼る。下が zcc 側のそれ：

```c
/* zcc/src/runtime/syscall.h */
#ifndef _ABI_SYSCALL_H
#define _ABI_SYSCALL_H

/* ---- Syscall numbers ---- */
#define NR_EXIT  1
#define NR_READ  3
#define NR_WRITE 4
#define NR_OPEN  5
#define NR_CLOSE 6
#define NR_PAUSE 29

/* ---- Stdout / Stderr fd constants ---- */
#define STDIN_FD  0
#define STDOUT_FD 1
#define STDERR_FD 2

#endif
```

Zonix 側 `include/abi/syscall.h` の内容は**完全に同じ**（header guard が `_ZONIX_ABI_SYSCALL_H` に、コメントが「single source of truth for ... shared between the kernel and user-space toolchains」に変わるだけ、下の §3 で「完全に同じ」がどう強制されるかを説明する）。

ここに二つの**抑制**：

1. **`#define` のみ、`enum class` / `constexpr` 無し**。趣味ではなく、`.S` ファイルから `#include` できる必要があるから —— アセンブリの preprocessor は C マクロしか認識せず、C++ の型は読めない。いつか我慢できずに `constexpr int NR_WRITE = 4;` に変えた瞬間、`syscall.S` がコンパイル不能になる。
2. **呼出規約も無し、fd 型も無し、`errno` も無し** —— これらの情報は「各人にとって自明な常識」。番号以外の契約（「引数は `rdi`/`rsi`/`rdx` から、返り値は `rax`」）は `crt0.S` と `trap.cpp` の実装に刻む、このヘッダには入れない。**ヘッダは「境界をまたいでずれ得る」契約の部分だけを担う**。

三者がこのヘッダを include する現場：

**(A) カーネルの trap dispatcher** ([`kernel/trap/trap.cpp:219`](https://github.com/leafvmaple/zonix-plus/blob/main/kernel/trap/trap.cpp#L219))：

```cpp
#include <abi/syscall.h>
// ...
bool handle_syscall(TrapFrame* tf) {
    int nr = static_cast<int>(tf->syscall_nr());
    switch (nr) {
        case NR_EXIT:  sched::exit(tf->syscall_arg(0));        return true;
        case NR_WRITE: {
            int fd       = tf->syscall_arg(0);
            const char* buf = (const char*)tf->syscall_arg(1);
            size_t count = tf->syscall_arg(2);
            tf->set_return(sys_write(cur, fd, buf, count));
            return true;
        }
        case NR_READ:  { /* ... */ }
        case NR_OPEN:  { /* ... */ }
        case NR_CLOSE: { /* ... */ }
        default:       return false;
    }
}
```

`tf->syscall_nr()` は [`#15 マルチアーキ抽象`](https://github.com/leafvmaple/blog/issues/15) の HAL から来る：x86 で `rax` を読み、aarch64 で `x8`、riscv64 で `a7`。**番号自体はアーキテクチャに依らない** —— これがこれを `arch/<isa>/` ではなく `include/abi/` に置く理由。

**(B) zcc runtime のアセンブリスタブ** ([`zcc/src/runtime/x64/syscall.S`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/x64/syscall.S))：

```asm
#include "syscall.h"           ; ← 同じ include パス

    .globl sys_write
sys_write:
    movq    $NR_WRITE, %rax    ; ← マクロが 4 に展開
    int     $0x80
    ret
```

アセンブリがこのヘッダを `#include` できるのは §1 第 1 条の抑制の見返り —— `NR_WRITE` は `.S` の中でただの `$4`。

**(C) zcc が編むユーザープログラム** ([`zcc/src/runtime/printf.c:23`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/printf.c#L23))：

```c
long sys_write(int fd, const void *buf, long count);  /* syscall.S から来る */

static void put_char(char c) {
    sys_write(1, &c, 1);   /* fd=1 = STDOUT_FD = stdout */
}
```

`printf.c` は `syscall.h` を直接 include しない —— `sys_write` の C 宣言を介して間接的に番号に結びつく。これは**二段階契約**：`syscall.h` が番号の真実源、`sys_write` 関数シンボルが番号の「玄関」。ユーザープログラムは玄関しか見ない、番号を直接見ない。

三者を貫いてみる：ユーザープログラムが `printf("hi")` を書く → `printf.c` が文字を分解 → `sys_write(1, &c, 1)` → アセンブリスタブが `NR_WRITE` を取る → `int $0x80` でトラップ発火 → カーネル `handle_syscall(tf)` の `case NR_WRITE:` → `sys_write(cur, fd, buf, count)`。**`NR_WRITE` の値 4 という数字は、どの一方のソースコードにも裸のリテラルとして現れない** —— 三つの include がすべてマクロ展開で。

---

## 2. 二つの物理ファイル：「独立にビルド可能」に押し出された折衷

理論上最も優雅な実装は**一つの物理ファイル、両側で include**。例えば Zonix 側で：

```cpp
// zonix-plus/include/abi/syscall.h
#include "../../user/zcc/src/runtime/syscall.h"
```

逆に zcc が上流の Zonix の方を include しても良い。だがどちらにも同じ問題：**循環依存**。

zcc は独立リポジトリとして `git clone && make` で直接 `compiler` 実行ファイルを編める必要がある（[`zcc/makefile:70`](https://github.com/leafvmaple/zcc/blob/main/makefile#L70)）、Zonix のソース配置に依存させてはいけない —— さもないと PKU 同学がこのリポジトリで実習をやる時、あるいは誰かが zcc を自分の OS に接続したい時、include パスが全部切れる。逆に Zonix も `user/zcc/` パスに必ず中身があると期待してはいけない —— Zonix もサブモジュール未初期化でカーネルを編めるべき（zcc はユーザープログラム工具に過ぎず、カーネル本体には影響しない）。

そこで両者は完全な独立コピーを各々保持し、**互いに include しない**。代償は「両ファイルの同期は人の記憶頼り」 —— これは本当に危険な位置：ABI 番号を一つ書き間違えてもどのコンパイル時エラーも引き起こさない、**ランタイムで静かに分岐を間違える**（カーネルへ `NR_WRITE=4` を投げたつもりが、カーネルが `NR_OPEN=5` と解釈して別経路へ）。

工業界のこの「vendored ヘッダ」の扱いは成熟している：Linux カーネル UAPI ヘッダは musl libc / glibc / 各種 BSD が各々 vendor、どの一方も他方のソース配置に逆向きに依存しない、**同期はコードレビュー + 自動チェックで共同で守る**。zcc/Zonix はこの同じ手法を 30 行の shell スクリプトに仕立てただけ。

> 言うに値するアンチパターン：git submodule で逆向きに繋ぐ、例えば zcc リポジトリに `external/zonix/` サブモジュールを加えて `external/zonix/include/abi/syscall.h` を include する —— 表面上は物理的に統一されたように見える、実態は**コンパイラリポジトリが OS リポジトリに依存**。これは逆向き結合、「コンパイラはより基礎的な道具」という直観に反する。**上流が下流に依存しない**ことこそこの決定の真の原則、「二つのコピー」はその結果。

---

## 3. 30 行の shell で二つのコピーの同期を守る

物理二つ・論理一つ、には必ず自動チェックで底支えが要る。さもないと次に `NR_FORK = 57` を追加する時、Zonix 側だけ加えて zcc 側を忘れる —— `fork()` のユーザープログラムを zcc runtime で編む際、スタブ関数が見つからない（コンパイル時に止まる）；あるいはもっと悪く、番号は加えたが値が違う —— このずれはランタイムでしか「`fork()` の挙動がおかしい」として表面化しない。

[`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh) のコアロジックはわずか 6 行：

```bash
normalize() {
    grep -E '^[[:space:]]*#define[[:space:]]+(NR_|[A-Z]+_FD\b)' "$1" \
        | sed -E 's/[[:space:]]+/ /g' \
        | sort
}

diff <(normalize "$ZONIX_HDR") <(normalize "$ZCC_HDR")
```

三ステップ：

1. **抽出** —— `#define NR_*` と `#define *_FD` の行だけを見る、header guard / コメント / 空白は全部無視。
2. **正規化** —— 複数空白を単一空白に潰し、行をソート。これで「`NR_WRITE    4`」と「`NR_WRITE 4`」が等価と見做せる（実際 Zonix 側は 4 スペース揃え、zcc 側は 1 スペース、でも番号は同じ）。
3. **diff** —— 不一致があれば exit 1、どの 2 行が違うか出力。

[`user/Makefile`](https://github.com/leafvmaple/zonix-plus/blob/main/user/Makefile) にフックする：

```makefile
.PHONY: check-syscall-abi
check-syscall-abi:
	$(Q)bash scripts/check_syscall_abi_sync.sh

user: check-syscall-abi $(USER_ELFS)
```

任意の `make user`、`make all`（間接的に user を依存）、CI でユーザープログラムを走らせる経路 —— zcc が ELF を吐いて Zonix カーネルにロードさせる経路すべて —— がこのチェックを先に通る。失敗時のエラーは明快：

```
ERROR: syscall ABI mismatch between kernel and zcc runtime:
  kernel: include/abi/syscall.h
  zcc:    user/zcc/src/runtime/syscall.h
< #define NR_FORK 57
---
> #define NR_FORK 58

Both files must define the same NR_* numbers and *_FD constants.
Update both before committing.
```

ここに語る価値ある工程的細部 —— スクリプトの grep の正規表現は `(NR_|[A-Z]+_FD\b)`、**意図的に番号と fd 定数だけをカバー**。いつか別の `#define`（例えば ABI バージョン番号、フラグビットマスク）を加えるなら、それが契約に入るべきかを能動的に判断する必要がある —— 契約の伸びる速度は遅く、意識的であるべき。**自動化のカバー範囲が契約自体より広くなってはいけない** —— さもないと次に internal-only な `#define ZCC_BUFSIZE 256` を加えたい時にも Zonix 側に同期する羽目になり、契約の境界が逆に曖昧になる。

この継ぎ目は Zonix [#14 BootInfo](https://github.com/leafvmaple/blog/issues/14) の bootloader / カーネル共有契約と同論理：**境界をまたぐ常数の取り決めには、両側で同一ファイルを物理的に include させるか、同期過程に自動化の底支えを与えるか**。この二つの間に「コメントと記憶だけに頼る」という選択肢は無い。

---

## 4. crt0.S は契約の「玄関」：main の終了コードをカーネルへどう返すか

`syscall.h` が番号を定義する、`crt0.S` が「main 終了後どの番号でカーネルに戻り、終了コードをどう渡すか」を定義する。二アーキ各一式だが形は同じ：

**x86_64** ([`zcc/src/runtime/x64/crt0.S`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/x64/crt0.S))：

```asm
.globl _start
_start:
    xorq    %rbp, %rbp          /* フレームポインタをクリア、backtrace がここをスタック底と知るため */
    call    main                /* ユーザーの main を呼ぶ —— 返り値は %rax に */

    movq    %rax, %rdi          /* exit code -> arg0 */
    movq    $1, %rax            /* NR_EXIT = 1 */
    int     $0x80
    hlt                         /* 防御的：sys_exit は戻ってはならない */
```

**RISC-V 64** ([`zcc/src/runtime/riscv64/crt0.S`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/riscv64/crt0.S))：

```asm
.globl _start
_start:
    call    main                /* main の返り値はすでに a0 —— riscv64 呼出規約 */

    li      a7, 1               /* NR_EXIT = 1 */
    ecall
    j       _start              /* 防御的：ここに来てはならない */
```

語れる二つ：

**(1) `xorq %rbp, %rbp` は装飾ではない**。x86_64 のスタック展開（backtrace）は `rbp` チェーンで上のフレームへ戻る。`_start` こそが真のスタック底、「上のフレーム」は無い —— `rbp` をゼロクリアすることで、任意の backtrace ツールがここを底と認識できる（System V ABI が強制要求）。riscv64 はこの問題が無い、なぜならスタック展開は DWARF メタ情報で進み、frame pointer チェーンに依らないから。

**(2) `NR_EXIT = 1` という数字は現れない**。両 crt0 ともに `$1` / `li a7, 1` という**裸のリテラル** —— `syscall.h` を **include していない**。なぜ？`.S` で `syscall.h` を include するには C preprocessor を通す必要がある、だが zcc 側で `crt0.S` のビルドは `as` 直接アセンブル・cpp を通さない。一貫性は人手レビュー頼り：`NR_EXIT` を変更するたびにこの二つの crt0 を確認する必要がある。

これは**既知の小さな穴** —— 理想形は `crt0.S` で `#include "syscall.h"` してから `movq $NR_EXIT, %rax`、「1」というリテラルも契約に取り込む。これを直すコストは zcc の Makefile を改めて `.S` を `clang -E` で前処理させる。今直していないのは `NR_EXIT = 1` が変わる可能性が低いから（Unix v6 以来の伝統番号）、だがそれが潜在的なずれの点だと認めることは「無いふり」よりよい。**埋めるべき所は先に書き留めておく** —— 次に本当に誰かが `NR_EXIT` を変えれば一緒に埋まる。

---

## 5. linker.ld が ELF を `0x400000` に固定：Zonix のユーザーアドレス空間配置に合わせる

[`zcc/src/runtime/x64/linker.ld`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/x64/linker.ld) は計 23 行：

```ld
ENTRY(_start)

SECTIONS {
    . = 0x400000;          /* ロードアドレス */

    .text   : { *(.text) }
    .rodata : { *(.rodata*) }
    .data   : { *(.data) }
    .bss    : { *(.bss) }
}
```

あの `0x400000` は適当に選んだのではない。Zonix [`#18 §1`](https://github.com/leafvmaple/blog/issues/18) はユーザーアドレス空間を「低位半をユーザー、高位半をカーネル（共有マッピング）」とレイアウトする —— `0x400000` は低位半の中で「NULL faulting からは十分遠く、ユーザースタックよりは十分低い」位置（同じく Linux ELF の伝統的デフォルト `0x400000`）。

ということは linker.ld は**コンパイラ/OS をまたぐもう一つの暗黙の契約**。Zonix がユーザーアドレス配置を変えたら（例えば `0x10000` 始まりに）、linker.ld も追従して変えねばならない、さもないと ELF ロード後に entry が Zonix のマッピング外仮想アドレスに落ちる → 即 page fault。

**この契約は現在自動化されていない** —— §4 の `NR_EXIT = 1` リテラルより大きい潜在的穴。救済の可能性：

- Zonix 側で `USER_LOAD_BASE` 定数を `include/abi/` に出力し、linker.ld は cpp 展開で値を取る。だが linker script 構文はネイティブには `#include` を持たない、`cpp -P` を先に通す必要があり、工程複雑度が上がる。
- あるいは `0x400000` も `syscall.h` に書く：`#define USER_LOAD_BASE 0x400000`、`check_syscall_abi_sync.sh` の正規表現を拡張してこれをカバー。

今はどちらもやっていない —— なぜなら Zonix のユーザーアドレス配置はリリース以来変わっておらず、これを契約に入れる優先度は「番号契約が本当に有用と検証する」より低いから。本当にレイアウトを変える必要が出た時に補えばよい。**「今は完全自動化されていない」と認めることは、「すべてロックされている」と装うより誠実**。

---

## 6. 端から端まで：`zcc hello.c` からカーネル `exec()` まで

この篇の継ぎ目を全部つなぐ。一つの `hello.c`：

```c
int main() {
    printf("Hello from zcc on Zonix!\n");
    return 0;
}
```

完全な経路：

```
                                  zcc 側                                  Zonix 側
                                  ┌────────────────────────────────┐    ┌────────────────────────────┐
   $ zcc -x64 hello.c -o ZHELLO   │                                │    │                            │
   │                              │                                │    │                            │
   │                              │  1. flex+bison → AST           │    │                            │
   │                              │  2. AST → LLVM IR              │    │                            │
   │                              │  3. llc → x64 assembly         │    │                            │
   │                              │  4. clang -c → user.o          │    │                            │
   │                              │  5. ld -T linker.ld \          │    │                            │
   │                              │     crt0.o user.o libzccrt.a   │    │                            │
   │                              │     → ZHELLO (ELF, entry=      │    │                            │
   │                              │       0x400000)                │    │                            │
                                  └────────────────────────────────┘    │                            │
                                                                        │                            │
   $ make user # in zonix-plus    ────────────────────────────────►     │ check_syscall_abi_sync.sh  │
                                                                        │ → ABI in sync              │
                                                                        │ create_userdata_image.sh   │
                                                                        │ → userdata.img (FAT32,     │
                                                                        │    ZHELLO.ELF を含む)      │
                                                                        │                            │
   $ make qemu                                                          │ qemu boots, kernel mounts  │
                                                                        │ /mnt, exec("/mnt/ZHELLO") ─┼──► [#18] ELF をロード
                                                                        │                            │       ユーザーアドレス空間構築
                                                                        │                            │       iretq で ring 3 へ降下
                                                                        │                            │
                                                                        │ ZHELLO 走る                │
                                                                        │   ↓                        │
                                                                        │ printf → put_char →        │
                                                                        │ sys_write(1,&c,1) →        │
                                                                        │ movq $4,%rax; int $0x80 ──►│ trap.cpp handle_syscall
                                                                        │                            │ case NR_WRITE: カーネル内で
                                                                        │   ↓                        │ console に書く
                                                                        │ return 0 → _start          │
                                                                        │   ↓                        │
                                                                        │ movq $1,%rax; int $0x80 ──►│ case NR_EXIT: sched::exit
                                                                        └────────────────────────────┘
```

赤線が三つの継ぎ目を貫く：

- **データ契約**：`NR_WRITE = 4` が zcc 側 `syscall.S`、Zonix 側 `trap.cpp` に、人手同期される二つの `syscall.h` を介して一致を守る（`check_syscall_abi_sync.sh` が検証）。
- **エントリ契約**：`crt0._start` が ELF の中、`linker.ld` が `_start` を `0x400000` に固定、Zonix のユーザーアドレス配置に合わせる。
- **実行契約**：`iretq` / `eret` が自動で ring 3 へ降ろすのは Zonix [`#18 §3`](https://github.com/leafvmaple/blog/issues/18) が担う；ユーザー → カーネルのエントリは `trap.cpp` で [`#15`](https://github.com/leafvmaple/blog/issues/15) の HAL が収める。

この鎖全体が走るのは、zcc が優秀だから・Zonix が完備だからではない —— 三つの継ぎ目すべてが「検証可能な最小契約」の上に引かれているから：**番号（自動化）、エントリアドレス（取り決め + 単一源）、特権降下（ハードウェア強制）**。

---

## 7. イテレーション履歴

<!-- 後の ABI / runtime / crt0 / linker の進展はここに追加、時間逆順。各行に commit リンク + 一二文の説明。 -->

- 2026-05-23：本記事初出。新規追加：[`zonix-plus/scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh)（zcc / Zonix 二つの `syscall.h` 同期を守る）+ `user/Makefile` に `check-syscall-abi` 前置追加。§4 / §5 に「`NR_EXIT=1` リテラル」「`0x400000` ロードアドレス」二つの**既知未自動化** 契約を書き留め —— 救済策は本文中、本当に変更需要が出た時に進める。
- 2026-04-08：[`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b)（zcc）+ [`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)（Zonix）で同時に `syscall.h` を独立 ABI ヘッダとして抽出、「二つの物理ファイル、一つの論理契約」の形態を確立。それ以前は zcc の runtime は `printf.c` と `syscall.S` に番号をハードコード、Zonix 側は `trap.cpp` にハードコード —— 片方が書き間違えても走らせて気づくしかなかった。
- 2026-03-13：[`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5) で zcc に freestanding runtime（`crt0.S` / `syscall.S` / `linker.ld` / `printf.c`）を追加、`-x64` 出力が Zonix `exec()` で直接ロード可能な ELF に。zcc が初めて「教育コンパイラ」から「自前ツールチェーン」へ物理的に変わった。

---

*リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc) + [leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本記事は [zcc シリーズ](https://github.com/leafvmaple/blog/issues/20) の一篇。*
