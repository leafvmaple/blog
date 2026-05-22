# 从 BIOS 到三架构内核：Zonix OS 的设计复盘

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 提交跨度：2026-01-28 → 2026-05-22，91 次提交，当前 v0.11.x "Genesis"
> 体量：~24,000 行 C++17 freestanding + 汇编，Clang/LLD/LLVM 工具链，**x86_64 / aarch64 / riscv64 三架构**
> 能力：BIOS + UEFI 双引导、四级页表 + 缺页 + swap、抢占式优先级调度、fork/exit/wait 进程生命周期、Spinlock/WaitQueue/Semaphore/Mutex、VFS + FAT32 读写、AHCI/IDE/PCI 驱动、**用户态 ELF 执行 + 系统调用**

这一篇是 Zonix OS 的**主索引帖**。和我之前写的 [mini-cocos 系列](https://github.com/leafvmaple/blog/issues/2) 一样，每个子系统的深读拆成了独立文章（见文末"系列文章"），这里只保留串起整套内核的骨架，以及几条贯穿全局的工程决策。

如果说 mini-cocos 是"在别人替我做过的取舍上再做一遍"，那 Zonix 是另一种训练：**没有 libc、没有 std、没有操作系统兜底**，每一个抽象都要从"CPU 上电后的第一条指令"长出来。引擎崩了是一帧黑屏；内核崩了是 triple fault 重启，连一行日志都不一定留下。这种环境逼出来的工程纪律，和应用层完全是两个量级。

## 目录

- [0. 为什么要从零写一个内核](#sec-0)
- [1. 第一个决定：内核核心必须架构无关 (`dbaa726`)](#sec-1)
- [2. 第二个决定：初始化顺序是数据，不是代码 (`6ae17b5`)](#sec-2)
- [3. 第三个决定：内核里也要有现代 C++ 的错误处理 (`ff916fa`)](#sec-3)
- [4. 系列文章](#sec-4)
- [5. 复盘：三架构 + 24k 行，到底学到了什么](#sec-5)

---

<a id="sec-0"></a>
## 0. 为什么要从零写一个内核

我在游戏行业做 Gameplay / 引擎十年，平时离硬件最近的地方也就是 RHI 那一层。再往下 —— 页表、上下文切换、中断向量、DMA —— 对我一直是"知道概念，没亲手写过"的黑盒。读 *Understanding the Linux Kernel*、读 xv6、读 OSDev wiki，和**自己让一台（虚拟）机器从上电跑到 shell 提示符**，是两种完全不同的理解。

所以 Zonix 的目标从一开始就不是"做一个能用的 OS"，而是把内核里那几套最经典的机制 —— 引导、虚拟内存、调度、同步、文件系统 —— 在**真实硬件抽象（QEMU + OVMF/EDK2）**上一个一个长出来，并且**每一个都要能在多于一个 CPU 架构上跑**。最后一条是关键约束：单架构的内核很容易写出一堆"看起来通用、其实全是 x86 假设"的代码。**第二个架构是检验抽象的唯一标准**，这一条经验和 mini-cocos 里"OpenGL → Vulkan 才让 RHI 抽象成立"是同一条。

Zonix 现在能在 **x86_64（BIOS + UEFI 双路径）、aarch64（QEMU virt UEFI）、riscv64** 三套指令集上引导到同一份内核核心，跑同一个调度器、同一套页表逻辑、同一个 shell。下面三条是支撑这件事的最关键决策。

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

> 经验：HAL（硬件抽象层）不是"为了好看"的封装，它是**强制你把架构假设显式写出来**的工具。一旦 `kernel/` 里出现裸 `inb`，就等于在通用代码里偷偷埋了一颗 x86 地雷，移植第二个架构时才会爆。`dbaa726` 这一刀把所有地雷提前引爆了。

这个决定的回报在 `2422311`（riscv64 port）那天兑现：加第三个架构时，`kernel/` 核心几乎没动，工作量集中在 `arch/riscv64/` 提供那一组 `arch_*()` 实现和引导汇编。

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

`run_steps()` 统一遍历：打印对齐的 `[OK]`/`[FAIL]`、`required` 失败就 `arch_halt()`、非必需失败就降级继续。**新增一个子系统 = 表里加一行**，顺序一目了然，错误处理一处搞定，每个架构的差异锁在自己的子表里。

> 经验：凡是"一串有序、有依赖、要统一处理错误"的流程，**优先考虑把它表达成数据而不是控制流**。这和 mini-cocos 里渲染队列用 64-bit sortKey、Action 用归一化时间 `t` 是同一种品味 —— 把"策略"从"机制"里挤出来。

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

> 经验：**"内核 = 必须用裸 C 风格"是一种过时的迷信**。freestanding 拿不到 `std::`，但拿得到模板、RAII、`[[nodiscard]]`、constexpr。这些零开销抽象在内核里比在应用层更值钱 —— 因为内核里一个未检查的错误码可能就是一次 silent 数据损坏。

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

---

<a id="sec-5"></a>
## 5. 复盘：三架构 + 24k 行，到底学到了什么

1. **第二个架构是抽象的唯一裁判**。单架构内核里"通用"是一种自我感觉；直到 aarch64、再到 riscv64 真的跑起来，才知道哪些是真接缝、哪些是伪装成接缝的 x86 假设（→ [#15](https://github.com/leafvmaple/blog/issues/15)）。
2. **最难的 bug 往往不在你的逻辑里，在工具链的假设里**。`switch_to` 的 RSP off-by-8 在 GCC 下被 `leave;ret` 完美掩盖，换 Clang 后立刻 triple fault。**换一套编译器是一种免费的 fuzzing**（→ [#12](https://github.com/leafvmaple/blog/issues/12)）。
3. **PTE 是一个比"地址 + 权限位"更通用的数据结构**。present=0 时，剩下的 63 位可以拿来存任何东西 —— Zonix 拿它存换出页号，于是 swap 不需要任何额外的反查表（→ [#13](https://github.com/leafvmaple/blog/issues/13)）。
4. **"换页表的同时还要换栈"是引导期最反直觉的一步**。CR3 一写下去，旧栈的虚拟地址可能立刻失效，所以必须先把栈挪到新旧页表都映射的低地址。这一步在 UEFI 路径上尤其致命（→ [#14](https://github.com/leafvmaple/blog/issues/14)）。
5. **单核也要 spinlock**。不是为了多核互斥，是为了和**中断处理程序**互斥 —— spinlock 在 acquire 时关中断，本质上是个"关中断 + 占位"的复合原语（→ [#16](https://github.com/leafvmaple/blog/issues/16)）。
6. **freestanding 不等于退回 C**。RAII 守护中断状态（`intr::Guard`）、`Result<T>` 传播错误、模板化的 `LockGuard<T>` —— 这些抽象在内核里是负担更轻、收益更大的（→ [#17](https://github.com/leafvmaple/blog/issues/17)）。

写一个跑不出实验室的内核，从产品角度毫无产出。但它逼我把"操作系统"这个一直当黑盒用的东西，拆到**汇编层每一条指令都要对自己负责**的粒度。这种"对每一个字节负责"的训练，是写应用层代码十年都换不来的。

> **2026-05 更新**：上一版这里写"接下来想尝试跑一个真正的用户态 ELF"——现在它落地了。`exec` 子系统能把磁盘上一个不可信的 ELF 请进隔离地址空间、降到 ring 3 跑起来，并通过系统调用回到内核（→ 新增子篇 [#18](https://github.com/leafvmaple/blog/issues/18)）。配套还接入了一个**自研 C 编译器 zcc**（[独立仓库](https://github.com/leafvmaple/zcc)，作为子模块）来编译用户程序——内核 + 编译器构成了"自己的编译器编译跑在自己内核上的程序"的雏形自举链。

接下来准备做的：把调度器从协作式补到真正的时钟抢占全链路验证、给 riscv64 补齐中断控制器（PLIC）、以及给 zcc 补更完整的 C 子集。等做完再写下一篇。

---

## 迭代记录

<!-- 本主帖是索引 + 元经验帖，不沉淀具体子系统结论。子系统级演进追加到对应子篇；
     跨子系统的结构变更（新增架构、改 init 流程）在这里追加一句索引。 -->

- 2026-05-22：新增正交子系统 **用户态 ELF 执行 + 系统调用**，开子篇 [#18](https://github.com/leafvmaple/blog/issues/18)。这是项目从"只跑内核线程"到"能跑不可信用户进程"的质变（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) exec、[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) syscall ABI、[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) 接入 zcc 编译器子模块）。它兑现了 [#12](https://github.com/leafvmaple/blog/issues/12) 当初为内核线程划好的 `arch_setup_user_tf` / `trapret` 接缝——加用户态时这条路径一行没改。
- 2026-04-07：[`2422311`](https://github.com/leafvmaple/zonix-plus/commit/2422311) 加入 **riscv64** 第三个架构，[`5b32167`](https://github.com/leafvmaple/zonix-plus/commit/5b32167) 补板级抽象。这是对 [#15](https://github.com/leafvmaple/blog/issues/15) 所述 HAL 接缝的又一次验证：`kernel/` 核心几乎零改动。
- 2026-04-07：[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa) / [`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) 全内核错误处理从 `int` 返回码迁移到 `Result<T>` + `TRY`（见 §3 与 [#17](https://github.com/leafvmaple/blog/issues/17)）。这是跨子系统的横切变更，对每个子篇的具体影响写在各自迭代记录里。

---

*本文记录的是 [leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus) 的设计思考。如果你也在写自己的内核，或者对某个取舍有不同看法，欢迎到仓库 Issue 区聊聊。*
