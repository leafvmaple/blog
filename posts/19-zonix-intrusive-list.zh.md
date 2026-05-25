<!--pub:2026-04-28-->
# 侵入式链表：内核里链表节点几乎从不单独 malloc

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`kernel/lib/list.h` / `Page` / `TaskStruct` / `MemoryDesc` / `WaitQueue`

```text
$ grep -rE 'ListNode [a-z_]+\{\}' kernel/ include/ | wc -l
10+                              # 内嵌 ListNode 字段的位置（去掉测试）
$ wc -l kernel/lib/list.h
145                              # 整套侵入式链表实现：145 行 C++17
$ grep -rEh 'unlink\(\)|add_before|add_after|circular_from|reversed\(\)' kernel/ | wc -l
96                               # 链表操作的调用点
```

每个 `Page`（PMM 空闲页链）、每个 `TaskStruct`（进程链 / 哈希链 / 父子链 3 条）、每个 `MemoryDesc`（VMA 链 + swap 候选队列）、每个 `WaitQueue::Entry` —— zonix 里需要被"挂在某条链上"的对象都自带一个 `ListNode` 字段。整套机制 145 行实现，96 处调用，**全程没有一次 `kmalloc` 是为链表节点本身**。

写 Linux 风格内核不谈侵入式链表，就像聊操作系统不谈页表。这一篇拆四件事：§1 为什么内核必须避免在链表节点上 malloc、§2 zonix 的 `ListNode` 长什么样（两个指针 + 自指 sentinel + 模板 `container<T>()`）、§3 现代 C++ 给它的几个升级（`constexpr` 偏移、模板迭代器、range-based for、circular 视图）、§4 zonix 里的实际落地、§5 还能怎么走。

---

## 1. 内核为什么不能在链表节点上 malloc

教科书 `std::list<T>` 每次 `push_back` 都要 heap-allocate 一个 `__list_node`。用户态这是 ~100 ns 的事，可以接受。内核里这是地雷：

- **缺页路径上不能 malloc**。`vmm::pg_fault`（见 [#13](https://github.com/leafvmaple/blog/issues/13)）触发时如果再去 `kmalloc` 一个链表节点（比如要把 victim 页挂回某条 FIFO），kmalloc 内部可能需要扩展 kheap → 又触发缺页 → 无限递归 → triple fault。Linux 用 `GFP_ATOMIC` + mempool 缓解；zonix 直接选择"挂链时不分配"：swap FIFO 里挂的是 `Page::list_node`，物理页本身已经存在，挂链零分配。
- **中断上下文不能 malloc**。中断处理程序栈很浅，而 `kmalloc` 内部有锁、可能 sleep。WaitQueue 的 sleep 路径（见 §4）用栈上 `Entry`，不分配。
- **启动早期不能 malloc**。PMM 还没就绪时空闲页链表就已经在工作。free list 节点必须就在 `Page` 结构体里。

侵入式（intrusive）的本质：**链表节点 = 被链对象自身的一个字段，挂链和取消挂链都不涉及分配**。代价是一个对象同一时刻只能在固定数量的链表里 —— 每条链要单独嵌一个 `ListNode` 字段。`TaskStruct` 同时需要在 process list、PID hash bucket、parent 的 child list 上，所以它嵌了 3 个 `ListNode`。这种"为每条要参与的链单独准备一个字段"的写法在 Linux 里是惯例，看到 `task_struct` 里十几个 `list_head` 不要惊讶 —— 那是设计风格而非冗余。

---

## 2. zonix 的 `ListNode`：两个指针 + 模板 `container<T>()`

`kernel/lib/list.h` 145 行的核心：

```cpp
struct ListNode {
    ListNode* prev{};
    ListNode* next{};

    ListNode() { prev = next = this; }   // 自指 sentinel：empty list 的标志

    inline void add_before(ListNode& elm) {
        elm.prev = prev;
        elm.next = this;
        prev->next = &elm;
        prev = &elm;
    }

    inline void add_after(ListNode& elm) { /* 对称 */ }
    inline void unlink() const { prev->next = next; next->prev = prev; }
    [[nodiscard]] inline bool empty() const { return next == this; }

    template<typename T>
    [[nodiscard]] inline T* container() const {
        return reinterpret_cast<T*>(reinterpret_cast<uintptr_t>(this) - T::node_offset());
    }
};
```

两个关键设计点：

- **自指 sentinel**：默认构造让 `prev = next = this`，于是 `empty()` 就是 `next == this`。这避免了 nullptr 检查到处散布，所有 `add` / `unlink` 路径上分支永远是 well-defined 的指针解引用。Linux 的 `LIST_HEAD_INIT` 是同样的设计。
- **模板化 `container<T>()`**：从节点指针反推宿主对象指针。Linux 的等价物是著名的 `container_of` 宏，靠 `offsetof(struct, member)`。zonix 用模板 + `T::node_offset()` 把它写成一个真正的 C++ 方法 —— 不是宏，参与 overload resolution，支持类型推导，IDE 能跳转。

`T::node_offset()` 怎么算？看 `Page`：

```cpp
// kernel/mm/pmm.h
struct Page {
    int ref{};
    uint32_t flags{};
    unsigned int property{};
    ListNode list_node{};

    [[nodiscard]] ListNode& node() { return list_node; }
    static constexpr size_t node_offset() { return offset_of(&Page::list_node); }
};
```

`offset_of` 在 `include/base/types.h`：

```cpp
template<typename T, typename M>
constexpr size_t offset_of(M T::* member) {
    return reinterpret_cast<size_t>(&(static_cast<T*>(nullptr)->*member));
}
```

成员指针 + 在 `nullptr` 上算偏移。`constexpr` 保证编译期解析 —— **`Page::node_offset()` 在最终 `.o` 里是一个立即数，不是运行时函数调用**。所以 `node->container<Page>()` 展开后等价于 `(Page*)((uintptr_t)node - 16)` 这种立即数减法。

这就是现代 C++ 比 Linux `container_of` 宏强的第一点：**类型安全 + 编译期常量保证、且不污染预处理器命名空间**。

---

## 3. 现代 C++ 给侵入式链表的几个升级

145 行里有 30+ 行专门给迭代器。Linux 的链表用 `list_for_each_entry(pos, head, member)` 宏，看起来 C 味浓；zonix 直接走标准 C++ 迭代器协议：

```cpp
template<typename NodePtr, bool Reverse = false>
struct Iterator {
    NodePtr cur{};
    NodePtr operator*() const { return cur; }
    Iterator& operator++() {
        if constexpr (Reverse) cur = cur->prev;
        else                   cur = cur->next;
        return *this;
    }
    bool operator==(const Iterator& other) const { return cur == other.cur; }
    bool operator!=(const Iterator& other) const { return cur != other.cur; }
};
```

`if constexpr` 让正向 / 反向迭代器复用同一个模板，**编译期分支**消除 —— 反向迭代器在最终代码里没有任何运行时判断，是纯 `cur = cur->prev`。这是 C++17 `if constexpr` 在内核里少见的好用例：编译期多态替代代码复制。

`ListNode` 自带 `begin()` / `end()`，所以 range-based for 直接跑：

```cpp
for (auto* node : proc_list) {                          // 正向遍历
    TaskStruct* p = TaskStruct::from_list_link(node);
    ...
}

for (auto* node : proc_list.reversed()) {               // 反向：返回 reverse_view
    ...
}

for (auto* node : proc_list.circular_from(cursor)) {    // 调度器游标：从 cursor 出发绕一圈
    ...
}
```

`circular_from(cursor)` 是 zonix 调度器（见 [#12 §4.2](https://github.com/leafvmaple/blog/issues/12)）的核心：从游标位置出发遍历一整圈回到起点，配合"选中后游标后移一格"实现同优先级 round-robin，不让靠前的进程饿死后面的。Linux 里类似概念分散在 `for_each_process_thread` 等多个宏里，zonix 把它收进迭代器一个抽象点，调用方写起来和遍历普通容器没区别。

`[[nodiscard]]` 是另一个小但重要的升级：

```cpp
[[nodiscard]] inline bool empty() const { return next == this; }
[[nodiscard]] reverse_view reversed() { return reverse_view{this}; }
[[nodiscard]] circular_view circular_from(ListNode* start) { ... }
```

写 `head_.empty();` 然后丢掉结果 —— 编译期警告。在裸 C 内核里这是注释才能表达的事，C++17 之后是编译期检查。WaitQueue 的 `wakeup_one` 里第一行就是 `if (head_.empty()) return;`，这个返回值忘了检查就立刻竞态。

---

## 4. zonix 里 `ListNode` 的实际落地

| 子系统 | 嵌入字段 | 链头 | 备注 |
|---|---|---|---|
| PMM first-fit | `Page::list_node` | `FreeArea::free_list` | 物理页空闲列表；"块大小"在 `Page::property` 里 |
| 调度器 | `TaskStruct::list_node` | `TaskStruct::s_proc_list`（static） | 全局进程链表 + 调度游标 |
| 进程父子树 | `TaskStruct::child_node` | `TaskStruct::child_list`（每父进程一个） | fork 关系 |
| 进程哈希 | `TaskStruct::hash_node` | PID 哈希桶 | O(1) `find_by_pid` |
| VMM | `MemoryDesc::mmap_list` | 同名 head | VMA 按起始地址有序链 |
| swap FIFO | `Page::list_node`（复用） | `MemoryDesc::swap_list` | 详见下面 |
| WaitQueue | 栈上 `Entry::node` | `WaitQueue::head_` | 关键：Entry 是 `sleep()` 栈帧里的局部变量 |

**WaitQueue 的栈上 Entry 模式**特别值得提一下：

```cpp
// kernel/sync/waitqueue.cpp
void WaitQueue::sleep() {
    Entry entry;                                    // 栈上分配
    entry.task = sched::current();
    {
        LockGuard<Spinlock> guard(lock_);
        head_.add_before(entry.node);               // 挂上去
        entry.task->sleep();
    }
    sched::schedule();                              // 阻塞，被切走
    {
        LockGuard<Spinlock> guard(lock_);
        entry.node.unlink();                        // 醒来后从链上摘
    }
}
```

`Entry` 完全在 `sleep()` 的栈帧里 —— 进程被换出去时栈连同寄存器一起被 `switch_to` 保存（见 [#12](https://github.com/leafvmaple/blog/issues/12)），唤醒回来栈完整恢复，`entry.node` 还指向同一块内存。**整个等待原语零堆分配**。这种写法在用户态用 `std::condition_variable` 不可能做到（用户态线程切换不会保留任意大小的栈帧 + 不会精确保留地址）。

**`Page::list_node` 被 PMM free list 和 swap FIFO 复用**这件事也值得说：一个物理页同一时刻只能处在一种状态（空闲池 / 已分配但 swappable / 已分配 pinned），不会同时挂两条链。这是一个内核级 discriminated union，省下一个 `ListNode` 字段（16 字节 × 系统总页数，几兆物理内存下也有几十 KB 的累计节省）。Linux 也用同样手法 —— `struct page` 里的 `lru` 成员同时被 page cache LRU / SLUB freelist / migration list 复用。

---

## 5. 还能怎么走

这套实现已经能撑住 zonix 当前所有用法，但有几条 modern C++ 可以继续往前推的方向：

**1. C++20 `concepts` 约束 `container<T>()` 的 T**。现在的 `container<T>()` 对 T 没有约束，传一个没有 `T::node_offset()` 的类型会在模板展开时报一堆错。C++20 可以写：

```cpp
template<typename T>
concept HasNodeOffset = requires { { T::node_offset() } -> std::convertible_to<size_t>; };

template<HasNodeOffset T>
[[nodiscard]] inline T* container() const { ... }
```

错误信息直接说"T 不满足 HasNodeOffset"，不再是 300 行模板展开。

**2. Hash list（`hlist`）单独抽出**。`TaskStruct` 同时有 `list_node`（双向）和 `hash_node`。Hash bucket 在 head 端只需要单向链 + entry 端有 prev 指针（保留 O(1) 删除），Linux 为此定义了 `hlist_head` / `hlist_node`，head 端 8 字节而不是 16 字节。zonix 现在 hash bucket 的 head 也是完整 `ListNode`（16 字节），N 个 bucket 多用 8N 字节。不大，但抽出 `hlist` 后哈希表的 cacheline 利用率更好。

**3. Type-safe `ListHead<T>`**。`ListNode head_{};` 配 `T::from_list_link()` 反推宿主 —— 类型信息丢失。可以包成：

```cpp
template<typename T, ListNode T::* member>
class List {
public:
    void push_back(T& obj) { head_.add_before(obj.*member); }
    TypedIter<T> begin() { ... }   // 直接返回 T*
    [[nodiscard]] bool empty() const { return head_.empty(); }
private:
    ListNode head_{};
};

// 用法：
List<TaskStruct, &TaskStruct::list_node> proc_list;
for (TaskStruct* t : proc_list) { ... }   // 不再需要手动 from_list_link
```

调用方再也写不出 `ListNode* node`，永远拿到正确类型的 `T*`。代价是模板参数稍重；好处是 IDE 直接显示 `T*`、误用更早被编译期捕获。

**4. C++23 `deducing this` 简化迭代器**。C++23 的 explicit `this` 让 const / non-const 迭代器共用一份代码：

```cpp
template<typename Self>
auto&& operator*(this Self&& self) { return *self.cur; }
```

现在的 `Iterator` 模板已经够干净，但 view 类型（`ReverseView` / `CircularView`）能进一步简化 const-correctness。

**5. Lock-free intrusive list（atomic CAS）**。当 zonix 真的上 SMP，PMM free list 这种被多 CPU 高频争抢的链结构就需要 lock-free 版本。`std::atomic<ListNode*>` + CAS 双链有著名的 ABA 问题；可以从 Linux 的 RCU list / `llist`（单链 lock-free）借鉴。这是 SMP 路线图上的事，列在这里作为提示。

**6. Debugger 友好**。裸 `ListNode* prev; ListNode* next;` 在 GDB 里没有泛型信息，要手动 `(TaskStruct*)((char*)node - offsetof(...))` 反推。可以加 GDB python pretty-printer 让 `p proc_list` 直接展开成 `TaskStruct*` 列表。这是工程工具不是代码改动，但能显著降低读栈成本。

---

侵入式链表是内核数据结构的"汉语"—— 不会写一个，就基本写不出能用的内核。`std::list` / `std::vector` 在用户态闪闪发光，到了缺页处理器 / 中断处理 / 启动早期就是死亡陷阱。`container_of` 的宏在 C 内核里跑了 30+ 年，现代 C++ 给它的升级（`constexpr` 偏移、模板迭代器、`[[nodiscard]]`、C++20 concepts）不是为了显摆抽象能力，是为了把"靠人记得"的事变成"编译器保证"的事。

---

## 6. 迭代记录

<!-- 后续 list / 数据结构层的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-03-23：[`c0c8b1f`](https://github.com/leafvmaple/zonix-plus/commit/c0c8b1f) 现代化 list 迭代器，引入 `Iterator` / `ReverseView` / `CircularIterator`，调度器游标改用 `circular_from`（见 §3、§4）。
- 2026-03-04：[`7138771`](https://github.com/leafvmaple/zonix-plus/commit/7138771) 把 kernel 基础库归位到 `lib/`，`list.h` 进入当前路径。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
