<!--pub:2026-04-10-->
# 迭代中 erase 自己：iterator 失效的 bug 一周才显形一次

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的衍生深读
> 涉及子系统：`Scheduler` / `EventDispatcher`，以及任何"在遍历中可能被修改"的系统

这个 pattern 在 mini-cocos 三个独立子系统里以相同的形态出现：

```
$ wc -l src/base/ZCScheduler.cpp src/base/ZCActionManager.cpp src/base/ZCEventDispatcher.cpp
  232 src/base/ZCScheduler.cpp
  167 src/base/ZCActionManager.cpp
  394 src/base/ZCEventDispatcher.cpp
  793 total
$ grep -rE "_pending|_inDispatch|_dirty.*Priority" src/base/ZCScheduler.cpp \
                                                   src/base/ZCActionManager.cpp \
                                                   src/base/ZCEventDispatcher.* | wc -l
30+                         # 三套子系统共用同一套 pending + tombstone + dirty 标志
```

特点是"语言/框架无关、出现频率高、做错时症状极隐蔽"三条全占。这一篇把它从 `Scheduler` / `ActionManager` / `EventDispatcher` 里抽出来，单独说清楚什么时候要用、怎么实现、有哪些反模式。

## 1. 问题的本体：迭代器失效与"自咬"

最经典的版本是 Scheduler：

```cpp
void Scheduler::update(float dt) {
    for (auto& e : _entries) {
        if (!e.cancelled) e.callback(dt);   // 用户 callback
    }
}
```

callback 里完全合法地调用 `schedule(...)` 或 `unschedule(...)` —— 它对 `_entries` 做了 `push_back` 或 `erase`，**于是当前正在执行的 for 循环的迭代器立刻失效**。

- `push_back` 触发 vector reallocation → 整段循环的 `&e` 全是悬挂指针。
- 对正在指向的 entry 做 `erase` → UAF。
- 对队列中段的 entry 做 `erase` → 后续遍历跳过一项。

这一类 bug 的**症状不稳定**：内存够时 reallocation 概率低，跳过一项可能恰好命中无关 entry。线上一周才崩一次的那种。

EventDispatcher 完全同型，只是触发路径多一层（listener 自己在事件回调里又 add/remove listener）。

## 2. 三件套解法

cocos2d-x 把所有这一类系统都收敛到下面三件套，mini-cocos 完整继承：

### 2.1 Pending queue：新增操作延迟到下一轮

```cpp
struct Scheduler {
    std::vector<Entry> _entries;          // 正在被遍历的主队列
    std::vector<Entry> _pendingAdds;      // 本轮新增，下轮 flush
    bool               _isUpdating = false;
};

void Scheduler::schedule(Entry e) {
    if (_isUpdating) {
        _pendingAdds.push_back(std::move(e));   // 不动主队列
    } else {
        _entries.push_back(std::move(e));
    }
}
```

`_pendingAdds` 在每帧 update 的**开头**或**结尾**统一 flush 进 `_entries`。这样 update 期间主队列指针/迭代器永远稳定。

flush 时机的两个选择：
- **开头 flush**：新注册的 entry 当帧就能跑到一次。适合"立刻见效"语义（如帧 N 注册一个 onUpdate）。
- **结尾 flush**：新注册的 entry 下一帧才跑。适合避免"注册时副作用"。

mini-cocos 选了**结尾 flush**，理由是"注册行为不应该在注册同一帧里产生副作用"—— 这对调试更友好（如果 callback 里又 schedule，副作用至少要到下一帧才放大）。

### 2.2 软删除：cancelled 标志位

```cpp
void Scheduler::unschedule(Handle h) {
    if (auto* e = find(h)) e->cancelled = true;
}
```

注意：**没有 `erase`**，只翻一个 bool。真正的 erase 留给 update 跑完之后的 sweep 阶段：

```cpp
void Scheduler::update(float dt) {
    _isUpdating = true;
    for (auto& e : _entries) {
        if (!e.cancelled) e.callback(dt);
    }
    _isUpdating = false;

    std::erase_if(_entries, [](const Entry& e){ return e.cancelled; });
    if (!_pendingAdds.empty()) {
        std::move(_pendingAdds.begin(), _pendingAdds.end(), std::back_inserter(_entries));
        _pendingAdds.clear();
        _dirtyOrder = true;
    }
}
```

软删除有两个隐藏好处：
- callback 内 unschedule 自己 → 只是翻 bool，对当前迭代无影响。
- callback 内 unschedule 别人 → 翻别人的 bool，本帧那个别人的 callback 在 `if (!e.cancelled)` 这一关被拦下，**不会再被调用**，但也不会破坏遍历。

`std::erase_if` 比 erase-remove 写法少一处错位机会（不会漏 `v.end()`），这是后来一个小 commit 替换掉的（见主文 §11.2）。

### 2.3 脏排序：dirty flag，整帧只排一次

```cpp
struct Scheduler {
    bool _dirtyOrder = false;
};

void Scheduler::schedule(Entry e) {
    // ...
    _dirtyOrder = true;
}

void Scheduler::update(float dt) {
    if (_dirtyOrder) {
        std::stable_sort(_entries.begin(), _entries.end(),
                         [](auto& a, auto& b){ return a.priority < b.priority; });
        _dirtyOrder = false;
    }
    // ... 然后才遍历
}
```

每次 schedule/unschedule 只翻 bool，**真正的排序留到下一次 update 开头一次性做完**。多个注册在一帧内合并成一次排序，避免每次注册 O(n log n)。

`stable_sort` 不是随便选的：相同优先级的 entry 要保持注册顺序，否则同优先级 listener 调用顺序会随帧抖动，下游 bug 没法复现。

## 3. EventDispatcher 是同型问题，只是多了一维

EventDispatcher 的复杂度在于它有**两条独立的优先级链**（fixed priority + scene-graph priority），但每一条链上三件套是一模一样的：

```cpp
struct EventListenerVector {
    std::vector<ListenerEntry> _fixedListeners;
    std::vector<ListenerEntry> _nodeListeners;
    std::vector<ListenerEntry> _toAdd;          // pending
    bool _dirtyFixed = false;
    bool _dirtyNode  = false;
    int  _inDispatch = 0;                       // 嵌套 dispatch 计数
};
```

注意 `_inDispatch` 是计数器不是 bool —— 因为事件可以**嵌套派发**（一个事件的 listener 内部 dispatch 另一个事件）。只有当所有嵌套退完，`_inDispatch == 0`，才能 sweep 软删除项和 flush pending。

这套语义直接搬过来就行，不需要重新发明。详细的 EventDispatcher 设计见这一系列的事件篇（issue #5）。

## 4. 适用范围：远不止引擎

抽出来之后会发现这个 pattern 在很多地方都见过同款：

| 领域 | 同型场景 |
|---|---|
| ECS | 系统 update 中 spawn/destroy 实体；典型实现 `commands.queue()` 延迟执行（Bevy / EnTT 都有） |
| 服务端 tick loop | 心跳遍历玩家时玩家断线 / 加入；都走 pending join queue + pending leave set |
| UI 框架 | layout pass 中触发 invalidate；React reconciler 显式有"update queue"延迟到下一 tick |
| OS 内核 | RCU（read-copy-update）本质就是软删除 + grace period 后真删 |
| GC | 标记-清除阶段不能直接 free，要等所有 mark 完成 |

凡是**"在遍历过程中可能修改被遍历容器，并且修改方可能就是 callback 自己"**的系统，都会演化出这套结构。把它当作通用工具掌握后，新写一个调度类系统几乎是肌肉记忆。

## 5. 常见反模式

写过几次之后能总结出几条"看似对、其实错"的简化：

### 反模式 A：用 `std::list` 假装解决问题

"链表 erase 不会让其它迭代器失效，所以可以在循环中 erase。" 是对一半 —— `list::erase` 确实不影响别的节点，但：
- 在循环里 `erase` 当前节点要先存 next，写法很别扭。
- 在循环里 `push_back` 一个新节点，下一轮**会遍历到它**，触发"刚注册就立刻跑一次"，常常违反预期。
- list 的 cache miss 比 vector 显著高，对每帧 O(n) 遍历不划算。

软删除 + pending queue 在 vector 上更稳更快。

### 反模式 B：拷一份再遍历

```cpp
auto snapshot = _entries;
for (auto& e : snapshot) e.callback(dt);
```

确实安全了，但：
- 每帧多一次 vector 拷贝，对几百个 listener 来说不划算。
- callback 看到的 `e` 是 snapshot 的元素，对 entry 内部状态的修改不会同步回去。这种 bug 比迭代器失效更隐蔽。

### 反模式 C：递归调用主循环

EventDispatcher 嵌套 dispatch 时如果没有 `_inDispatch` 计数，简单地用 bool `_isDispatching` 切换 → 嵌套 dispatch 一返回就把外层的 dispatch 标志位也清掉 → sweep 提前执行 → 外层循环正在迭代的 entry 突然被 erase。**计数器代替 bool** 是这一类嵌套场景的通用解。

### 反模式 D：把 sweep 提前到 unschedule 里

"既然要 sweep，为什么不在 unschedule 时立刻删除？" —— 因为你**不知道 unschedule 是不是在 update 内部被调用的**。如果是，回到了一开始的迭代器失效问题。要么每个 mutator API 都接 `if (_isUpdating)` 分支判断，要么干脆统一推迟到 update 结尾。后者代码量更少、错误面更小。

## 6. 实现模版

下面这个最小骨架，是我后续每写一个新的"遍历可能被修改"系统时直接抄的：

```cpp
template <class Entry>
class TickSystem {
public:
    using Handle = std::size_t;

    Handle add(Entry e) {
        e.id = _nextId++;
        if (_inUpdate > 0) _pending.push_back(std::move(e));
        else { _entries.push_back(std::move(e)); _dirty = true; }
        return _entries.back().id;
    }

    void remove(Handle h) {
        auto markCancelled = [&](auto& v) {
            for (auto& e : v) if (e.id == h) { e.cancelled = true; return true; }
            return false;
        };
        markCancelled(_entries) || markCancelled(_pending);
    }

    template <class F>
    void update(F&& fn) {
        if (_dirty) { sort(); _dirty = false; }

        ++_inUpdate;
        for (auto& e : _entries) {
            if (!e.cancelled) fn(e);
        }
        --_inUpdate;

        if (_inUpdate == 0) {
            std::erase_if(_entries, [](auto& e){ return e.cancelled; });
            if (!_pending.empty()) {
                std::move(_pending.begin(), _pending.end(), std::back_inserter(_entries));
                _pending.clear();
                _dirty = true;
            }
        }
    }

private:
    std::vector<Entry> _entries;
    std::vector<Entry> _pending;
    int  _inUpdate = 0;
    bool _dirty    = false;
    Handle _nextId = 0;

    void sort() {
        std::stable_sort(_entries.begin(), _entries.end(),
                         [](auto& a, auto& b){ return a.priority < b.priority; });
    }
};
```

90% 的"在遍历中修改"问题套这个模版就解决了。剩下 10% 的复杂情况（嵌套优先级、跨 entry 通讯、按 type bucket 分桶）都是这个骨架的修饰。

## 7. 迭代记录

<!-- 后续涉及这套 pattern 的演进追加在这里，按时间倒序。 -->

*暂无。*

---

*仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本文属于 [mini-cocos 系列](https://github.com/leafvmaple/blog/issues/2)。*
