<!--pub:2025-05-20-->
# 第二个架构会引爆 `kernel/` 里每一条裸 `inb`

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`arch/*/include/asm/arch.h` / `arch/*/kernel/arch_init.cpp` / `kernel/init.cpp` / 全局 `arch/` 布局

`kernel/` 目录里**不允许出现一条 `inb`、`lcr3`、`sti`** —— 所有摸硬件的动作收敛到三套对称的 `arch_*()` HAL 后面：

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

三个架构 32 / 33 / 34 个函数，差异 ±1。三套指令集的内存模型、特权级、中断控制器、引导方式全不一样，但内核核心同一份代码跑在三套上。这一篇讲这个接缝怎么划：哪些能在编译期消失（`static inline` 一条指令），哪些只能每架构各写一份函数定义，哪些抽象不掉只能用表驱动数据来收。

---

## 1. 接缝的三层：能内联的、不能内联的、抽象不掉的

`arch_*()` HAL（[`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) / [`1941793`](https://github.com/leafvmaple/zonix-plus/commit/1941793) 引入）不是一刀切的"封装层"，它按"能否在编译期消失"分成三层：

**第一层：能内联成单条指令的——做成 `static inline`。** 这些是纯粹的指令包装，零开销：

```cpp
// arch/x86/include/asm/arch.h
static inline void     arch_load_cr3(uintptr_t cr3) { lcr3(cr3); }      // → mov %rax,%cr3
static inline uint64_t arch_irq_save(void)          { return read_eflags(); }
static inline void     arch_irq_disable(void)       { cli(); }
static inline void     arch_spin_hint(void)         { __asm__ volatile("pause"); }
static inline uintptr_t arch_fault_addr(void)       { return rcr2(); }   // 缺页地址在 CR2
```

aarch64 那份头文件里，`arch_load_cr3` 是 `msr ttbr0_el1, x0`，`arch_spin_hint` 是 `yield`，`arch_fault_addr` 读 `FAR_EL1`。**调用方一个字不改**，因为它只写 `arch_load_cr3(cr3)`，编译期就根据 `-I arch/<ARCH>/include` 选到了对应那份头文件，inline 之后连函数调用都没有。

**第二层：需要访问架构私有状态、没法内联的——声明在 `arch.h`，定义在各架构的 `arch_init.cpp`。** 比如切换中断返回用的内核栈：

```cpp
void arch_switch_rsp0(uintptr_t rsp0);   // x86: tss::set_rsp0()  —— 要摸 TSS
void arch_irq_eoi(int irq);              // x86: i8259::send_eoi() —— 要摸 PIC
void arch_setup_kthread_tf(TrapFrame*, uintptr_t entry, uintptr_t fn, uintptr_t arg);
```

`arch_switch_rsp0` 在 x86 上要写 TSS 的 `rsp0` 字段，这是个有具体硬件结构的东西，没法内联；aarch64 上压根没有 TSS 这个概念，它的实现是另一回事。把声明摆在公共 `arch.h`、定义留给各架构，调用方（调度器）依旧只看到一个函数名。

**第三层：抽象不掉的——引导汇编、中断入口、上下文切换。** `head.S`、`trapentry.S`、`switch.S`、`vectors.S` 这些**本质上就是架构专属**，没有任何"通用写法"。它们老老实实地一个架构一份，住在 `arch/<ARCH>/kernel/` 里。诚实地承认"这部分抽象不掉"，比硬造一个漏洞百出的伪抽象要好得多。

> 关键判断：**抽象的目标不是消灭差异，是隔离差异。** 第三层那些汇编文件的存在不代表抽象失败——只要它们被严格关在 `arch/` 里、`kernel/` 永远碰不到它们，接缝就是干净的。失败的抽象长的是另一个样：`kernel/` 里散落着 `#ifdef __x86_64__`。Zonix 的 `kernel/` 目录里**没有一处 `#ifdef <架构>`**，所有架构分支都被推到了 `arch/` 边界之外。

---

## 2. `<asm/...>` 命名空间：同一行 include，不同的物理头文件

接缝在源码层面的体现，是一个借鉴 Linux 的 include 约定（[`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) 统一）。`kernel/` 里所有架构相关的引用都写成：

```cpp
#include <asm/arch.h>     // 不是 "x86/arch.h"，是中性的 <asm/...>
#include <asm/page.h>
#include <asm/mmu.h>
```

而构建系统按目标架构把 `-I` 指向不同的物理目录：

```makefile
# 构建 x86 时
-I arch/x86/include       # <asm/...> → arch/x86/include/asm/...
# 构建 aarch64 时
-I arch/aarch64/include   # <asm/...> → arch/aarch64/include/asm/...
```

于是 `kernel/mm/vmm.cpp` 里那行 `#include <asm/page.h>`，在 x86 构建里拿到的是 x86 的页表位定义，在 aarch64 构建里拿到的是 aarch64 的——**同一行源码，编译期解析到不同文件**。这比在一个头文件里堆 `#ifdef` 干净得多：每个架构的 `asm/page.h` 是一份完整、自洽、可以独立阅读的定义，而不是被预处理指令切成碎片的拼盘。

整个仓库的目录布局也按这个原则组织（[`a92a814`](https://github.com/leafvmaple/zonix-plus/commit/a92a814) 改成 Linux 风格的 `arch/` 布局）：

```
arch/
  x86/      { boot/ include/asm/ kernel/{head.S,switch.S,idt.cpp,...} }
  aarch64/  { boot/ include/asm/ kernel/{head.S,...} }
  riscv64/  { ... }
kernel/     # 架构无关：sched/ mm/ fs/ sync/ cons/ drivers/ —— 零 #ifdef
include/    # 架构无关公共头：base/ kernel/ uefi/
```

新增一个架构 = 新增一个 `arch/<新架构>/` 子树，提供那一份 `asm/` 头文件 + 引导汇编 + `arch_*()` 实现。`kernel/` 完全不动。

---

## 3. 表驱动 init：架构差异连"初始化哪些设备"都收进了数据

[#11 主帖](https://github.com/leafvmaple/blog/issues/11) 里提过初始化用一张 `InitStep` 表。这张表的多架构价值在这里才完全展开：**不同架构要初始化的早期设备根本不是同一批**。x86 要初始化 8259 PIC 和 8253 PIT；aarch64 用的是 GIC + generic timer，根本没有 8259 这东西。

解法是：**通用的初始化步骤写在 `kernel/init.cpp` 的公共表里，架构私有的步骤由各架构提供一张子表**，主流程通过 `arch_early_steps()` 在运行期把它取来：

```cpp
// kernel/init.cpp —— 架构无关，三个架构共用这一份
static const InitStep KERN_STEPS[] = {
    {"early_init", early_init, true},   // ← 这一步内部去调 arch_early_steps()
    {"pmm", pmm::init, true}, {"vmm", vmm::init, true}, {"vfs", vfs::init, true},
    {"blk", blk::init, true}, {"swap", swap::init, false}, {"sched", sched::init, true},
};

static int early_init() {
    size_t n = 0;
    const InitStep* steps = arch_early_steps(&n);   // 各架构各给一张
    run_steps(steps, n);
    return 0;
}
```

```cpp
// arch/x86/kernel/arch_init.cpp —— 只有 x86 有这张
const InitStep ARCH_STEPS[] = {
    {"i8259", i8259::init, true},   // aarch64 的 arch_init.cpp 里这张表是 GIC，没有这一项
    {"i8253", i8253::init, true},
    {"idt",   idt::init,   true},
    {"tss",   tss::init,   true},
};
const InitStep* arch_early_steps(size_t* count) { *count = array_size(ARCH_STEPS); return ARCH_STEPS; }
```

`run_steps()` 是公共的遍历器，统一打印 `[OK]`/`[FAIL]`、按 `required` 决定失败时 halt 还是降级。**"x86 比 aarch64 多初始化两个 8250 时代的芯片"这个差异，没有变成一行 `#ifdef`，而是变成两张数据表的内容差异。** 这是把架构分支"数据化"的典范——和 [#13](https://github.com/leafvmaple/blog/issues/13) 里把"分配还是换回"的判据藏进 PTE 值是同一种思路。

PCI 设备探测也走同一套（`arch_pci_steps`）：x86 把 AHCI 注册进去，aarch64 注册 SDHCI + virtio。块设备层（[`6ae17b5`](https://github.com/leafvmaple/zonix-plus/commit/6ae17b5) 集中早期 init、[`aa54209`](https://github.com/leafvmaple/zonix-plus/commit/aa54209) 把平台驱动按设备名挪进 `arch/`）于是对上层呈现统一的 `BlockDevice` 接口，swap 和文件系统不知道自己底下到底是 SATA 盘还是 SD 卡。

---

## 4. 三个架构怎么解决"同一个问题"

抽象划得好不好，看的是面对同一个底层难题时，三个架构的解法能否被统一接缝吸收。举几个真实的例子：

| 问题 | x86_64 | aarch64 | riscv64 |
|---|---|---|---|
| 高半区映射 | 软件约定：PML4[511] 指向高地址，链接脚本配合 | 硬件支持：**TTBR0/TTBR1 双页表基址寄存器**，高位地址自动走 TTBR1 | `satp` + Sv39/Sv48 |
| 切地址空间 | 写 `CR3` | 写 `TTBR0_EL1` | 写 `satp` |
| 缺页地址 | `CR2` | `FAR_EL1` | `stval` |
| 引导固件 | BIOS + UEFI 双路径 | UEFI（QEMU virt，EL1） | SBI / 板级 |
| 串口 | 16550 COM1 | PL011 UART | SBI console / UART |
| 引导期符号重定位 | `REALLOC` 宏（虚拟地址 - KERNEL_BASE） | `adrp/adr` PC 相对寻址 | PC 相对 |
| 系统调用陷入指令 | `int $0x80` | `svc #0` | `ecall` |
| ELF 机器类型校验 | `EM_CURRENT` = 0x3E | `EM_CURRENT` = 0xB7 | `EM_CURRENT` = 0xF3 |

最有意思的是高半区映射这一行。x86 上"内核在高地址"是一个**软件约定**——你得手工在 PML4 最后一项埋好映射、链接脚本里把内核链到 `0xFFFFFFFF80000000`（详见 [#14](https://github.com/leafvmaple/blog/issues/14)）。而 aarch64 把这件事**做进了硬件**：它有两个页表基址寄存器，`TTBR0_EL1` 管低地址、`TTBR1_EL1` 管高地址，高位全 1 的地址自动走 TTBR1。同一个"用户/内核地址空间分离"的需求，x86 用软件凑、aarch64 有硬件原生支持——但在 `arch_load_cr3()` / `arch_fault_addr()` 这层接缝之上，**调度器和缺页处理器看到的是同一套语义**，完全不知道底下一个是软件约定、一个是硬件寄存器。

这张表是"第二个、第三个实现检验抽象"的最好证据。只有 x86 时很容易把 `CR2`、`CR3` 这些名字直接写进通用代码，自我感觉"反正都是页表嘛"；aarch64 的 `FAR_EL1`/`TTBR` 和 riscv64 的 `stval`/`satp` 逼着把它们抽象成 `arch_fault_addr()`/`arch_load_cr3()`。第二个架构是免费的设计 review，第三个架构是免费的回归测试 —— 加 riscv64（[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311)）那天，凡是真接缝都一次到位，凡是当初偷懒留的 x86 假设都立刻报错。

---

## 5. 一个细节：连 `memcpy` 都分了架构最优实现

抽象做到位之后，还能反过来给每个架构留性能后门。`arch_memcpy`/`arch_memset` 不是简单的逐字节循环，x86 上它用 `rep movsq`/`rep stosq` 按 8 字节块猛拷：

```cpp
static inline void* arch_memcpy(void* dst, const void* src, size_t n) {
    auto* d = (char*)dst; auto* s = (const char*)src;
    size_t qwords = n / 8;
    if (qwords) __asm__ volatile("rep movsq" : "+D"(d),"+S"(s),"+c"(qwords) :: "memory");
    n &= 7;
    while (n--) *d++ = *s++;   // 尾部不足 8 字节的逐字节收尾
    return dst;
}
```

而内核里所有 `memcpy` 调用（包括 Clang 在结构体赋值时偷偷插入的那些，见 [#17](https://github.com/leafvmaple/blog/issues/17)）最终都打到 `arch_memcpy`。这就是分层接缝的复利：上层只管调 `memcpy`，下层每个架构可以用自己最快的指令实现它，互不打扰。aarch64 可以换成带 `dc zva`（cache line 清零）的版本，调用方依旧零感知。

---

## 6. 迭代记录

<!-- 后续多架构 / HAL 的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-04-08：用户态执行落地，给 §4 的"同一问题三种解"表又添了两行 —— **系统调用陷入指令**（`int $0x80` / `svc #0` / `ecall`，[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）和 **ELF 机器类型校验**（`EM_CURRENT` 编译期解析，[`67608c2`](https://github.com/leafvmaple/zonix-plus/commit/67608c2)）。`handle_syscall` 通过 `tf->syscall_nr()`/`syscall_arg()` 访问器保持架构无关。完整链路见 [#18](https://github.com/leafvmaple/blog/issues/18)。
- 2026-04-02：[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311) 加入 **riscv64** 第三个架构，[`5b32167`](https://github.com/leafvmaple/zonix-plus/commit/5b32167) 补板级抽象并顺手重构 VFS 目录接口。这是对本文所述接缝的终极验证：`kernel/` 核心几乎零改动。
- 2026-03-16：[`aa54209`](https://github.com/leafvmaple/zonix-plus/commit/aa54209) 把平台驱动挪进 `arch/` 并按设备名重命名；[`bb4986e`](https://github.com/leafvmaple/zonix-plus/commit/bb4986e) 按架构拆分 Makefile、隔离输出目录（见 §3）。
- 2026-03-15：[`6ae17b5`](https://github.com/leafvmaple/zonix-plus/commit/6ae17b5) 集中早期 init 并按架构解耦块驱动。
- 2026-03-13：[`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) 引入 arch 抽象层并统一 `asm/` include 命名空间（见 §1/§2）；[`04372ef`](https://github.com/leafvmaple/zonix-plus/commit/04372ef) 引入可移植的 `VM_*` 页表标志位、搭起 aarch64 骨架（见 §4）。
- 2026-03-04：[`a92a814`](https://github.com/leafvmaple/zonix-plus/commit/a92a814) 采用 Linux 风格 `arch/` 目录布局。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
