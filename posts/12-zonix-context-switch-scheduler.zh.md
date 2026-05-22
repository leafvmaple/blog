# 一个被 GCC 掩盖、被 Clang 暴露的 `switch_to` bug：Zonix 的上下文切换与抢占式调度

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`switch.S` / `sched/` / `TaskStruct` / `Context` / `TrapFrame`

上下文切换是内核里最"魔法"的一段代码：一个函数调进去，**回来时已经是另一个进程在执行**。这一篇拆三件事：

1. `switch_to` 这 20 行汇编到底在搬运什么；
2. 一个**潜伏了几个月、换编译器才暴露**的 RSP off-by-8 bug —— 它是整个项目我最喜欢的一个 bug；
3. fork 出来的新进程从没运行过，它的"第一次返回"是怎么伪造出来的（forkret/trapret），以及优先级 round-robin 调度器的环形游标。

---

## 1. `switch_to` 搬运的是"两个寄存器集之间的差"

进程切换的本质，是把 CPU 当前进程的**callee-saved 寄存器 + 栈指针 + 返回地址**存起来，再把目标进程之前存的那一套装回去。x86_64 System V ABI 下，callee-saved 是 `rbx / rbp / r12-r15` + `rsp`，加上"接着从哪执行"的 `rip`。caller-saved 寄存器不用存 —— 因为 `switch_to` 是个普通 C 函数调用，调用方早已假定它们会被破坏。

Zonix 的 `Context` 就是这 8 个槽：

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

## 2. 那个 off-by-8：为什么换 Clang 后立刻 triple fault (`9fae90c`)

注意上面第 4 行我标了 ★：

```asm
    leaq 8(%rsp), %rax          # caller's RSP = RSP + 8
    movq %rax, 8(%rdi)          # from->rsp = caller's RSP
```

最初我写的是**直接存 `%rsp`**：

```asm
    movq %rsp, 8(%rdi)          # ← 错误版本：存了包含返回地址的 RSP
```

差别只有 8 字节。进入 `switch_to` 时，`callq` 刚刚把返回地址压栈，所以此刻的 `%rsp` 比"调用方调用前的 RSP"低 8 字节。我存的应该是**调用方调用前的 RSP**（也就是 `rip` 已经被单独存进 `context->rip`、栈上那个返回地址应当被"消费掉"之后的 RSP），但错误版本把那个还指向返回地址的 RSP 直接存了进去。

**为什么在 GCC 下它能跑几个月不出事？**

因为恢复时的对称性，恰好被 GCC 的函数 epilogue 掩盖了。GCC 给 `switch_to` 生成的收尾是经典的：

```asm
    leave        # mov %rbp,%rsp ; pop %rbp  —— 直接用 RBP 重建 RSP
    ret
```

`leave` 把 RSP 从 RBP 重新算出来，**完全不依赖我存进 context 的那个 RSP 值**。换句话说，我存错的那 8 字节，在 GCC 的恢复路径上根本没被用到 —— bug 一直在，只是没人去碰那颗地雷。

`9fae90c` 把工具链从 GCC/GNU ld 整体迁到 Clang/LLD/LLVM。Clang 给同一个函数生成的 epilogue 是 **RSP-relative** 的：

```asm
    addq $N, %rsp    # 直接对 RSP 做加法
    popq %rbp
    ret
```

这下 `ret` 取返回地址的位置，就实打实依赖我存进去再恢复出来的那个 RSP。off-by-8 立刻显形：`ret` 不再跳到真正的返回地址，而是跳到栈上**偏移 8 字节处的那个值** —— 那恰好是被保存的帧指针，一个栈地址。CPU 把一个栈地址当代码执行，下一拍就是 page fault → double fault → triple fault → QEMU 重启。**屏幕上什么都没有，连 panic 都来不及打。**

定位它的过程是教科书级的"二分 + 反汇编"：先确认是 `9fae90c` 引入（`git bisect` 缩到这一个 commit），再 `make disasm` 对比 GCC 和 Clang 给 `switch_to` 调用点生成的 epilogue，看到 `leave` 变成了 `addq $N,%rsp`，问题瞬间清楚。修复就是开头那两行 —— `leaq 8(%rsp), %rax` 把返回地址那 8 字节"算掉"再存。

> 这个 bug 我特意挑出来，因为它教会我一条具体经验：**汇编里和 ABI 打交道的代码，正确性不能依赖某个编译器恰好生成的 epilogue 形状**。我那段手写汇编"碰巧"和 GCC 的 `leave;ret` 兼容，但那是巧合不是正确。一旦另一个编译器用 RSP-relative epilogue（这完全合法），巧合就崩了。
>
> 更一般的版本：**换一套编译器，是一种几乎免费的 fuzzing。** 它会用一组完全不同的合法假设重新审视你的代码，把所有"我以为成立、其实只是当前编译器恰好这么做"的隐性依赖全抖出来。这次迁移除了 `switch_to`，还顺手暴露了好几个 `-Winline-new-delete`、符号比较、RWX segment 的问题（见 [#17](https://github.com/leafvmaple/blog/issues/17)）。

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

这个设计的优雅在于：**所有进程的入口都统一成"从中断返回"**。无论是内核线程（`arch_setup_kthread_tf` 填的 TrapFrame）还是用户态进程（`arch_setup_user_tf` 填 `cs=USER_CS`），区别只在 TrapFrame 里几个段寄存器的值，复用的是同一条 `trapret` 路径。这就是为什么 `forkret` 不需要任何自己的代码，一个 fall-through 就够了。

> **后续兑现**：写这篇时用户态还是"将来"，现在 `exec` 子系统已经落地——它正是靠 `arch_setup_user_tf` 把 TrapFrame 的 `cs/ss` 填成 `USER_CS/USER_DS`，复用这里这条 fork + `trapret` 路径，让 `iretq` 在恢复时发现 RPL=3 自动降到 ring 3。**加用户态时，本节这套机制一行没改**——这是"接缝在第一天划好"最直接的回报。完整的用户态执行链路见 [#18](https://github.com/leafvmaple/blog/issues/18)。

> 这里又是一个 `arch_*()` 接缝：`arch_setup_kthread_tf` / `arch_fixup_fork_tf` / `arch_setup_user_tf` 把"一个新进程的初始陷阱帧长什么样"这件**纯架构相关**的事关进 `arch/`，`fork` 本身（在 `kernel/sched/sched.cpp`，完全架构无关）只管调它们。x86 上填 `rdi/rsi/rflags.IF/cs`，aarch64 上填 `x0/x1/SPSR/ELR` —— `fork` 一个字都不用改。

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

这套"优先级决定**谁先跑 + 跑多久**"是抢占式优先级 round-robin 的经典形态，和 Linux O(1) 调度器早期的思路同源，只是 Zonix 砍到了最小可用集。

> 设计立场：调度**策略**（`SchedulerPolicy`：选谁、时间片多长）和调度**机制**（`TaskManager`：切换、链表、统计）是分开的两个类。想换成 CFS 风格的红黑树或多级反馈队列，只需要替换 `SchedulerPolicy`，`TaskManager::schedule()` 那套 `pick_next → run` 的骨架不动。这又是 mini-cocos 系列里反复出现的"机制/策略分离"。

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

- 2026-05-22：本节描述的 fork + `trapret` 机制被用户态执行复用——`exec` 通过 `arch_setup_user_tf` 走同一条路径把进程降到 ring 3（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)），§3 的接缝零改动。完整链路见新增子篇 [#18](https://github.com/leafvmaple/blog/issues/18)。
- 2026-04-07：[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c) GCC→Clang/LLD 工具链迁移暴露并修复了 `switch_to` 的 RSP off-by-8（见 §2）。这是本文最核心的一个故事。
- 2026-02-12：[`17869d7`](https://github.com/leafvmaple/zonix-plus/commit/17869d7) 加入同步原语 + 抢占式优先级调度，调度从协作式 yield 升级为时间片驱动的 `need_resched`（见 §4）。
- 2026-02-12：[`c0c8b1f`](https://github.com/leafvmaple/zonix-plus/commit/c0c8b1f) 现代化 scheduler/链表迭代，引入 `circular_from` 环形游标（见 §4.2），并把驱动命名对齐。

---

*本文是 [Zonix OS 设计复盘](https://github.com/leafvmaple/blog/issues/11) 系列的衍生深读。系列其它文章见复盘主文末尾的索引。*
