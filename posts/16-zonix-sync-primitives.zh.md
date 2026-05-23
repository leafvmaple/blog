# spinlock 在单核上互斥的不是 CPU，是中断处理程序

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`lib/{spinlock,waitqueue,semaphore,mutex,lock_guard}.h` / `sync/*.cpp` / `drivers/intr.h`

Zonix 目前是单核（uniprocessor）内核，但它有一整套同步原语：Spinlock、WaitQueue、Semaphore、Mutex、`LockGuard<T>`、`intr::Guard`（[`17869d7`](https://github.com/leafvmaple/zonix-plus/commit/17869d7) 一次性引入）。code review 里第一个问题永远是："单核要 spinlock 干嘛？没有第二个 CPU 跟你抢啊。"

这个问题问到了点子上，答案也正是这一篇的主线：**单核内核的并发不来自"另一个 CPU"，来自"中断"。** 而这套原语恰好是一个干净的分层——最底下一层 Spinlock 解决"和中断处理程序互斥"，上面几层解决"和别的进程互斥时不要空转"。

---

## 1. Spinlock：它真正互斥的对象是中断，不是另一个核

先看实现：

```cpp
class Spinlock {
    volatile bool locked_{false};
    uint64_t      saved_flags_{};
public:
    void acquire();
    void release();
};

void Spinlock::acquire() {
    uint64_t flags = arch_irq_save();         // ① 保存当前中断开关状态
    arch_irq_disable();                       // ② 关中断
    while (__atomic_test_and_set(&locked_, __ATOMIC_ACQUIRE))   // ③ 原子 TAS 自旋
        arch_spin_hint();                     //    自旋时给 CPU 一个 pause/yield 提示
    saved_flags_ = flags;                     // ④ 把"加锁前的中断状态"存进锁里
}

void Spinlock::release() {
    __atomic_clear(&locked_, __ATOMIC_RELEASE);
    arch_irq_restore(saved_flags_);           // 恢复到加锁前的中断状态
}
```

注意它**做了两件事**：关中断 + 原子置位。在单核上，第三步那个 TAS 自旋几乎永远一次成功（没有别的 CPU 持锁）——所以**单核上 Spinlock 的实际作用，是第①②步的"关中断"**。

为什么关中断这么重要？设想一个被中断处理程序和普通进程**同时访问**的数据结构，比如键盘的输入环形缓冲区：进程在 `cons` 里读缓冲区的同时，键盘中断打进来要往缓冲区写。如果读到一半被中断抢走、中断改了缓冲区指针、再切回来——数据就乱了。这就是单核上真实存在的并发，而它的根源是中断的异步性，不是多核。Spinlock 的 acquire 关掉中断，就把这段临界区变成了不可被中断打断的原子操作。

`saved_flags_` 这个细节值得说：它存的是**加锁前**的中断状态，而不是无脑地"release 时开中断"。因为锁可能嵌套——外层锁加锁前中断本来就是关的，内层锁 release 时如果直接 `sti`，就会在外层临界区里**提前打开了中断**，破坏外层的保护。存下"加锁前的状态"再原样恢复，才能让嵌套加锁/解锁正确配对。这和 [#12](https://github.com/leafvmaple/blog/issues/12) 里 `switch_to` 必须精确保存/恢复 RSP 是同一种"保存-恢复要对称"的纪律。

> 那 TAS 自旋这步在单核上是不是纯属浪费？不是。它是**为多核留的正确性接缝**：那天真上了 SMP，Spinlock 的语义已经是对的（关本核中断 + 跨核互斥），不用回头重写所有用到它的地方。这又是 mini-cocos 系列里"接缝在第一天划好"的同一条经验——`arch_spin_hint()` 已经是 `pause`/`yield`，TAS 已经是 acquire/release 内存序，一切就位，只等第二个核。

---

## 2. 为什么不能"什么都用 Spinlock"：会阻塞的操作必须睡眠

Spinlock 有一条铁律：**持锁期间不能睡眠，临界区必须极短。** 因为它关着中断、还可能让别的核空转。可是内核里大量等待是"长等待"——等磁盘 I/O、等信号量、等另一个进程释放资源。这些你不能拿 Spinlock 死等：关着中断空转几毫秒，时钟中断进不来，调度器停摆，整个系统卡死。

所以需要第二种原语：**等不到就把自己挂起、让出 CPU，等条件满足时被唤醒**。这就是 WaitQueue。

```cpp
void WaitQueue::sleep() {
    Entry entry;                       // ★ Entry 直接开在调用者的栈上，零分配
    entry.task = sched::current();
    {
        LockGuard<Spinlock> guard(lock_);   // 用 spinlock 保护队列这一小段
        head_.add_before(entry.node);       // 把自己挂进等待队列
        entry.task->sleep();                // 标记当前进程为 Sleeping
    }                                       // ← spinlock 在这里释放（开中断）
    sched::schedule();                      // 让出 CPU；等被唤醒后才从这里返回
    {
        LockGuard<Spinlock> guard(lock_);
        entry.node.unlink();                // 醒来后把自己摘出队列
    }
}

void WaitQueue::wakeup_one() {
    LockGuard<Spinlock> guard(lock_);
    if (head_.empty()) return;
    Entry* e = Entry::from_node(head_.get_next());
    e->node.unlink();
    e->task->wakeup();                      // 把队头进程标记回 Runnable
}
```

这里有两个漂亮的设计点：

- **Entry 开在栈上。** 等待节点 `Entry{task, node}` 是 `sleep()` 的一个局部变量，住在**正在睡眠那个进程的内核栈**上。睡眠期间这个栈不会被回收，所以节点一直有效；醒来 unlink 后随栈帧自然销毁。**整个睡眠/唤醒路径零堆分配**——这在内核里至关重要，因为睡眠路径常常正是"内存紧张所以要等"的路径，这时再去 `kmalloc` 可能直接失败甚至递归触发缺页。又是 [#13](https://github.com/leafvmaple/blog/issues/13) 里强调过的"内核数据结构用侵入式/栈上节点，避免在关键路径 malloc"。
- **Spinlock 只保护队列操作那一瞬间，不覆盖 `schedule()`。** 挂队列、标记 Sleeping 是在 spinlock（关中断）里做的；但真正让出 CPU 的 `schedule()` 在锁外。否则就违反了"持 spinlock 不能睡眠"的铁律——你不能带着关中断的状态切到别的进程去。

---

## 3. Semaphore / Mutex：把两种锁组合起来

有了 Spinlock（保护短临界区）和 WaitQueue（长等待挂起），信号量和互斥锁就是这两者的**组合**——用 Spinlock 保护自己的计数/持有状态，用 WaitQueue 承载真正的阻塞：

```cpp
void Semaphore::down() {
    while (true) {
        {
            LockGuard<Spinlock> guard(lock_);
            if (count_ > 0) { count_--; return; }   // 有名额：占一个就走
        }                                            // ← 没名额：先放掉 spinlock
        waitq_.sleep();                              // 再睡（绝不能持着 spinlock 睡）
    }
}

void Semaphore::up() {
    { LockGuard<Spinlock> guard(lock_); count_++; }
    waitq_.wakeup_one();                             // 加完名额唤醒一个等待者
}
```

Mutex 几乎同构，只是把"计数"换成"持有标志 + owner"，并在 unlock 时断言只有持有者能解锁：

```cpp
void Mutex::unlock() {
    {
        LockGuard<Spinlock> guard(spin_);
        assert(held_ && owner_ == sched::current());  // 只有 owner 能解锁，否则是逻辑 bug
        held_ = false; owner_ = nullptr;
    }
    waitq_.wakeup_one();
}
```

这个 `owner_` 断言是 Mutex 比 Semaphore 多出来的语义：信号量是"配额"（谁都能 up，A 占的名额 B 可以还），互斥锁是"所有权"（A 锁的必须 A 来解）。把这条规则写成 `assert` 而不是注释，意味着任何"在错误的进程里 unlock"的 bug 会在开发期就地炸出来，而不是悄悄损坏状态。

---

## 4. 一个必须诚实面对的细节：lost wakeup

上面 `Semaphore::down()` 那段，有一个并发里最经典的陷阱潜伏着，我想把它摊开讲——因为它正是"会不会写并发"的分水岭。

看这个时序窗口：

```
进程 A 在 down() 里：
  { 持 lock_; 发现 count_ == 0; }   ← 释放 lock_
  ←──────── 窗口：此刻 A 还没进 waitq_.sleep() ────────→
                                    进程/中断 B 调 up():
                                      { 持 lock_; count_++; }  count_ 变成 1
                                      waitq_.wakeup_one();     队列是空的！什么都没唤醒
  waitq_.sleep();                   ← A 现在睡下去了，可 count_ 明明 > 0，且没人会再唤醒它
```

问题的根源：**"检查条件"和"挂进等待队列"用的不是同一把锁、不是同一个原子区间**。`count_` 的检查在 Semaphore 的 `lock_` 下，挂队列在 WaitQueue 自己的 `lock_` 下，两者之间有一道缝。唤醒信号恰好落在缝里，就丢了。

生产级内核怎么关这道缝？经典答案是 **condition variable 式的"原子地放锁 + 睡眠"**：把保护条件的那把锁一路持有到"已经登记进等待队列"之后，再作为睡眠的一部分原子释放（Linux 的 `prepare_to_wait()` 先入队再检查条件，`wait_event()` 宏把"检查—入队—睡眠"包成一个不漏唤醒的循环；pthread 的 `cond_wait(cond, mutex)` 把 mutex 传进去由它原子释放）。核心都是**让"最后一次条件检查"和"进入睡眠"之间不存在可被唤醒信号穿过的窗口**。

> 我把这一节单独拎出来，不是因为 Zonix 这里写得多完美——恰恰相反，**当前实现的 `down()` 在抢占式调度下存在这个窗口**，它能工作很大程度上依赖单核 + 某些路径上中断时序的"运气"。我把它如实写出来，是因为：
>
> 1. **承认已知的并发缺陷，比假装没有更专业。** 面试里我宁可说"这里有个 lost-wakeup 窗口，正确的修法是把条件检查和入队收进同一个原子区间"，也不愿假装它无懈可击。
> 2. 它精确地标出了同步原语设计里**最难的那 5%**：原语好写，"检查—入队—睡眠"三步的原子性才是真正的难点。WaitQueue 提供 `sleep()` 是不够的，得提供一个能让调用者把"条件检查"塞进入队和睡眠之间的接口（类似 `prepare_to_wait`）。这是 Zonix 同步层下一步要补的接缝。

把已知问题、它的根因、和业界标准解法三件事讲清楚，比给出一段"看起来没 bug"的代码更接近真实的工程能力。

---

## 5. `LockGuard<T>` 与 `intr::Guard`：用 RAII 收口所有"配对操作"

最后一层是把"acquire/release 必须配对"这件事交给编译器。`LockGuard<T>` 是个一行模板，对任何有 `acquire()`/`release()` 的类型都管用：

```cpp
template<typename T>
class LockGuard {
    T& ref_;
public:
    explicit LockGuard(T& l) : ref_(l) { ref_.acquire(); }
    ~LockGuard() { ref_.release(); }                       // 作用域结束自动释放，含异常/早返回路径
    LockGuard(const LockGuard&) = delete;                  // 不可拷贝，避免双重 release
};
```

为了让 Mutex 也能塞进 `LockGuard`，它特意提供了 `acquire()`/`release()` 作为 `lock()`/`unlock()` 的别名——一个小适配，让"任何锁"统一在同一个 RAII 模板下。这正是 [#17](https://github.com/leafvmaple/blog/issues/17) 要讲的"freestanding 内核里照样可以用模板和 RAII"的代表：`LockGuard<T>` 零运行期开销，却消灭了一整类"某条早返回路径上忘了 release"的 bug。

`intr::Guard` 是同一个模式的特例——它守护的不是锁，是中断状态：

```cpp
{
    intr::Guard guard;       // 构造：保存并关中断
    // ... 这段不希望被中断打断的临界区 ...
}                            // 析构：恢复到进来前的中断状态
```

调度器里 `TaskStruct::run()`、`fork()`、`exit()` 全是用 `intr::Guard` 把上下文切换、链表改动这些"不能被中断切走"的片段框起来（见 [#12 §5](https://github.com/leafvmaple/blog/issues/12)）。**"成对的危险操作"——加锁/解锁、关中断/开中断、push/pop——在 Zonix 里几乎一律用 RAII 守护**，因为它们错配的代价（死锁、中断状态泄漏）都极其难查，而 RAII 把"配对"这件事从"靠人记得写"变成"编译器保证"。

---

## 6. 整套栈的依赖关系

```
intr::Guard ─┐                          (RAII 包装"关中断"区间)
LockGuard<T> ─┴─► 任何 acquire/release 类型
                                          ▲
Spinlock ──────► 关中断 + 原子 TAS         │ 被组合
   ▲                                      │
   │ 保护短临界区                          │
WaitQueue ─────► 侵入式队列 + sleep/schedule/wakeup
   ▲
   │ 承载长阻塞
Semaphore / Mutex ─► count / owner + Spinlock + WaitQueue
```

读这张图的方式：**Spinlock 是唯一会忙等的原语，所有"会阻塞"的东西都建立在 Spinlock（保护自身状态的短临界区）+ WaitQueue（真正的挂起）之上。** 这个分层不是为了好看——它把"和中断互斥"（Spinlock 的职责）和"和进程互斥"（Semaphore/Mutex 的职责）这两种本质不同的并发问题，用两种代价不同的机制分别解决，而不是一把锁打天下。

---

## 7. 迭代记录

<!-- 后续同步原语的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-03-13：[`17869d7`](https://github.com/leafvmaple/zonix-plus/commit/17869d7) 一次性引入整套同步原语（Spinlock / WaitQueue / Semaphore / Mutex / `LockGuard<T>`）+ 抢占式优先级调度。本文描述的分层结构自此成型。源码总量 166 行：`spinlock.h`/`.cpp` 各 19 行、`waitqueue.h`/`.cpp` 20+52 行、`semaphore.h`/`.cpp` 24+32 行。
- **待办**：给 WaitQueue 补一个 `prepare_to_wait` 风格的接口，关掉 §4 描述的 `Semaphore::down()` lost-wakeup 窗口——把"条件检查 + 入队"收进同一个原子区间。这是同步层已知的、下一步要划的接缝。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
