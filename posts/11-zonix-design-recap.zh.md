# Zonix：从零开始的多 ISA 操作系统内核

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 提交跨度：2026-01-28 → 2026-05-22，91 次提交，当前 v0.11.x "Genesis"
> 体量：~24,000 行 C++17 freestanding + 汇编，Clang/LLD/LLVM 工具链，**x86_64 / aarch64 / riscv64 三架构**
> 能力：BIOS + UEFI 双引导、四级页表 + 缺页 + swap、抢占式优先级调度、fork/exit/wait 进程生命周期、Spinlock/WaitQueue/Semaphore/Mutex、VFS + FAT32 读写、AHCI/IDE/PCI 驱动、**用户态 ELF 执行 + 系统调用**

这一篇是 Zonix OS 的**主索引帖**。串起整套内核骨架的三条工程决策——HAL 接缝、表驱动 init、`Result<T>` 错误处理——分别放在 §1 / §2 / §3，每个子系统的深读拆成独立文章（见 §4 系列文章）。

正文之前，先列一下项目的指标。数据截止 2026-05-22：

| 指标 | 数值 | 含义 |
|---|---|---|
| 提交数 | **91** | 跨度 2026-01-28 → 2026-05-22 |
| `kernel/` + `include/` C++ 行数 | **12,794** | 架构无关，三套 ISA 共用同一份 |
| `arch/` C++ + 汇编行数 | **10,723** | x86 + aarch64 + riscv64 三份并列实现，外加 BIOS + UEFI 两个独立 loader |
| `kernel/` 里裸特权指令计数 | **0** | "裸特权指令"指 `inb` / `outb` / `lcr3` / `sti` / `cli` / `hlt` / `invlpg` / `wbinvd` / `lgdt` / `lidt` 等直接访问硬件的指令 |
| `arch/` 里同类指令计数 | **51** | 集中在 8 个文件：`head.S` / `io.h` / `arch.h` / `cpu.h` 加上 BIOS boot 四件套 |
| 每架构 `arch_*()` HAL 函数数 | **32 / 33 / 34** | x86 / aarch64 / riscv64 各自的 `arch/<isa>/include/asm/arch.h` 里 `arch_xxx()` 的声明，差异 ±1 |

两条要单独说一句：

- `kernel/` 那 0 不是 lint 规则强制的——它从 [`dbaa726`](https://github.com/leafvmaple/zonix-plus/commit/dbaa726) 之后被一个简单约定守住：**所有摸硬件的动作都必须穿过 `arch/<isa>/include/asm/arch.h` 里那组 `arch_*()` 函数**。这条规矩把 51 条裸特权指令限制在 `arch/` 的 8 个文件里。
- 三个架构 32/33/34 的近一对一对称，是这套约定真正成立的物证。如果它是个漏的抽象，移植新架构（最近一个是 riscv64 [`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311)）一定会需要某个"x86 上不存在、aarch64 上也不存在、专为 riscv64 长出来"的奇怪函数；实际并没有。

下面三条决策解释这套约定能从单 x86_64 port 撑到三套 ISA 的原因。

## 目录

- [0. 设计约束](#sec-0)
- [1. 第一个决定：内核核心必须架构无关 (`dbaa726`)](#sec-1)
- [2. 第二个决定：初始化顺序是数据，不是代码 (`6ae17b5`)](#sec-2)
- [3. 第三个决定：内核里也要有现代 C++ 的错误处理 (`ff916fa`)](#sec-3)
- [4. 系列文章](#sec-4)
- [5. 三 ISA 落地之后还成立的几条事实](#sec-5)

---

<a id="sec-0"></a>
## 0. 设计约束

Zonix 的目标不是"做一个能用的 OS"，是把内核里几套最经典的机制 —— 引导、虚拟内存、调度、同步、文件系统 —— 在真实硬件抽象（QEMU + OVMF/EDK2）上一个一个长出来，并且每一个都要能在**多于一个 CPU 架构**上跑。

最后这条是关键约束。单架构内核非常容易写出一堆"看起来通用、其实全是 x86 假设"的代码 —— `outb 0x20` 写成"通知中断结束"、`mov %rax, %cr3` 写成"换地址空间"、`pause` 写成"自旋时给 CPU 一个让步信号"。这三件事在 aarch64 上对应 `msr ICC_EOIR1_EL1`、`msr TTBR0_EL1`、`yield`；在 riscv64 上对应 `csrw sip`（实际走 PLIC `claim/complete` MMIO）、`csrw satp`、`pause`（Zihintpause 扩展，否则退化为 nop）。这种细节差异渗透在所有摸硬件的代码里。

**第二个架构是检验抽象的唯一标准**。下面三条决策是支撑"同一份 `kernel/` 跑在三套 ISA 上"这件事的最关键三处接缝。

---

<a id="sec-1"></a>
## 1. 第一个决定：内核核心必须架构无关 (`dbaa726`)

整个 `kernel/` 目录（调度、内存、文件系统、同步、shell）**不允许出现任何一条 `inb`、`lcr3`、`sti`**。所有摸硬件的动作都收敛到一组 `arch_*()` 函数后面：

```cpp
// arch/x86/include/asm/arch.h — 每个架构提供一份实现
static inline void     arch_load_cr3(uintptr_t cr3);   // x86: mov %rax,%cr3 / aarch64: msr ttbr0_el1
static inline uint64_t arch_irq_save(void);            // 保存并关中断，返回旧状态
static inline void     arch_irq_restore(uint64_t f);   // 恢复中断状态
static inline void     arch_spin_hint(void);           // x86: pause / aarch64: yield
void                   arch_switch_rsp0(uintptr_t sp); // 切换内核栈指针 (x86 走 TSS)
void                   arch_setup_kthread_tf(TrapFrame*, ...);  // 构造内核线程的初始陷阱帧
```

调度器里那行 `arch_load_cr3(next_cr3)` 在 x86 上是写 CR3，在 aarch64 上是写 `TTBR0_EL1`，在 riscv64 上是写 `satp` —— **调度器一个字都不用知道**。这就是 [#15 多架构抽象](https://github.com/leafvmaple/blog/issues/15) 整篇要讲的接缝。

这个决定的回报在 [`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311)（riscv64 port）那天兑现：加第三个架构时，`kernel/` 核心几乎没动，新增代码集中在 `arch/riscv64/` 提供那一组 32~34 个 `arch_*()` 实现和引导汇编。

---

<a id="sec-2"></a>
## 2. 第二个决定：初始化顺序是数据，不是代码 (`6ae17b5`)

内核启动是一长串有严格依赖的步骤：中断控制器要在开中断前初始化、页分配器要在虚拟内存前、块设备要在 swap 前、调度器最后。最朴素的写法是在 `kern_init()` 里一行行 `xxx_init()` 调下去 —— 但这样**顺序、错误处理、日志全部硬编码在控制流里**，而且每个架构的早期步骤还不一样（x86 要初始化 i8259/i8253，aarch64 不要）。

Zonix 把初始化做成了一张**表**：

```cpp
struct InitStep {
    const char* name;
    int (*fn)();
    bool        required;   // 失败时是 halt 还是继续降级运行
};

static const InitStep KERN_STEPS[] = {
    {"early_init", early_init, true},   // 架构相关步骤（见下）
    {"pmm",        pmm::init,  true},
    {"vmm",        vmm::init,  true},
    {"vfs",        vfs::init,  true},
    {"pci_init",   pci::init,  false},  // 没有 PCI 也能跑
    {"blk",        blk::init,  true},
    {"swap",       swap::init, false},  // 没有 swap 设备就禁用
    {"sched",      sched::init,true},
};
```

而**架构相关的早期步骤由各架构自己提供一张子表**，主流程通过 `arch_early_steps()` 拿到它：

```cpp
// arch/x86/kernel/arch_init.cpp
const InitStep ARCH_STEPS[] = {
    {"i8259", i8259::init, true},   // 8259 PIC —— aarch64/riscv64 这张表里根本没有这一项
    {"i8253", i8253::init, true},
    {"idt",   idt::init,   true},
    {"tss",   tss::init,   true},
};
```

`run_steps()` 统一遍历：打印对齐的 `[OK]`/`[FAIL]`、`required` 失败就 `arch_halt()`、非必需失败就降级继续。**新增一个子系统 = 表里加一行**，顺序一目了然，错误处理一处搞定，每个架构的差异锁在自己的子表里——这条路径和 mini-cocos 渲染队列的 64-bit sortKey、Action 系统的归一化时间 `t` 同源：**把有序/依赖/错误处理表达成数据，而不是写进控制流**。

---

<a id="sec-3"></a>
## 3. 第三个决定：内核里也要有现代 C++ 的错误处理 (`ff916fa` → `b1ea334`)

内核早期我用的是 Linux 风格的 `int` 返回码（0 成功，负数 errno）。问题是它**没有类型安全**：函数返回的到底是"错误码"还是"个数"还是"fd"？全靠注释和记性。一个 `if (ret)` 写成 `if (!ret)` 编译器一声不吭。

`ff916fa` 引入了一套 `Result<T>` + `Error` 枚举 + `TRY` 宏，`b1ea334` 把全内核的 `int` 返回值迁了过去：

```cpp
enum class Error : int { None = 0, IO = -1, NoMem = -2, NotFound = -4, /* ... */ };

template<typename T>
class [[nodiscard]] Result {        // [[nodiscard]] —— 忘记检查会编译警告
    T     val_{};
    Error err_{Error::None};
    bool  ok_{false};
public:
    Result(const T& v) : val_(v), ok_(true) {}   // 成功：从 T 隐式构造
    Result(Error e)    : err_(e)  {}              // 失败：从 Error 隐式构造
    bool  ok() const;
    T&    value();
    Error error() const;
};
```

配套的 `TRY` 宏用 GCC/Clang 的语句表达式（statement expression）实现了类 Rust 的 `?` 早返回：

```cpp
#define TRY(expr) __extension__({                   \
    auto _r = ::detail::wrap_tryable(expr);         \
    if (!_r.ok()) [[unlikely]] return _r.release_error();  \
    _r.release_value();                             \
})

// 用起来：
Result<int> fd = TRY(files.alloc(file));   // 出错直接 return Error，成功拿到 int
```

`wrap_tryable` 重载让 `TRY` 同时吃 `Result<T>`（解包出 `T`）和裸 `Error`（无值，纯传播）。这套东西的细节、为什么不用 C++ 异常（freestanding 没有 unwinding 运行时、`-fno-exceptions`）、`[[nodiscard]]` 在内核里的价值，放在 [#17 freestanding C++ 内核](https://github.com/leafvmaple/blog/issues/17) 详谈。

---

<a id="sec-4"></a>
## 4. 系列文章

把内核里最有技术含量的几个子系统分别展开成独立文章。建议先读完这一篇骨架，再按兴趣点开任何一篇深读 —— 它们之间会互相引用，但每一篇都可独立读。

| # | 主题 | 一句话内容 |
|---|---|---|
| [#12](https://github.com/leafvmaple/blog/issues/12) | 上下文切换 + 抢占式调度 | 一个被 Clang epilogue 暴露、被 GCC `leave;ret` 掩盖了几个月的 `switch_to` RSP off-by-8 bug；以及 forkret/trapret 的栈帧伪造术 |
| [#13](https://github.com/leafvmaple/blog/issues/13) | 虚拟内存 + 缺页 + swap | 用 PTE 的 present 位区分"未映射 / 已换出"，把换出页号直接编码进 PTE；FIFO 替换 + 反向扫页表找 victim 的虚拟地址 |
| [#14](https://github.com/leafvmaple/blog/issues/14) | 引导链 + boot_info 统一协议 | MBR→VBR→bootloader→long mode 的接力，BIOS/UEFI 双路径如何收敛到同一个 `BootInfo`；`head.S` 里恒等映射 + 高半区双映射的"换页表换栈"魔法 |
| [#15](https://github.com/leafvmaple/blog/issues/15) | 多架构抽象 | `arch_*()` HAL、表驱动 init、`asm/` include 命名空间，如何让同一份 `kernel/` 在 x86_64 / aarch64 / riscv64 上跑 |
| [#16](https://github.com/leafvmaple/blog/issues/16) | 同步原语栈 | Spinlock（关中断 + TAS）→ WaitQueue（侵入式链表）→ Semaphore / Mutex；单核内核为什么还需要 spinlock，以及 lost-wakeup 的防范 |
| [#17](https://github.com/leafvmaple/blog/issues/17) | freestanding C++ 内核 | 全局 `new`/`delete` 走 kmalloc、`.init_array` 跑全局构造、`cxxrt` 运行时桩、`Result<T>`/`TRY`、GCC→Clang/LLD 工具链迁移 |
| [#18](https://github.com/leafvmaple/blog/issues/18) | 用户态 ELF 执行 + 系统调用 | 把不可信 ELF 请进 ring 3：用户地址空间（共享高半区内核映射）、ELF 加载的两条安全线、复用 #12 的 `trapret` 靠 `iretq` 降权、syscall ABI 单一真相源、"永不相信用户指针"的信任边界 |
| [#20](https://github.com/leafvmaple/blog/issues/20) **(配套工具链)** | zcc：编出来跑在 Zonix 上的 ELF 的 C 编译器 | 3,100 行 C++ 实现 SysY/C0 子集前端 + LLVM IR 后端 + 自带 freestanding runtime（`crt0`/`linker.ld`/`libzccrt.a`），与 Zonix 共享一份 `syscall.h` 完成体系闭环。**zcc 是独立仓库、独立子系列**，子篇 #21（ABI 接缝）/#22（LLVM codegen）/#23（C0 演进） |

---

<a id="sec-5"></a>
## 5. 三 ISA 落地之后还成立的几条事实

下面这几条放在这里，是因为它们**在写主帖第一版时还是猜测、写到这里已经被三套 ISA 各自反例过一遍**。

1. **`kernel/` 里裸特权指令为 0，`arch/` 下是 51，集中在 8 个文件**（`head.S` / `io.h` / `arch.h` / `cpu.h` 加 BIOS boot 四件套）。这两个数字一起才是 HAL 接缝真正划在那里的物证 —— 不是 lint 强制的，是每次重构都自觉收敛的结果（详见 [#15](https://github.com/leafvmaple/blog/issues/15)）。

2. **GCC → Clang 是一次免费的 fuzzing**。`switch_to` 的 RSP off-by-8 在 GCC 的 `leave;ret` epilogue 下安静了三个月，[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c) 切到 Clang/LLD/LLVM 当晚立刻 triple fault。同一次工具链迁移还顺手暴露了未实现的 `__cxa_*` 桩、UEFI loader 的 RWX segment 违规、若干 `-Winline-new-delete` 告警 —— 一个编译器把另一个编译器的隐性假设照亮（详见 [#12](https://github.com/leafvmaple/blog/issues/12) §2 与 [#17](https://github.com/leafvmaple/blog/issues/17)）。

3. **swap 子系统没有 `<va, swap_slot>` 反查表**。`kernel/mm/swap.cpp` + `swap_fifo.cpp` 共 273 行，里面没有一处 map / array 维护"哪个虚拟地址被换到了哪个槽"，因为 swap entry 就是 `(slot << 8)` 直接写回 PTE：硬件看 present=0 触发 fault，软件看 PTE 的高位拿回槽号。同一种 trick 在 Linux 的 [`include/linux/swapops.h`](https://github.com/torvalds/linux/blob/master/include/linux/swapops.h) 里也是这么做，只是 Linux 在低位多塞了几个 bit 给 swap type（详见 [#13](https://github.com/leafvmaple/blog/issues/13)）。

4. **换页表的同一拍栈也得换**。CR3 一写下去，旧栈的虚拟地址若不在新页表里就立刻失效。BIOS 路径恰巧栈在低 1MB 物理地址、新旧页表都恒等映射所以踩不到雷；UEFI 路径上栈在固件给的高地址，必须在写 CR3 前把栈挪进双映射区，否则下一条 `push %rbp` 就 page fault（详见 [#14](https://github.com/leafvmaple/blog/issues/14)）。

5. **`Spinlock::acquire` 的第一步是关中断，第二步才是 TAS**。单核上前者就已经够了，后者是为 SMP 准备的"死代码"。但调用方 `LockGuard<Spinlock>` 的 11 处 production 使用，从单核搬到多核时不需要改一个字 —— 改的是 `Spinlock` 内部的 TAS 实现（详见 [#16](https://github.com/leafvmaple/blog/issues/16)）。

6. **`Result<T>` + `TRY` 的运行时开销几乎为 0**。`Result<T>` 是带 `[[nodiscard]]` 的 POD、`TRY` 是宏 + 语句表达式而非 lambda、`Error` 是 `enum class : int`。三者合起来：成功路径相比裸 `int` 多一次寄存器加载（ok 标志），失败路径多一次条件分支。代价换回的是 [`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) 之前"`if (ret)` 写成 `if (!ret)`"这类 silent 错误码 bug 在编译期被 `-Wunused-result` 直接打掉（详见 [#17](https://github.com/leafvmaple/blog/issues/17)）。

7. **自举链的物证是一份 6 行的 `syscall.h`，不是 zcc 的 1,500 行 codegen**。zcc 编出来的 ELF 能被 Zonix `exec()` 加载并跑通 `printf("Hello\n")` 这条链路，唯一**会跨边界漂移**的常量约定是 6 个系统调用号——它们由 zcc 仓库 `src/runtime/syscall.h` 和 Zonix 仓库 `include/abi/syscall.h` 各保留一份物理拷贝，号码同形，由 [`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh) 在 `make user` 时自动验证两边一致。**两份物理文件、一份逻辑契约、自动化兜底**——这条接缝的诚实复盘（包括 crt0 里 `NR_EXIT = 1` 字面量没进契约这种当前未自动化覆盖的细节）放在 [#21](https://github.com/leafvmaple/blog/issues/21)。

> **2026-05 更新**：上一版这里写"接下来想尝试跑一个真正的用户态 ELF"，现在它落地了。`exec` 子系统能把磁盘上一个不可信的 ELF 请进隔离地址空间、降到 ring 3 跑起来，并通过系统调用回到内核（→ 新增子篇 [#18](https://github.com/leafvmaple/blog/issues/18)）。配套的**自研 C 编译器 zcc**（独立仓库，作为子模块）也从"另一个大坑"独立成了完整子系列 [#20](https://github.com/leafvmaple/blog/issues/20)——内核 + 编译器构成了"自己的编译器编译跑在自己内核上的程序"的雏形自举链。下一步：调度器抢占全链路验证、riscv64 PLIC 补齐、zcc 的 C 子集扩到能编 busybox 子集。

---

## 迭代记录

<!-- 本主帖是索引 + 元经验帖，不沉淀具体子系统结论。子系统级演进追加到对应子篇；
     跨子系统的结构变更（新增架构、改 init 流程）在这里追加一句索引。 -->

- 2026-05-23：配套工具链 **zcc** 从 [#18 §6](https://github.com/leafvmaple/blog/issues/18) 的一笔带过独立成完整子系列：主索引帖 [#20](https://github.com/leafvmaple/blog/issues/20) + 子篇 [#21](https://github.com/leafvmaple/blog/issues/21) ABI 接缝 / [#22](https://github.com/leafvmaple/blog/issues/22) LLVM codegen / [#23](https://github.com/leafvmaple/blog/issues/23) C0 演进。同时新增 [`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh) + `user/Makefile` 钩子，自动验证 zcc / Zonix 两份 `syscall.h` 同步（见 §5 第 7 条 + [#21 §3](https://github.com/leafvmaple/blog/issues/21)）。
- 2026-05-22：新增正交子系统 **用户态 ELF 执行 + 系统调用**，开子篇 [#18](https://github.com/leafvmaple/blog/issues/18)。这是项目从"只跑内核线程"到"能跑不可信用户进程"的质变（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) exec、[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) syscall ABI、[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) 接入 zcc 编译器子模块）。它兑现了 [#12](https://github.com/leafvmaple/blog/issues/12) 当初为内核线程划好的 `arch_setup_user_tf` / `trapret` 接缝——加用户态时这条路径一行没改。
- 2026-04-07：[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311) 加入 **riscv64** 第三个架构，[`5b32167`](https://github.com/leafvmaple/zonix-plus/commit/5b32167) 补板级抽象。这是对 [#15](https://github.com/leafvmaple/blog/issues/15) 所述 HAL 接缝的又一次验证：`kernel/` 核心几乎零改动。
- 2026-04-07：[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa) / [`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) 全内核错误处理从 `int` 返回码迁移到 `Result<T>` + `TRY`（见 §3 与 [#17](https://github.com/leafvmaple/blog/issues/17)）。这是跨子系统的横切变更，对每个子篇的具体影响写在各自迭代记录里。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。*
