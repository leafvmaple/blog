<!--pub:2026-04-18-->
# EventDispatcher 三次重写：双优先级链 + pending queue + 嵌套 dispatch 计数器

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的衍生深读
> 涉及子系统：`EventDispatcher` / `EventListener` / `Touch` 派发

`src/base/ZCEventDispatcher.cpp` 是 mini-cocos 里被改动最多的子系统 —— `git log --oneline src/base/ZCEventDispatcher.*` 列出 9 个 commit，其中 3 次是结构性重写：

```
fb4300f  feat(base): add Event and EventDispatcher with per-frame polling   ← v1
b3cc36c  feat(base): factor EventListener abstraction and add Application entry
db6b6dd  refactor(events): adopt cocos2d-x fixed / scene-graph priority lists ← v2
bf4b46a  refactor(events): use std::erase_if for listener cleanup
6c1d2b3  refactor(events): split keyboard and mouse listeners into separate files
90acab7  refactor(events): deduplicate dispatch paths in EventDispatcher    ← v3
bacb0f9  feat(ui): respect scene-graph occlusion in widget hit-testing
67633ba  refactor: simplify ActionInterval and tidy EventDispatcher
be88a31  feat(stl): route data-structure/algorithm STL through mstd alias
```

v1（`fb4300f`）：全局回调表，一周后被三个独立问题打穿。v2（`db6b6dd`）：双优先级链 + `EventListener` 对象，能跑但嵌套 dispatch 触发 listener 集合 mutate 时迭代器失效。v3（`90acab7`）：上 [`_inDispatch` 计数器 + 软删除 + pending queue](https://github.com/leafvmaple/blog/issues/4)，结构稳定至今。这一篇按时间顺序复盘三次迭代，说清楚**为什么"听起来很对"的 v1 几乎一定会被改掉**。

## 1. 第一版：全局回调表

最朴素的写法。每个事件类型对应一个回调 vector：

```cpp
std::unordered_map<EventType, std::vector<std::function<void(Event*)>>> _callbacks;

void dispatch(Event* e) {
    for (auto& cb : _callbacks[e->type]) cb(e);
}
```

写了大约一周就崩了。三个致命问题：

### 1.1 没法表达"事件可以被吞掉"

UI 按钮按下时，想要这个 touch 事件**不再向下传递**到背后的场景。`std::function<void(Event*)>` 没有返回值通道。改成 `std::function<bool(Event*)>` + 检查返回 false 时 break —— 但又遇到下一个问题：**优先级**。

### 1.2 没有优先级，导致 UI 永远拿不到事件

按钮和背景同时注册 touch 监听。第一个注册的先被调用，那就是先注册的 UI 框架代码先拿到事件，**但如果场景是动态生成的**，UI 可能在场景之后注册 —— 立刻乱套。

朴素加一个 int priority 字段不够，因为 UI 的优先级**逻辑上由它在场景图里的位置决定**：上层节点应该比下层节点先收到 touch。如果引擎硬编码 priority 数字，所有 UI 代码都要给数字，写出来一片魔数。

### 1.3 unregister 没办法（lambda 没法比较）

`std::function` 不能 `==`，导致 unregister 必须返回一个 handle。第一版用 `int id` 计数器，但 id 容易撞、跨场景管理还得手写 lifecycle。

## 2. 第二版：双优先级链 + EventListener 对象

第二版彻底重写。引入 `EventListener` 作为可命名、可比较的对象，并把优先级拆成**两套独立链**：

```cpp
class EventListener : public Ref {
public:
    enum class Type { TOUCH_ONE_BY_ONE, TOUCH_ALL_AT_ONCE,
                      KEYBOARD, MOUSE, CUSTOM, /* ... */ };

    std::function<bool(Event*)> onEvent;     // 返回 true = 吞掉
    Node* _associatedNode = nullptr;          // 跟节点绑生命周期，可选
    int   _fixedPriority  = 0;                // 数字优先级，可选
    bool  _registered     = false;
    bool  _enabled        = true;
};
```

注册时 EventDispatcher 根据是否绑了 Node 把 listener 分进两个 vector：

```cpp
struct EventListenerVector {
    std::vector<EventListener*> _fixedListeners;    // 按 _fixedPriority 升序
    std::vector<EventListener*> _nodeListeners;     // 按节点 scene-graph 顺序
};
std::unordered_map<EventType, EventListenerVector> _listenerMap;
```

派发顺序：

```cpp
void dispatch(Event* e) {
    auto& v = _listenerMap[e->type];
    // 优先级 < 0 的 fixed：UI 框架级最高优先级
    for (auto* l : negative_fixed(v)) if (run(l, e)) return;
    // scene-graph：上层节点先
    for (auto* l : v._nodeListeners)  if (run(l, e)) return;
    // 优先级 >= 0 的 fixed：默认背景
    for (auto* l : positive_fixed(v)) if (run(l, e)) return;
}
```

这个分段是 cocos2d-x 的经典设计，我完整借鉴了。它带来的语义是：

- **fixed priority < 0** = "我比任何节点都先"（debug overlay、modal dialog 框架、输入法）；
- **scene-graph** = "按场景图自然顺序"（绝大部分 UI / 游戏对象走这条）；
- **fixed priority > 0** = "兜底"（默认输入 handler、analytics）。

`run(listener, event)` 返回 true 表示事件被消费、停止派发；EventListener 的 `_enabled` 加一道短路。

### 2.1 但是 — 嵌套 dispatch 把它打穿了

第二版能跑通 90% 的场景。剩下 10% 的崩溃来自**事件 listener 里又派发了另一个事件**。

具体场景：按钮 listener 里 `dispatcher->dispatch(CustomEvent("button_clicked"))`，CustomEvent 的 listener 又对 listenerMap 做了 add / remove。回到外层正在迭代的 `_nodeListeners`，迭代器失效。

最初我用一个简单 bool 想兜：

```cpp
bool _isDispatching = false;
void dispatch(Event* e) {
    _isDispatching = true;
    // ...
    _isDispatching = false;
    sweep();
}
```

嵌套 dispatch 一返回，内层的 `_isDispatching = false` 把外层标志位也清掉，sweep 提前执行。同样崩。

## 3. 第三版：计数器代替 bool + 三件套

把 `_isDispatching` 换成 `_inDispatch` 计数器，并把 EventListenerVector 套上 [iterate-and-mutate 三件套](https://github.com/leafvmaple/blog/issues/4)：

```cpp
struct EventListenerVector {
    std::vector<EventListener*> _fixedListeners;
    std::vector<EventListener*> _nodeListeners;
    std::vector<EventListener*> _toAdd;
    int   _inDispatch = 0;
    bool  _dirtyFixed = false;
};

void EventDispatcher::dispatch(Event* e) {
    auto& v = _listenerMap[e->type];
    if (v._dirtyFixed) { sortFixed(v); v._dirtyFixed = false; }

    ++v._inDispatch;
    walkAndCallback(v, e);
    --v._inDispatch;

    if (v._inDispatch == 0) {
        std::erase_if(v._fixedListeners, isDead);
        std::erase_if(v._nodeListeners,  isDead);
        flushPending(v);
    }
}
```

注册时如果 `_inDispatch > 0` 进 `_toAdd`，注销时只翻 `listener->_registered = false`。嵌套场景下计数器要 == 0 才允许 sweep + flush，保证最外层 dispatch 看到的还是同一个 vector 状态。

这一版到现在没再改过。

## 4. 命中测试：单点 touch 怎么走完场景图

touch 事件比键盘事件复杂的地方在于**它需要先做命中测试**，再决定派发顺序。流程上是：

```
TouchBegan(x, y)
    ↓
对所有注册 TOUCH_ONE_BY_ONE 的 listener，按上面的三段顺序遍历
    ↓
对每个 listener，如果它绑了 Node：
    把 (x,y) 反变换到该 Node 的本地坐标
    判断是否落在 boundingBox 里
    如果 NO → 跳过这个 listener，继续
    如果 YES → 调 listener.onTouchBegan(touch)
        如果返回 true：
            把这个 listener 加入"claimed listeners"集合
            后续的 onTouchMoved / onTouchEnded 只通知 claimed 里的
            事件不再向下传递
        如果返回 false：
            继续下一个 listener
```

两个关键点经常被忽视：

### 4.1 modal dialog 怎么吞掉所有 touch

modal 不依赖 scene-graph 顺序（dialog 可能 z 序低但逻辑上覆盖一切）。做法是注册一个 `_fixedPriority = INT_MIN` 的全屏 listener，命中测试永远返回 true、onTouchBegan 永远返回 true。这样它在第一段（negative fixed）就把所有 touch 截走。

### 4.2 claimed listeners 是 touch 一对一的核心

如果某个 button 在 began 阶段 claim 了 touch，玩家手指滑出去，moved/ended 还是要送给这个 button —— 不能在每一次 moved 都重新做命中测试。这是"按钮按下后手指滑离才触发 cancel"这种交互的实现基础。`_claimedTouches: std::unordered_map<Touch*, std::vector<EventListener*>>` 在主循环维护，每个 touch 在 began 时填充、ended 时清空。

## 5. 和别的事件系统的比较

写完之后回头看，会发现 mini-cocos 的 EventDispatcher 跟下面这些系统几乎是同一族：

| 系统 | 等价概念 |
|---|---|
| Slate（UE4 UI） | `FReply::Handled()` ↔ listener 返回 true；命中测试反向遍历 widget tree ↔ scene-graph 段 |
| Qt | `event->accept()` / `ignore()` ↔ return true/false；`installEventFilter` ↔ negative fixed priority |
| DOM | capture phase ↔ scene-graph 自上而下；bubble phase 在 mini-cocos 里没做（2D 引擎一般用不到） |
| GTK | signal handler 返回 `GDK_EVENT_STOP` / `PROPAGATE` ↔ return true/false |

差别主要在两个维度：
- **是否有 bubble**：DOM/GTK 有，cocos / Slate 没有。理由：2D 游戏的"父节点接 touch"语义少见，按节点 z 序自上而下走一遍命中谁谁拿就够用。
- **优先级是否独立于树结构**：DOM 几乎完全靠树；mini-cocos 有 fixed priority 这一支专门绕开树，方便实现 modal、debug overlay。

如果未来要加复杂 UI 框架，把 bubble 阶段补上不需要改 EventDispatcher 主结构 —— 在 walkAndCallback 后追加一个反向遍历就行。**预留口在 walk 阶段而不是 listener 数据结构里**，这是有意为之的。

## 6. 三件事必须在第一版考虑完

**优先级、生命周期、嵌套调用安全** —— 它们不会随项目长大而自动出现；缺哪一个，过几周一定会写一个"专门绕过 EventDispatcher"的偷渡通道。等到偷渡通道写到三四条，就要全部推倒重来。具体到 API 表面：

- 任何"回调"系统，第一个参数都该是回调对象（listener），不要直接吃 `std::function` —— 优先级、enable/disable、按对象/节点批量 remove 才有地方挂。
- 派发函数永远要支持嵌套，用计数器不要用 bool。
- 软删除 + pending add，永远默认就走 —— 即使第一版用不上，做对成本极低，做错成本极高。

## 7. 迭代记录

<!-- 后续 EventDispatcher 的演进追加在这里。bubble 阶段、手势识别合成、多 touch 优化等。 -->

- 2026-05-22：[`67633ba`](https://github.com/leafvmaple/mini-cocos/commit/67633ba) 顺手清理 EventDispatcher —— 把 dispatch 路径里几处重复的 priority 比较 / `_inDispatch` 检查合并，header 里把不再需要外露的 helper 收回 private。行为无变化，纯结构整理。本文第 3 节里那套"三件套"代码骨架基本就是清理后的样子。

---

*仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本文属于 [mini-cocos 系列](https://github.com/leafvmaple/blog/issues/2)；三件套通用 pattern 见 [#4](https://github.com/leafvmaple/blog/issues/4)。*
