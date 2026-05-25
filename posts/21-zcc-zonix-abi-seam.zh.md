<!--pub:2026-03-05-->
# 一份 `syscall.h`、两份物理拷贝、三方消费者：zcc 和 Zonix 之间的 ABI 接缝

> 仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc) + [leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[zcc 主索引帖 #20](https://github.com/leafvmaple/blog/issues/20) 的接缝深读
> 涉及子系统：`zcc/src/runtime/{syscall.h,printf.c,x64/,riscv64/}` / `zonix-plus/include/abi/syscall.h` / `zonix-plus/kernel/trap/trap.cpp` / `zonix-plus/scripts/check_syscall_abi_sync.sh`

zcc 项目里**真正承载体系闭环的，不是 ~1,500 行 codegen，是一份 30 行的 `syscall.h`**。这份头文件定义 6 个系统调用号（`NR_EXIT` / `NR_READ` / `NR_WRITE` / `NR_OPEN` / `NR_CLOSE` / `NR_PAUSE`）和 3 个 fd 常量，被三方各自 include：

- Zonix 内核 `kernel/trap/trap.cpp` 的 `handle_syscall()`，C++ `case NR_WRITE:` 跳到处理函数
- zcc 用户程序的 C 代码（如 `printf.c` 调 `sys_write`），通过 `.S` 桩间接走号
- zcc runtime 的 `syscall.S` 汇编桩，`movq $NR_WRITE, %rax; int $0x80`

它的物理实现有一个微妙的事实需要诚实交代：**两份物理文件，一份逻辑契约**。一份在 zcc 仓库 `src/runtime/syscall.h`、一份在 Zonix 仓库 `include/abi/syscall.h`——号码一致、定义同形，但 header guard、注释、空白完全是两份独立拷贝。这不是工程上的疏忽，是被一条更强的约束**逼出来**的：**zcc 必须能作为独立仓库构建**，不能反向依赖 Zonix 的子模块路径。

这一篇拆四件紧密咬合的事：契约怎么跨过三个边界、为什么两份拷贝是正确的取舍、怎么用一个 30 行的 shell 脚本守住"两边永远同步"、以及一个 `hello.c` 怎么从 zcc 的命令行流到 Zonix 的 `exec()` 跑起来。这是 [#20 §2](https://github.com/leafvmaple/blog/issues/20) 那条决策的物证。

---

## 1. 6 行 `#define`、3 个 include 现场

先把契约本身贴出来。下面是 zcc 这边那份：

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

Zonix 这边 `include/abi/syscall.h` 的内容**完全相同**（除了 header guard 改成 `_ZONIX_ABI_SYSCALL_H` 和注释换成"single source of truth for ... shared between the kernel and user-space toolchains"，下面 §3 会说清"完全相同"是怎么强制的）。

注意两条**克制**：

1. **只有 `#define`，没有 `enum class` / `constexpr`**。原因不是品味，是要让这份文件能被 `.S` 文件 `#include`——汇编 preprocessor 只认 C 宏，认不了 C++ 类型。如果哪天忍不住把它改成 `constexpr int NR_WRITE = 4;`，下一秒 `syscall.S` 就编不过。
2. **没有调用约定、没有 fd 类型、没有 `errno`**——这些信息是各方"约定的常识"。号码以外的契约（"参数从 `rdi`/`rsi`/`rdx` 进，返回值在 `rax`"）刻在 `crt0.S` 和 `trap.cpp` 的实现里，不进这份头文件。**头文件只承载"会跨边界漂移"的那部分契约**。

三方 include 这份头文件的现场：

**(A) 内核的 trap 分发器** ([`kernel/trap/trap.cpp:219`](https://github.com/leafvmaple/zonix-plus/blob/main/kernel/trap/trap.cpp#L219))：

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

`tf->syscall_nr()` 来自 [`#15 多架构抽象`](https://github.com/leafvmaple/blog/issues/15) 那套 HAL：x86 上读 `rax`、aarch64 上读 `x8`、riscv64 上读 `a7`。**号码本身是架构无关的**——这正是把它抽进 `include/abi/` 而不是 `arch/<isa>/` 的理由。

**(B) zcc runtime 的汇编桩** ([`zcc/src/runtime/x64/syscall.S`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/x64/syscall.S))：

```asm
#include "syscall.h"           ; ← 同一份 include 路径

    .globl sys_write
sys_write:
    movq    $NR_WRITE, %rax    ; ← 宏展开为 4
    int     $0x80
    ret
```

汇编 `#include` 这份头文件的能力是 §1 第 1 条克制的回报——`NR_WRITE` 在 `.S` 文件里就是个普通的 `$4`。

**(C) zcc 编出来的用户程序** ([`zcc/src/runtime/printf.c:23`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/printf.c#L23))：

```c
long sys_write(int fd, const void *buf, long count);  /* 来自 syscall.S */

static void put_char(char c) {
    sys_write(1, &c, 1);   /* fd=1 = STDOUT_FD = stdout */
}
```

`printf.c` 不直接 include `syscall.h`——它通过 `sys_write` 的 C 声明间接绑到那个号码上。这是一种**两段式契约**：`syscall.h` 是号码的真相源，`sys_write` 函数符号是号码的"门面"。用户程序只看到门面，不直接见号。

把三方串起来：用户程序写 `printf("hi")` → `printf.c` 拆字符 → `sys_write(1, &c, 1)` → 汇编桩取 `NR_WRITE` → `int $0x80` 触发陷阱 → 内核 `handle_syscall(tf)` `case NR_WRITE:` → `sys_write(cur, fd, buf, count)`。**`NR_WRITE` 的值 4 这个数字从来不在任何一方的源码里以裸字面量出现**——三个 include 全靠宏展开。

---

## 2. 两份物理文件：被"独立可构建"逼出来的折中

理论上最优雅的实现是**一份物理文件、两边 include**。比如 Zonix 直接：

```cpp
// zonix-plus/include/abi/syscall.h
#include "../../user/zcc/src/runtime/syscall.h"
```

或反过来，zcc 直接 include 上游 Zonix 的那份。但这两种方案都有一个相同的问题：**循环依赖**。

zcc 作为独立仓库要能 `git clone && make` 直接编出 `compiler` 可执行（[`zcc/makefile:70`](https://github.com/leafvmaple/zcc/blob/main/makefile#L70)），不允许它依赖 Zonix 的源码布局——否则 PKU 同学拿这个 repo 做实验作业、或者别人想把 zcc 接到自己的 OS 上时，全是断掉的 include 路径。反过来 Zonix 也不能依赖 `user/zcc/` 路径下一定有内容——Zonix 也要能在没初始化子模块的状态下编内核（zcc 只是用户程序工具链，不影响内核本身）。

所以两边都各自留一份完整的头文件，**不互相 include**。代价是"两份文件的同步全靠人记忆"——这是真正危险的位置：一个 ABI 号写错不会触发任何编译错误，只会触发**运行时静默走错分支**（你给内核发了 `NR_WRITE=4`，内核以为是 `NR_OPEN=5` 跳错路径）。

工业界对这种"vendored 头文件"的处理方式很成熟：Linux 内核 UAPI 头文件被 musl libc、glibc、各种 BSD 各自 vendor 一份，没有任何一方反向依赖另一方的源码布局，**同步由代码审查 + 自动化检查共同守住**。zcc/Zonix 这边只是把同一套办法做成一个 30 行的 shell 脚本。

> 一个值得说的反 pattern：如果用 git submodule 反向连过来，比如让 zcc 仓库里加一个 `external/zonix/` 子模块然后 include `external/zonix/include/abi/syscall.h`，表面是物理统一了，实际是**编译器仓库依赖了 OS 仓库**——这是反向耦合，违背"编译器是更基础的工具"这个直觉。**让上游不依赖下游**是这条决策真正的原则，"两份拷贝"只是它的后果。

---

## 3. 一个 30 行的 shell 守住两份拷贝同步

物理两份、逻辑一份这件事，必须有自动化检查兜底。否则下次加 `NR_FORK = 57` 时，只在 Zonix 这边加、忘了同步到 zcc——下一个 `fork()` 用户程序在 zcc runtime 里编译时桩函数找不到（编译期能挡住）；或者更糟，号码加上了但取了不同的值——这种漂移只在运行时表现为"`fork()` 行为离奇"。

[`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh) 的核心逻辑只有 6 行：

```bash
normalize() {
    grep -E '^[[:space:]]*#define[[:space:]]+(NR_|[A-Z]+_FD\b)' "$1" \
        | sed -E 's/[[:space:]]+/ /g' \
        | sort
}

diff <(normalize "$ZONIX_HDR") <(normalize "$ZCC_HDR")
```

三步：

1. **抽**——只看 `#define NR_*` 和 `#define *_FD` 这两类行，header guard / 注释 / 空白全忽略。
2. **规范化**——把多空格塌成单空格、行排序。这样"`NR_WRITE    4`"和"`NR_WRITE 4`"被视为等价（实际项目里 Zonix 这边用 4 空格对齐、zcc 那边用 1 空格，但号是一样的）。
3. **diff**——任何不一致就 exit 1，输出哪两行不同。

钩在 [`user/Makefile`](https://github.com/leafvmaple/zonix-plus/blob/main/user/Makefile) 里：

```makefile
.PHONY: check-syscall-abi
check-syscall-abi:
	$(Q)bash scripts/check_syscall_abi_sync.sh

user: check-syscall-abi $(USER_ELFS)
```

任何 `make user`、`make all`（间接依赖 user）、CI 跑 user 程序——任何会让 zcc 编出 ELF 喂给 Zonix 内核加载的路径——都先过这道检查。失败时报错很直白：

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

这里有个工程细节值得说——脚本 grep 的正则是 `(NR_|[A-Z]+_FD\b)`，**故意只覆盖号码和 fd 常量**。如果哪天加了别的 `#define`（比如 ABI 版本号、flag 位 mask），需要主动判断它该不该进契约——契约长出来的速度应该慢、应该有意识。**自动化覆盖的范围不能比契约本身宽**——否则下次想加个 internal-only 的 `#define ZCC_BUFSIZE 256` 都得同步到 Zonix 那边，反而把契约的边界搞糊涂了。

这条接缝和 Zonix [#14 BootInfo](https://github.com/leafvmaple/blog/issues/14) 那条 bootloader / 内核共享契约的逻辑同源：**只要存在跨边界的常量约定，要么物理上让两边 include 同一个文件，要么给同步过程一个自动化兜底**。这两种之间没有"全靠注释和记性"这个选项。

---

## 4. crt0.S 是契约的"门口"：怎么把 main 的退出码送回内核

`syscall.h` 定义号码，`crt0.S` 定义"main 跑完之后用哪个号回内核、退出码怎么递"。两套架构各一份，但形状一致：

**x86_64** ([`zcc/src/runtime/x64/crt0.S`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/x64/crt0.S))：

```asm
.globl _start
_start:
    xorq    %rbp, %rbp          /* 清栈帧指针，让 backtrace 知道这是栈底 */
    call    main                /* 调用用户的 main —— 返回值落在 %rax */

    movq    %rax, %rdi          /* exit code -> arg0 */
    movq    $1, %rax            /* NR_EXIT = 1 */
    int     $0x80
    hlt                         /* 防御性：sys_exit 不应该返回 */
```

**RISC-V 64** ([`zcc/src/runtime/riscv64/crt0.S`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/riscv64/crt0.S))：

```asm
.globl _start
_start:
    call    main                /* main 返回值已经在 a0 —— riscv64 调用约定 */

    li      a7, 1               /* NR_EXIT = 1 */
    ecall
    j       _start              /* 防御性：不应该到这里 */
```

两件可以说清楚的事：

**(1) `xorq %rbp, %rbp` 不是装饰**。x86_64 的栈展开（backtrace）依赖 `rbp` 链回上一帧。`_start` 是真正的栈底，没有"上一帧"——把 `rbp` 清零让任何 backtrace 工具能识别这里是底（System V ABI 强制要求）。riscv64 没这个问题因为它的栈展开走 DWARF 元信息、不靠 frame pointer 链。

**(2) `NR_EXIT = 1` 这个数字没出现**。两个 crt0 里都是 `$1` / `li a7, 1` 这种**裸字面量**——它**没有 include `syscall.h`**。为什么？因为 `.S` 文件里 include `syscall.h` 需要 `#include` 经过 C preprocessor，而 `crt0.S` 的构建在 zcc 这边走的是 `as` 直接汇编、不过 cpp。一致性靠人审：每次改 `NR_EXIT` 都要记得检查这两个 crt0。

这是个**已知的小漏洞**——理想情况下 `crt0.S` 应该 `#include "syscall.h"` 然后 `movq $NR_EXIT, %rax`，把"1"这个字面量也归到契约里。修这个的代价是改 zcc 的 Makefile 让 `.S` 走 `clang -E` 预处理一遍。当前没修是因为 `NR_EXIT = 1` 不太可能变（它是 Unix v6 以来的传统号），但承认它是一个潜在的漂移点比假装没有强。**该补的地方先记下来**——下次真的有人改 `NR_EXIT` 就会一起补。

---

## 5. linker.ld 把 ELF 钉在 `0x400000`：跟 Zonix 用户地址空间布局对齐

[`zcc/src/runtime/x64/linker.ld`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/x64/linker.ld) 一共 23 行：

```ld
ENTRY(_start)

SECTIONS {
    . = 0x400000;          /* 加载地址 */

    .text   : { *(.text) }
    .rodata : { *(.rodata*) }
    .data   : { *(.data) }
    .bss    : { *(.bss) }
}
```

那个 `0x400000` 不是随便选的。Zonix [`#18 §1`](https://github.com/leafvmaple/blog/issues/18) 把用户地址空间布局成"低半区给用户、高半区给内核（共享映射）"——`0x400000` 是低半区里一个"足够远离 NULL 触发 fault、又远低于用户栈"的位置（同样是 Linux ELF 的传统默认 `0x400000`）。

这意味着 linker.ld 是**又一条跨编译器/OS 的隐性契约**。如果 Zonix 改用户地址布局（比如改成 `0x10000` 起步），linker.ld 必须跟着改，否则 ELF 加载之后 entry 落在了 Zonix 没映射的虚拟地址 → instant page fault。

**这条契约现在没有自动化守住**——是个比 §4 那个 `NR_EXIT = 1` 字面量更大的潜在漏洞。补救可能的方案：

- 在 Zonix 这边导出一个 `USER_LOAD_BASE` 常量到 `include/abi/`，linker.ld 通过 cpp 展开取值。但 linker script 语法不天然支持 `#include`，需要先过 `cpp -P`，工程复杂度上去了。
- 或者把 `0x400000` 也写到 `syscall.h` 里：`#define USER_LOAD_BASE 0x400000`，再扩 `check_syscall_abi_sync.sh` 的正则覆盖它。

目前哪种都没做——因为 Zonix 的用户地址布局自落地以来没变过，把这个加进契约的优先级低于先验证"号码这条契约真的有用"。等真的有动布局的需求时再补。**承认"现在没全自动化"比假装"全部锁住了"诚实**。

---

## 6. 端到端：从 `zcc hello.c` 到内核 `exec()` 跑起来

把这一篇所有的接缝拼起来。一个 `hello.c`：

```c
int main() {
    printf("Hello from zcc on Zonix!\n");
    return 0;
}
```

走完整链路：

```
                                  zcc 这边                              Zonix 这边
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
                                                                        │    含 ZHELLO.ELF)          │
                                                                        │                            │
   $ make qemu                                                          │ qemu boots, kernel mounts  │
                                                                        │ /mnt, exec("/mnt/ZHELLO") ─┼──► [#18] 加载 ELF
                                                                        │                            │       构造用户地址空间
                                                                        │                            │       iretq 降 ring 3
                                                                        │                            │
                                                                        │ ZHELLO 跑起来              │
                                                                        │   ↓                        │
                                                                        │ printf → put_char →        │
                                                                        │ sys_write(1,&c,1) →        │
                                                                        │ movq $4,%rax; int $0x80 ──►│ trap.cpp handle_syscall
                                                                        │                            │ case NR_WRITE: 在内核里
                                                                        │   ↓                        │ 写到 console
                                                                        │ return 0 → _start          │
                                                                        │   ↓                        │
                                                                        │ movq $1,%rax; int $0x80 ──►│ case NR_EXIT: sched::exit
                                                                        └────────────────────────────┘
```

红线串穿三个接缝：

- **数据契约**：`NR_WRITE = 4` 在 zcc 这边的 `syscall.S`、在 Zonix 这边的 `trap.cpp`，通过两份手动同步的 `syscall.h` 守住一致（`check_syscall_abi_sync.sh` 验证）。
- **入口契约**：`crt0._start` 在 ELF 里、`linker.ld` 把 `_start` 钉在 `0x400000`，与 Zonix 用户地址布局对齐。
- **执行契约**：`iretq` / `eret` 自动降 ring 3 由 Zonix [`#18 §3`](https://github.com/leafvmaple/blog/issues/18) 负责；用户态 → 内核的入口在 `trap.cpp` 由 [`#15`](https://github.com/leafvmaple/blog/issues/15) 的 HAL 收。

整条链能跑起来不是因为 zcc 多优秀、Zonix 多完备——是因为三处接缝都被划在了"可验证的最小契约"上：**号码（自动化）、入口地址（约定 + 单一来源）、特权降级（硬件硬约束）**。

---

## 7. 迭代记录

<!-- 后续 ABI / runtime / crt0 / linker 演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-05-23：本子篇首次落地。新增 [`zonix-plus/scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh)（守住 zcc / Zonix 两份 `syscall.h` 同步）+ `user/Makefile` 加 `check-syscall-abi` 前置。把 §4 / §5 里"`NR_EXIT=1` 字面量"、"`0x400000` 加载地址" 两条**已知未自动化覆盖**的契约写下来——补救方案在文里，待真的有改动需求时再做。
- 2026-04-08：[`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b)（zcc）+ [`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)（Zonix）同时把 `syscall.h` 提取成独立的 ABI 头文件、确立"两份物理文件、一份逻辑契约"的形态。在此之前 zcc 的 runtime 是把号码硬编码在 `printf.c` 和 `syscall.S` 里、Zonix 这边在 `trap.cpp` 里硬编码——任何一方写错只能靠跑起来发现。
- 2026-03-13：[`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5) 给 zcc 加 freestanding runtime（`crt0.S` / `syscall.S` / `linker.ld` / `printf.c`），`-x64` 输出能被 Zonix `exec()` 直接加载的 ELF。这是 zcc 第一次从"教学编译器"变成"自家工具链"的物理变化。

---

*仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc) + [leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [zcc 系列](https://github.com/leafvmaple/blog/issues/20)。*
