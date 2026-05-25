<!--pub:2024-11-15-->
# `leave;ret` 掩盖了六周的 RSP off-by-8，换 Clang 当场 triple fault

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`switch.S` / `sched/` / `TaskStruct` / `Context` / `TrapFrame`

2026-03-12 把 zonix-plus 的工具链从 GCC/GNU ld 整体迁到 Clang/LLD/LLVM（[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c)），第一次 `make qemu` 直接 triple fault，控制台一行 panic 都没来得及打。`git bisect` 缩到这个 commit；diff 里和 800 行 Makefile / `cxxrt.cpp` 改动并排塞着一个汇编改动，差 8 字节：

```diff
@@ arch/x86/kernel/switch.S
-    movq %rsp, 8(%rdi)          # context->rsp
+    leaq 8(%rsp), %rax          # compute caller's RSP (before callq pushed ret addr)
+    movq %rax, 8(%rdi)          # context->rsp = caller's RSP
```

这条 bug 从 2026-01-28（[`62fda85`](https://github.com/leafvmaple/zonix-plus/commit/62fda85)，项目第一个 commit）就在 `switch.S` 里，在 GCC 下安静地跑了 6 周，因为 GCC 给 `switch_to` 的**调用者** `TaskStruct::run` 生成的 epilogue 恰好绕过了它；Clang 的 epilogue 形状不同，第一拍就崩。

这一篇是这场 bug 的解剖：§1 看 `switch_to` 这 20 行汇编在搬运什么，§2 把两个编译器 epilogue 拉到桌面上对比，§3-5 是这段栈魔法顺手催生的 fork/trapret、调度器游标、`current` 时机几件相关事。

---

## 1. `switch_to` 搬运的是"两个寄存器集之间的差"

进程切换的本质：把 CPU 当前进程的 callee-saved 寄存器 + RSP + RIP 存起来，再把目标进程的同一套装回去。x86_64 System V ABI v1.0 §3.2.1（"Registers and the Stack Frame"）规定 callee-saved 寄存器为 `rbx / rbp / r12 / r13 / r14 / r15`，加上 `rsp`、控制 / 状态字段；caller-saved 寄存器（`rax / rcx / rdx / rsi / rdi / r8-r11`）不用存 —— 因为 `switch_to` 是普通 C 函数调用，调用方已假定它们被破坏。

Zonix 的 `Context` 就是这 8 个槽（`rip` / `rsp` / `rbx` / `rbp` / `r12` / `r13` / `r14` / `r15`，各 8 字节，共 64 字节）：

```cpp
// Context layout: rip, rsp, rbx, rbp, r12, r13, r14, r15  (各 8 字节)
```

`switch_to(from, to)` 的汇编（`rdi=from`, `rsi=to`）：

```asm
switch_to:
    movq (%rsp), %rax           # 栈顶就是 callq 压入的返回地址 = 切回来时该执行的 rip
    movq %rax, 0(%rdi)          # from->rip = 返回地址
    leaq 8(%rsp), %rax          # ★ 关键：caller 的 RSP = 当前 RSP + 8（跳过返回地址）
    movq %rax, 8(%rdi)          # from->rsp = caller's RSP
    movq %rbx, 16(%rdi)         # 保存 callee-saved ...
    movq %rbp, 24(%rdi)
    movq %r12, 32(%rdi)
    movq %r13, 40(%rdi)
    movq %r14, 48(%rdi)
    movq %r15, 56(%rdi)

    movq 56(%rsi), %r15         # 恢复目标进程的 callee-saved ...
    movq 48(%rsi), %r14
    movq 40(%rsi), %r13
    movq 32(%rsi), %r12
    movq 24(%rsi), %rbp
    movq 16(%rsi), %rbx
    movq 8(%rsi), %rsp          # ★ 切栈：现在站在目标进程的内核栈上
    pushq 0(%rsi)               # 把目标进程的 rip 压回新栈顶
    ret                         # "返回"到目标进程的 rip
```

读这段汇编要抓住一个核心：**`ret` 指令永远是从"当前 RSP 指向的地方"取返回地址**。所以最后三行的把戏是 —— 先把 RSP 换成目标进程的栈，再 `pushq` 它的 `rip`，于是 `ret` 就跳进了目标进程上次离开 `switch_to` 的地方。一个函数，进去时是进程 A，出来时是进程 B，**靠的就是中途换了 RSP**。

---

## 2. 那个 off-by-8：GCC 的 `leave;ret` 与 Clang 的 RSP-relative epilogue ([`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c))

注意 §1 的 ★ 那两行：

```asm
    leaq 8(%rsp), %rax          # caller's RSP = RSP + 8
    movq %rax, 8(%rdi)          # from->rsp = caller's RSP
```

最初写的是**直接存 `%rsp`**：

```asm
    movq %rsp, 8(%rdi)          # ← 错误版本：存了包含返回地址的 RSP
```

差别只有 8 字节。进入 `switch_to` 时，`callq` 刚把返回地址压栈，所以此刻的 `%rsp` 比"调用方调用前的 RSP"低 8 字节。应该存的是**调用方调用前的 RSP**（即 `rip` 已经被单独存进 `context->rip`、栈上那个返回地址应当被"消费掉"之后的 RSP），但错误版本把那个还指向返回地址的 RSP 直接存了进去。

**为什么 GCC 下能跑 6 周不出事？**

恢复的对称性，恰好被 `switch_to` 的**调用者** —— `kernel/sched/sched.cpp` 里的 `TaskStruct::run` —— 的函数 epilogue 掩盖了。用项目原 `CXXFLAGS`（`-O0 -ffreestanding -fno-pic -fno-stack-protector -fno-exceptions -fno-rtti -mno-red-zone -mcmodel=kernel`）把 `sched.cpp` 喂给 GCC 13.3：

```
$ g++ <CXXFLAGS> -c kernel/sched/sched.cpp -o /tmp/sched_gcc.o
$ objdump -d --disassemble=_ZN10TaskStruct3runEv /tmp/sched_gcc.o
...
  44a:   48 8d 45 dc           lea    -0x24(%rbp),%rax
  44e:   48 89 c7              mov    %rax,%rdi
  451:   e8 00 00 00 00        call   456 <_ZN10TaskStruct3runEv+0xc6>
  456:   90                    nop
  457:   c9                    leave        # ★ mov %rbp,%rsp ; pop %rbp —— RBP-relative
  458:   c3                    ret
```

`leave` 等于 `mov %rbp, %rsp; pop %rbp`。它把 RSP 从 RBP 重新算出来，**完全不依赖 `switch_to` 返回时栈里那个 RSP 值**。存错的 8 字节，在 GCC 的恢复路径上根本没被读到 —— bug 一直在，只是没人去碰那颗地雷。

切到 Clang 18 / LLD 后，同一个 `TaskStruct::run`：

```
$ llvm-objdump -d --disassemble-symbols=_ZN10TaskStruct3runEv obj/x86/kernel/sched/sched.o
...
  ab: 48 8d 7d ec           leaq    -0x14(%rbp), %rdi
  af: e8 00 00 00 00        callq   0xb4 <_ZN10TaskStruct3runEv+0xb4>
  b4: 48 83 c4 40           addq    $0x40, %rsp    # ★ RSP-relative：直接对 RSP 加常数
  b8: 5d                    popq    %rbp
  b9: c3                    retq
```

`ret` 从 `[rsp]` 取返回地址，这下实打实依赖存进去再恢复出来的那个 RSP。off-by-8 立刻显形：`ret` 不再跳到真正的返回地址，而是跳到栈上**偏移 8 字节处的那个值** —— 那恰好是被保存的帧指针，一个栈地址。CPU 把栈地址当代码取指，下一拍就是 page fault → double fault → triple fault → QEMU 重启。控制台上连 panic 都没来得及打。

定位过程是教科书级的"二分 + 反汇编"：`git bisect` 缩到 `9fae90c`；项目 Makefile 里 `make ARCH=x86 disasm` 跑一次同时 dump `kernel`、`mbr`、`vbr`、`bootloader` 的全反汇编（`llvm-objdump -D` 落到 `obj/x86/*.asm`），跟修复前对照 `TaskStruct::run` 的尾巴 —— `leave;ret` 变成了 `addq $0x40, %rsp; popq %rbp; retq`，问题瞬间清楚。修复就是开头那两行：`leaq 8(%rsp), %rax` 把返回地址那 8 字节"算掉"再存。

GCC 的 `leave;ret` 与 Clang 的 `addq/popq/retq` 都是 SysV AMD64 ABI 合法范围内的行为 —— 编译器有权选择保不保留 `%rbp` 当帧指针、要不要用 `leave` 重建 RSP，选择依据是优化策略、是否启用 `-fomit-frame-pointer` 等开关。换一套合法但行为不同的编译器后端，把所有"碰巧成立"的隐性 ABI 假设全抖出来：这次 GCC→Clang 工具链迁移除了暴露 `switch_to`，还顺手照出了未实现的 `__cxa_pure_virtual` / `atexit` / `operator new` 桩、UEFI loader 的 RWX segment 违规、若干 `-Winline-new-delete` 告警（见 [#17](https://github.com/leafvmaple/blog/issues/17)）—— 一次换编译器 = 一次几乎免费的 fuzzing。

---

## 3. fork 出来的进程从没运行过，它的"第一次"是伪造的

`switch_to` 能跑的前提是：目标进程的 `context` 里那个 `rip` 指向一个**真实存在的、之前 `switch_to` 离开的位置**。但 `fork` 刚造出来的进程从来没进过 `switch_to`，它的 `context` 是空的。第一次调度到它时，`ret` 该跳到哪？

答案是：**手工伪造一个看起来"刚从中断返回"的栈**，让新进程的第一条指令落在 `forkret` 上。

`copy_thread` 在新进程的内核栈顶放一个 `TrapFrame`，并把 `context` 设成"入口是 `forkret`、栈顶指向这个 TrapFrame"：

```cpp
void TaskStruct::copy_thread(uintptr_t esp, TrapFrame* src_tf) {
    trap_frame = reinterpret_cast<TrapFrame*>(kernel_stack_ + KSTACK_SIZE) - 1;
    *trap_frame = *src_tf;                 // 拷一份父进程（或内核线程模板）的陷阱帧
    arch_fixup_fork_tf(trap_frame, esp);   // 子进程返回值=0、修 rsp/ss/rflags

    context_.set_entry(reinterpret_cast<uintptr_t>(forkret));  // context.rip = forkret
    context_.set_stack(reinterpret_cast<uintptr_t>(trap_frame)); // context.rsp = &trapframe
}
```

于是第一次 `switch_to` 到这个新进程时，`ret` 跳进 `forkret`。而 `forkret` 的妙处是它**直接 fall-through 进 `trapret`**：

```asm
forkret:
    # RSP 此刻指向我们伪造的 TrapFrame —— 直接落进 trapret
trapret:
    popq %r15            # 从 TrapFrame 弹出所有通用寄存器
    popq %r14
    ... (省略)
    popq %rax
    addq $16, %rsp       # 跳过 trapno + errcode
    iretq                # 从"中断"返回：弹出 rip/cs/rflags/rsp/ss
```

也就是说，**新进程的"诞生"被伪装成一次中断返回**。`iretq` 弹出我们在 TrapFrame 里精心填好的 `rip`（内核线程的入口函数）、`cs`、`rflags`、`rsp`、`ss`，CPU 就"以为"自己刚处理完一个中断，干干净净地从内核线程入口开始跑。

这个设计的优雅在于：**所有进程的入口都统一成"从中断返回"**。无论是内核线程（`arch_setup_kthread_tf` 填的 TrapFrame）还是用户态进程（`arch_setup_user_tf` 填 `cs=USER_CS`），区别只在 TrapFrame 里几个段寄存器的值，复用的是同一条 `trapret` 路径 —— 这就是为什么 `forkret` 不需要任何自己的代码，一个 fall-through 就够了。

这套机制兑现于 2026-04-08 的 `exec` 子系统（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)）：写本文最初版时用户态还是"将来"，现在 `exec` 正是靠 `arch_setup_user_tf` 把 TrapFrame 的 `cs/ss` 填成 `USER_CS/USER_DS`，复用这条 fork + `trapret` 路径，让 `iretq` 在恢复时发现 RPL=3 自动降到 ring 3。**加用户态时，本节这套机制一行没改**。完整的用户态执行链路见 [#18](https://github.com/leafvmaple/blog/issues/18)。

`arch_setup_kthread_tf` / `arch_fixup_fork_tf` / `arch_setup_user_tf` 这一组接缝也把"一个新进程的初始陷阱帧长什么样"这件**纯架构相关**的事关进 `arch/`：`fork` 本身（在 `kernel/sched/sched.cpp`，完全架构无关）只管调它们。x86 上填 `rdi/rsi/rflags.IF/cs`，aarch64 上填 `x0/x1/SPSR/ELR` —— `fork` 一个字不动。

---

## 4. 调度：抢占点、环形游标与优先级

### 4.1 抢占是怎么发生的

时钟中断每一跳都调 `TaskManager::tick()`，它把当前进程的时间片减一，归零就置 `need_resched`：

```cpp
void SchedulerPolicy::tick(TaskStruct* current, TaskStruct* idle) const {
    if (!current || current == idle) return;   // idle 不消耗时间片
    if (current->time_slice > 0) current->time_slice--;
    if (current->time_slice <= 0) current->need_resched = 1;
}
```

`tick` 本身**不切换**进程 —— 它只在中断上下文里点一个标志位。真正的切换发生在安全点：中断返回前、或主循环里。主 idle 循环就是 `arch_idle(); sched::schedule();` 反复跑，`schedule()` 里挑出下一个该跑的进程。把"决定要切"和"真的切"分开，是为了**不在中断处理程序的栈上做上下文切换**，避免栈语义混乱。

### 4.2 环形游标：避免饥饿的最小实现

`pick_next` 在进程链表里找优先级最高的 Runnable 进程，但它从**上次停下的位置**继续扫，而不是每次都从头：

```cpp
TaskStruct* SchedulerPolicy::pick_next(ListNode& proc_list, TaskStruct* idle) {
    TaskStruct* next = idle;
    int best_prio = sched_prio::IDLE_PRIO + 1;

    if (!sched_cursor || sched_cursor == &proc_list)
        sched_cursor = proc_list.get_next();

    for (auto* node : proc_list.circular_from(sched_cursor)) {   // 从游标环形遍历一圈
        TaskStruct* p = TaskStruct::from_list_link(node);
        if (p->get_state() == ProcessState::Runnable && p != idle && p->priority < best_prio) {
            next = p;
            best_prio = p->priority;
        }
    }
    if (next != idle)
        sched_cursor = next->list_node.get_next();   // 下次从被选中者的下一个开始
    return next;
}
```

`circular_from(cursor)` 是链表上的环形迭代器：从 `cursor` 出发绕一整圈回到 `cursor`。配合"选中后游标后移一格"，**同优先级的进程会被轮流选中**（round-robin），不会因为链表顺序固定而让靠前的进程饿死后面的。优先级则用 `<` 比较插队 —— priority 数值越小越高。没有任何 Runnable 进程时，`next` 保持为 idle。

时间片长度本身也和优先级挂钩：

```cpp
int SchedulerPolicy::calc_time_slice(int priority) const {
    // 高优先级（数值小）拿更长时间片，低优先级拿更短
    int slice = BASE_TIMESLICE * (MIN_PRIO + 1 - priority) / (DEFAULT + 1);
    return slice < 1 ? 1 : slice;
}
```

这套"优先级决定**谁先跑 + 跑多久**"是抢占式优先级 round-robin 的经典形态，和 Linux O(1) 调度器早期的思路同源，只是 Zonix 砍到了最小可用集。调度**策略**（`SchedulerPolicy`：选谁、时间片多长）和调度**机制**（`TaskManager`：切换、链表、统计）是分开的两个类 —— 想换成 CFS 风格的红黑树或多级反馈队列，只需替换 `SchedulerPolicy`，`TaskManager::schedule()` 那套 `pick_next → run` 的骨架不动。这又是 mini-cocos 系列里反复出现的"机制/策略分离"。

---

## 5. 一处容易错的细节：`current` 指针的更新时机

`TaskStruct::run()` 里有一行注释看不出重要性、但错了就死机的代码：

```cpp
void TaskStruct::run() {
    if (this != current) {
        intr::Guard guard;                  // 整个切换过程关中断
        TaskManager::set_current(this);     // ★ 先更新 current，再 switch_to
        mark_running();
        if (next_cr3 != prev_cr3) arch_load_cr3(next_cr3);   // 换地址空间
        arch_switch_rsp0(kernel_stack_ + KSTACK_SIZE);       // 换 TSS.rsp0（中断用的内核栈）
        switch_to(&prev->context_, &context_);
    }
}
```

`set_current(this)` 必须在 `switch_to` **之前**。因为 `switch_to` 一旦执行，控制流就离开了当前函数 —— 它"返回"时已经是新进程在跑，新进程不会再回到这里执行 `set_current`。CHANGELOG 里 0.3.0 那次"Critical Scheduling Bug"就是把这个顺序写反了（先 switch 后 set），导致 `current` 永远指向错误的进程。还有 `arch_switch_rsp0` —— 它更新 TSS 里的 `rsp0`，保证**下次中断发生时，CPU 切到的是新进程自己的内核栈**而不是旧进程的。这两个"切换前必须就位"的状态，是上下文切换里最容易踩的隐性时序坑。

---

## 6. 迭代记录

<!-- 后续调度 / 上下文切换的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-04-08：本节描述的 fork + `trapret` 机制被用户态执行复用——`exec` 通过 `arch_setup_user_tf` 走同一条路径把进程降到 ring 3（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)），§3 的接缝零改动。完整链路见新增子篇 [#18](https://github.com/leafvmaple/blog/issues/18)。
- 2026-03-23：[`c0c8b1f`](https://github.com/leafvmaple/zonix-plus/commit/c0c8b1f) 现代化 scheduler/链表迭代，引入 `circular_from` 环形游标（见 §4.2），并把驱动命名对齐。
- 2026-03-13：[`17869d7`](https://github.com/leafvmaple/zonix-plus/commit/17869d7) 加入同步原语 + 抢占式优先级调度，调度从协作式 yield 升级为时间片驱动的 `need_resched`（见 §4）。
- 2026-03-12：[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c) GCC→Clang/LLD 工具链迁移暴露并修复了 `switch_to` 的 RSP off-by-8（见 §2）。这是本文最核心的一个故事。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
