<!--pub:2026-04-25-->
# `iretq` 顺手把进程降到 ring 3：复用 fork 的 trapret 加载不可信 ELF

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`kernel/exec/{exec,elf_loader}.cpp` / `kernel/trap/trap.cpp` / `include/abi/syscall.h` / `kernel/lib/unistd.h` / `user/zcc`

在 [`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)（2026-04-08）之前，Zonix 里跑的全是**内核线程** —— 同特权级（ring 0 / EL1）、同地址空间，本质上是"我信任的代码"。这个 commit 加上 [`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9)（接入自研 C 编译器 zcc 作为子模块）跨过了一道质变的坎：**一段不可信的、来自磁盘上某个 ELF 文件的代码被请进隔离地址空间、降到 ring 3 跑起来，并且只允许通过系统调用这一个窄口子回到内核**。

整个 exec 实现总量很小 —— `kernel/exec/exec.cpp` 172 行 + `elf_loader.cpp` 116 行 = 288 行；ABI 端 `include/abi/syscall.h` 是单一真相源，目前定义了 6 个系统调用号（`NR_EXIT`/`NR_READ`/`NR_WRITE`/`NR_OPEN`/`NR_CLOSE`/`NR_PAUSE`）。这一篇拆四件紧密咬合的事：构造用户地址空间、加载 ELF、跨过特权边界、防"用户递给内核的每一个指针都可能是恶意的"。它兑现了 [#12](https://github.com/leafvmaple/blog/issues/12) 里埋下的接缝 —— 用户态进程复用同一条 `trapret` 路径，靠 `iretq` 在恢复时发现 RPL=3 自动降到 ring 3。

---

## 1. 用户地址空间：一张新页表，但内核必须仍然可见

`exec()` 第一步是给新进程造一个独立的地址空间，**不能直接用内核页表**——否则用户代码能随手读写整个内核。但又不能造一张完全空白的页表，因为有一个微妙的约束：

> **当用户程序触发系统调用或被中断打断、CPU 陷入内核时，它此刻用的还是用户的那张页表。** 如果用户页表里没有内核的映射，那么陷入内核的瞬间——内核代码、内核栈、中断处理程序——全都找不到，当场 triple fault。

所以解法是：**新建一张用户 PML4，但把高半区那些内核映射原样拷贝进去。** 用户和内核共享同一套高半区映射（只是高半区的页表项带着"仅 ring 0 可访问"的权限位，用户态碰不到）：

```cpp
pde_t* create_user_pgdir() {
    auto* pgdir = (pde_t*)kmalloc(PG_SIZE);
    memset(pgdir, 0, PG_SIZE);                    // 低半区（用户区）全空，等 ELF 来填
    // 把内核的高半区顶层页表项整段拷过来：内核在每个地址空间里都可见
    memcpy(&pgdir[USER_TOP_ENTRIES], &boot_pgdir[USER_TOP_ENTRIES],
           (PAGE_TABLE_ENTRIES - USER_TOP_ENTRIES) * sizeof(pde_t));
    return pgdir;
}
```

这是所有主流内核都用的"高半区共享"布局：地址空间的低半区每个进程私有（用户代码/数据/栈），高半区所有进程共享同一套内核映射。它的好处是**系统调用陷入内核时不需要切换 CR3**——内核就在当前页表里，省掉一次昂贵的 TLB 刷新。代价是内核映射占掉了每个进程的高半区，但 64 位地址空间够大，无所谓。

用户栈则在低半区顶部单独映射出来，带 `VM_USER_RW`（用户可读写）：

```cpp
uintptr_t setup_user_stack(pde_t* pgdir) {
    for (uintptr_t va = USER_STACK_TOP - USER_STACK_SIZE; va < USER_STACK_TOP; va += PG_SIZE) {
        Page* page = pmm::pgdir_alloc_page(pgdir, va, VM_USER_RW);
        memset(phys_to_virt(pmm::page_to_phys(page)), 0, PG_SIZE);   // 清零，别把内核内存内容泄给用户
    }
    return USER_STACK_TOP;
}
```

注意那行清零——新分配的物理页可能装着之前别的进程的数据，直接给用户就是信息泄露。**任何"即将暴露给用户态"的内存都要先清零**，这是和 [#13](https://github.com/leafvmaple/blog/issues/13) 里 demand-zero 同源的安全纪律。

---

## 2. 加载 ELF：按 program header 铺段，并守住两条安全线

ELF 加载器走标准流程：校验头、遍历 program header、把每个 `PT_LOAD` 段映射到它要求的虚拟地址。但在教学内核里，**加载一个不可信的 ELF = 解析一段攻击者可以任意构造的二进制**，所以校验和边界检查才是重点。

校验被收进 `ElfHdr` 自己的成员函数（[`dd6ccee`](https://github.com/leafvmaple/zonix-plus/commit/dd6ccee) 把开放式的校验链封装成方法）：

```cpp
struct ElfHdr64 {
    // ...
    [[nodiscard]] bool is_valid() const {
        return e_magic == ELF_MAGIC && e_elf[0] == 2 /*64-bit*/ && e_version == 1
            && e_machine == EM_CURRENT;            // ★ 编译期按目标架构解析（见下）
    }
    [[nodiscard]] bool is_executable() const {
        return is_valid() && e_type == 2 && e_phoff != 0 && e_phnum != 0;
    }
};
```

`EM_CURRENT`（[`67608c2`](https://github.com/leafvmaple/zonix-plus/commit/67608c2)）是个漂亮的小设计——它在编译期就根据目标架构解析成对应的 ELF 机器类型：

```cpp
#if   defined(__x86_64__)  inline constexpr uint16_t EM_CURRENT = EM_X86_64;   // 0x3E
#elif defined(__aarch64__) inline constexpr uint16_t EM_CURRENT = EM_AARCH64;  // 0xB7
#elif defined(__riscv)     inline constexpr uint16_t EM_CURRENT = EM_RISCV;    // 0xF3
#endif
```

于是 x86 内核自动拒绝 aarch64 的 ELF，反之亦然——**"只接受本架构的二进制"这条规则没有写成运行期判断，而是编译期常量**。这正是 [#15 多架构抽象](https://github.com/leafvmaple/blog/issues/15) 那套思路在 ELF 校验上的又一次体现：架构差异被压进一个 `constexpr`，加载器的代码一个字都不用分架构。

加载循环里有两条必须守住的安全线：

```cpp
for (每个 PT_LOAD 段 ph) {
    // 安全线 1：段在文件内的范围不能越过文件本身（防止读到文件外的内核内存）
    if (ph->p_filesz > 0 && ph->p_offset + ph->p_filesz > size) return 0;

    // 安全线 2：段不能映射进内核地址空间（防止用户 ELF 声称"我要加载到 0xFFFFFFFF80000000"覆盖内核）
    if (ph->p_va >= KERNEL_BASE) {
        cprintf("elf: segment maps to kernel space (va=0x%lx)\n", ph->p_va);
        return 0;
    }

    uint32_t perm = VM_USER | (ph->p_flags & ELF_PF_W ? VM_WRITE : 0);   // 按段的 W 位定权限
    // ... 分配页、清零（覆盖 BSS 和 memsz > filesz 的部分）、拷文件数据 ...
}
```

第二条尤其关键：如果不检查 `p_va >= KERNEL_BASE`，一个恶意 ELF 只要在 program header 里声明"把我这段加载到内核地址"，加载器就会乖乖往内核空间写——直接改写内核代码。这类"相信文件里的地址字段"的漏洞在真实 CVE 里反复出现。**加载器对 ELF 文件里的每一个数值都要假定它是攻击者填的。**

---

## 3. 跨过特权边界：复用 #12 的 `trapret`，让 `iretq` 替我们降权

地址空间和入口都备好了，怎么"跳"到 ring 3？这里不需要任何新机制——它**完整复用了 [#12](https://github.com/leafvmaple/blog/issues/12) 里讲的 fork + forkret/trapret 那套栈帧伪造术**，只是换了 TrapFrame 里几个字段的值：

```cpp
TrapFrame tf{};
arch_setup_user_tf(&tf, entry, user_rsp);   // ★ 和内核线程唯一的区别就在这个函数

auto pid = sched::fork(0, user_rsp, &tf);    // 完全复用 [#12] 的 fork 路径
```

`arch_setup_user_tf` 和内核线程用的 `arch_setup_kthread_tf` 是同一个 `arch_*()` 接缝的两个实现，区别只在段寄存器：

```cpp
void arch_setup_user_tf(TrapFrame* tf, uintptr_t entry, uintptr_t usp) {
    tf->cs = USER_CS;        // ★ 用户代码段，RPL=3 —— iretq 看到这个就降到 ring 3
    tf->ss = USER_DS;        // ★ 用户栈段
    tf->rflags = FL_IF;
    tf->rip = entry;         // ELF 入口
    tf->rsp = usp;           // 用户栈顶
}
```

回忆 [#12 §3](https://github.com/leafvmaple/blog/issues/12)：fork 出的进程第一次被调度时，会落进 `forkret` → fall-through 到 `trapret` → `iretq`。`iretq` 从 TrapFrame 弹出 `cs`/`rip`/`rflags`/`rsp`/`ss`——而**当 `iretq` 发现要恢复的 `cs` 的 RPL 是 3（用户特权级）时，它会自动把 CPU 降到 ring 3**，并切到 `ss:rsp` 指定的用户栈。整个降权动作是 `iretq` 一条指令完成的，内核不需要任何特殊代码。

这就是 [#12](https://github.com/leafvmaple/blog/issues/12) 里那句"所有进程的入口都统一成从中断返回"的回报：内核线程和用户进程**走的是同一条 `trapret` 路径、同一套 fork 机制**，唯一的差异是 TrapFrame 里 `cs`/`ss` 的值。当初为了内核线程设计的接缝，加用户态时一行都没改——这是"接缝在第一天划好"最直接的兑现。

---

## 4. 系统调用 ABI：一份所有人都认的真相源

用户进程降到 ring 3 后，它唯一能合法回到内核的方式是**系统调用**。Zonix 把系统调用号抽成一份独立的、纯 C 宏的头文件（[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）：

```c
/* include/abi/syscall.h — 内核与用户工具链共享的唯一真相源 */
/* 规则：纯 C 预处理器宏，必须能被 .S 汇编 #include */
#define NR_EXIT   1
#define NR_READ   3
#define NR_WRITE  4
#define NR_OPEN   5
#define NR_CLOSE  6
#define NR_PAUSE  29
```

为什么要单独一份、还限定"纯 C 宏、能被汇编 include"？因为系统调用号是一个**跨越三方的契约**：内核的分发器、用户程序的 libc 风格包装、以及 zcc 运行时里的汇编桩，三方必须对"4 号是 write"达成完全一致。任何一方写错一个号，就是 wrong syscall 静默走错分支。把它做成纯 C 宏的单一头文件、能被 `.S` 直接 include，**从根上消除了三方各自维护一份常量、然后慢慢漂移的可能**。这和 [#14](https://github.com/leafvmaple/blog/issues/14) 里 `BootInfo` 作为 bootloader 与内核的共享契约是同一个思路——**接口契约要有唯一的物理来源**。

> **关于"物理上 include 同一份"的诚实补充**：zcc 是独立仓库不能反向依赖 Zonix 路径，所以实际上 `zcc/src/runtime/syscall.h` 和 `zonix-plus/include/abi/syscall.h` 是**两份物理拷贝**（号码同形、header guard / 空白不一样），由 [`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh) 在 `make user` 时自动 diff 两份的 `#define NR_*` / `*_FD` 行守住同步。"两份物理文件、一份逻辑契约、自动化兜底"——这是 zcc 这一边的视角，完整拆解见 [#21](https://github.com/leafvmaple/blog/issues/21)。

陷入指令本身是架构相关的，于是又是一个 `arch_*()` 接缝（用户侧 `unistd.h` 的包装）：

```cpp
template<typename T> inline T syscall0(long nr) {
#if defined(__x86_64__)
    __asm__ volatile("int %1" : "=a"(res) : "i"(T_SYSCALL), "0"(nr));   // x86: int $0x80
#elif defined(__aarch64__)
    __asm__ volatile("svc #0" : "=r"(x0) : "r"(x8) : "memory");          // aarch64: svc #0
#endif
    // riscv64: ecall
}
```

内核侧，系统调用最终汇入**统一的陷阱分发器** `trap_dispatch`——它把"是 IRQ / 是缺页 / 是系统调用"的判定也藏进 `arch_*()` 后面：

```cpp
extern "C" void trap_dispatch(TrapFrame* tf) {
    if (trap::arch_try_handle_irq(tf))        { ... }            // 硬件中断
    else if (trap::arch_is_page_fault(tf))    { handle_page_fault(...); }  // 缺页（见 #13）
    else if (trap::arch_is_syscall(tf)) {                        // 系统调用
        trap::arch_on_syscall_entry(tf);
        if (!trap::handle_syscall(tf)) { tf->set_return(-1); }   // 未知调用号 → 返回 -1
    }
}

bool handle_syscall(TrapFrame* tf) {
    switch (tf->syscall_nr()) {          // syscall_nr() / syscall_arg(n) / set_return() 都是架构抽象的访问器
        case NR_WRITE: { ... tf->set_return(sys_write(...)); return true; }
        case NR_EXIT:  { sched::exit(tf->syscall_arg(0)); ... }
        // ...
    }
}
```

`tf->syscall_nr()` / `syscall_arg(n)` / `set_return(v)` 把"系统调用号和参数放在哪个寄存器"（x86 在 `rax`/`rdi`…，aarch64 在 `x8`/`x0`…）这件**纯 ABI 相关**的事关进了 TrapFrame 的访问器里，`handle_syscall` 的分发逻辑完全架构无关。这是 [#15](https://github.com/leafvmaple/blog/issues/15) 接缝在系统调用层的又一次复用。

---

## 5. 信任边界：用户递来的每一个指针都可能是攻击

系统调用是用户唯一能进内核的口子，所以**它是整个内核里信任边界最锋利的地方**。`sys_write(fd, buf, count)` 里的 `buf` 是一个用户态指针——用户完全可以传一个指向**内核地址**的指针，骗内核"帮我把这块内存写到文件去"，从而读出内核内存；或者传一个指向内核的指针让内核 `read` 往里写，篡改内核状态。这就是经典的 confused deputy。

Zonix 的防线是两个小函数，但它们守的是整个用户/内核边界：

```cpp
// 任何用户传进来的 (地址, 长度) 都要先验：必须完全落在用户空间内
bool user_range_valid(uintptr_t addr, size_t size) {
    if (addr >= USER_SPACE_TOP) return false;            // 地址本身越界
    if (size > USER_SPACE_TOP - addr) return false;      // 地址 + 长度 溢出到内核区（注意防整数溢出的写法）
    return true;
}

// 用户传字符串（比如 open 的路径）时，不能直接解引用——逐字节拷进内核缓冲，边拷边查边界
int copy_user_cstr(const char* user, char* out, size_t out_size) {
    if (!user || base >= USER_SPACE_TOP) return -1;
    for (size_t i = 0; i < out_size; i++) {
        if (base + i >= USER_SPACE_TOP) return -1;       // 字符串跨进内核区 → 拒绝
        out[i] = user[i];
        if (out[i] == '\0') return 0;                    // 正常结尾
    }
    return -1;                                            // 超长（没有结尾符）→ 拒绝
}
```

两个细节值得说：

- `user_range_valid` 里 `size > USER_SPACE_TOP - addr` 这个写法，而不是 `addr + size > USER_SPACE_TOP`——是为了**防整数溢出**。如果用户传一个巨大的 `size`，`addr + size` 会回绕成一个小数值骗过检查；改成减法就没有溢出。这是边界检查里一个反复被忽视、又反复被利用的细节。
- `copy_user_cstr` 不信任用户字符串有结尾符，**自己限长**（`out_size`），逐字节查边界。直接对用户指针调 `strlen` 是经典漏洞：用户给一个不带 `\0`、紧贴用户空间末尾的字符串，`strlen` 就会越界读进内核。

引入用户态的那一刻，内核里多了一类全新的、最危险的输入：来自不可信进程、通过系统调用边界递进来的数据。之前 Zonix 所有的输入都来自内核自己写的代码；从 `exec` 第一个用户程序开始，"永远不要相信用户指针"成了一条必须时刻绷着的纪律。教学内核把这条线划清楚，比多支持几个系统调用重要得多。

---

## 6. 用户程序从哪来：自研编译器 zcc

最后一块拼图：那些被 `exec` 加载的 ELF 是谁编出来的？Zonix 用的是一个**自己写的 C 编译器 zcc**（[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) 把它作为子模块接入构建管线）。`user/Makefile` 用 zcc 编译 `user/zcc/test/*.c`、生成 FAT32 8.3 短文件名兼容的 ELF（加 `Z` 前缀避免和手写汇编程序撞名），和 `user/hello/hello.S` 这种汇编版用户程序一起打进一张 userdata 磁盘镜像；内核启动后把这张盘挂到 `/mnt`，`exec("/mnt/ZHELLO.ELF")` 就把它跑起来。

zcc 已经独立成完整子系列——**主索引帖 [#20](https://github.com/leafvmaple/blog/issues/20)**（项目骨架 + 3 条工程决策 + 6 条落地后的事实），子篇 [#21 ABI 接缝](https://github.com/leafvmaple/blog/issues/21)（拆 §4 那条"两份物理文件、一份逻辑契约、自动化兜底"的全部细节，包括 crt0 / linker.ld / 端到端流程图）、[#22 LLVM codegen](https://github.com/leafvmaple/blog/issues/22)（删 Koopa 后端净 -1,414 行的减法重构 + char-i8 + opaque pointer 时代 GEP 两种形状）、[#23 C0 演进](https://github.com/leafvmaple/blog/issues/23)（从 SysY 扩到能编 `printf("Hello\n")` 的最小前端 + LALR dangling-else + 数组 decay 标位）。

值得在这里多说一句的是 exec 路径里大量用了 RAII 来保证错误清理——`KernelBuf`（自动 `kfree`）、`OpenFile`（自动 `vfs::close`），任何一步失败，析构函数都会把已经申请的资源收干净。这正是 [#17](https://github.com/leafvmaple/blog/issues/17) 讲的"freestanding 内核里照样靠 RAII 收口资源"在一条新路径上的应用。

---

## 7. 迭代记录

<!-- 后续 exec / syscall / 用户态的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-05-23：§6 从"另一个大坑值得单独成篇"扩成完整的 zcc 系列指引（主索引 [#20](https://github.com/leafvmaple/blog/issues/20) + 子篇 [#21](https://github.com/leafvmaple/blog/issues/21)/[#22](https://github.com/leafvmaple/blog/issues/22)/[#23](https://github.com/leafvmaple/blog/issues/23)）。§4 ABI 段补充"两份物理文件、一份逻辑契约"的诚实复盘（指向新增的 [`scripts/check_syscall_abi_sync.sh`](https://github.com/leafvmaple/zonix-plus/blob/main/scripts/check_syscall_abi_sync.sh)），把"物理 include 同一份"这条原本不准确的说法纠正。
- 2026-05-22：[`551394f`](https://github.com/leafvmaple/zonix-plus/commit/551394f) exec 端到端测试在只有单盘的目标（aarch64/riscv64 的 SDHCI）上优雅跳过，保留 x86 BIOS/UEFI 覆盖；[`0b7e929`](https://github.com/leafvmaple/zonix-plus/commit/0b7e929) 把 `GptHeader` 补齐到完整 512 字节扇区，`find_partition_start` 直接读进结构体（关联 [#14](https://github.com/leafvmaple/blog/issues/14) 的 GPT/分区表）；[`dd6ccee`](https://github.com/leafvmaple/zonix-plus/commit/dd6ccee) 把 ELF 校验封装进 `ElfHdr` 成员函数。
- 2026-04-08：本子系统首次落地。[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) exec/FAT 用 `ENSURE`/`TRY` 简化错误处理（见 [#17](https://github.com/leafvmaple/blog/issues/17)）；[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) 抽出 syscall ABI 头（见 §4）；[`67608c2`](https://github.com/leafvmaple/zonix-plus/commit/67608c2) 加 `EM_CURRENT` 按架构 ELF 机器类型（见 §2）；[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) 把 zcc 编译器子模块 + userdata 镜像接入构建管线（见 §6）；[`dd98ccd`](https://github.com/leafvmaple/zonix-plus/commit/dd98ccd) 加 exec 集成测试，验证 fork/load/run 全链路。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
