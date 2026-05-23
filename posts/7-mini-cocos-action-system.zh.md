# `update(t∈[0,1])` 是复合 Action 代数化的唯一前提

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的衍生深读
> 涉及子系统：`Action` / `ActionInterval` / `Sequence` / `Spawn` / `EaseFunction`

mini-cocos 的 Action 系统几乎是直接搬 cocos2d-x 的设计。`src/base/ZCAction*.cpp/h` 共 1,082 行实现 `Sequence` / `Spawn` / `Ease` / `Repeat` / `RepeatForever` 以及一系列具体 tween（`MoveTo` / `MoveBy` / `RotateTo` / …），全部建立在一条 API 契约上：

```cpp
// src/base/ZCActionInterval.h
class ActionInterval : public FiniteTimeAction {
public:
    virtual void update(float t) = 0;   // ★ t 永远是 [0, 1] 的归一化时间
};
```

这套设计**真正聪明的地方不在 `Sequence` 或 `Spawn`，而在 `update(float t)` 的契约本身**：`t` 永远 ∈ [0, 1]。这一条约束是 1,082 行能用纯函数式组合任意嵌套的根本原因 —— `Ease(action, easeFn)` 退化成 `update(easeFn(t))`、`Sequence(A, B)` 退化成根据 `t` 落在哪一段做 `A.update(t/k)` 或 `B.update((t-k)/(1-k))`。下面把这条结论从朴素写法逆推回去。

## 1. 朴素写法的问题

最直接的 tween 写法：

```cpp
class MoveTo {
    Vec2  start, end;
    float duration;
    float elapsed = 0;

    void update(float dt) {
        elapsed += dt;
        float t = elapsed / duration;
        target->setPosition(lerp(start, end, t));
        if (elapsed >= duration) done = true;
    }
};
```

写一个能跑，但**组合就崩**。假设要做"先 MoveTo 再 FadeIn"：

```cpp
class Sequence {
    std::vector<Action*> actions;
    size_t current = 0;
    void update(float dt) {
        actions[current]->update(dt);
        if (actions[current]->done) ++current;
    }
};
```

`Sequence` 现在自己也吃 dt，每个 child 也吃 dt —— **dt 的语义变成"绝对秒"**。问题：

- 想要把整个 Sequence 加速 2x，需要遍历所有 child 改 duration。
- 想给 Sequence 套 EaseInOut，没法做 —— ease 函数是 `t → t'`（归一化时间），但 dt 是绝对时间，没有可改的"位置参数"。
- 想要 `Repeat(action, 3)`，得检测每个 child 的 done，重置时还要把 elapsed 减掉 duration —— 一堆边界条件。

## 2. 关键转向：`update(float t)`，t ∈ [0, 1]

cocos2d-x 的设计是：

```cpp
class ActionInterval : public Action {
public:
    float duration;        // 我自己有多长
    float elapsed = 0;

    // 引擎主循环喂的是 dt
    void step(float dt) {
        elapsed += dt;
        float t = std::clamp(elapsed / duration, 0.0f, 1.0f);
        update(t);                                        // 关键：t 是 [0,1]
        if (elapsed >= duration) done = true;
    }

    virtual void update(float t) = 0;                     // 子类只重写这个
};
```

具体 action：

```cpp
class MoveTo : public ActionInterval {
    Vec2 start, end;
    void update(float t) override {
        target->setPosition(lerp(start, end, t));
    }
};

class FadeIn : public ActionInterval {
    void update(float t) override {
        target->setOpacity(static_cast<uint8_t>(255 * t));
    }
};
```

`update(t)` 只关心"现在进度是百分之多少"，**不关心总时长是多少**。这个简单的契约改变让所有 combinator 变得自然。

## 3. 三个 combinator 的实现

### 3.1 Sequence

```cpp
class Sequence : public ActionInterval {
    std::vector<ActionInterval*> children;
    std::vector<float> cumulative;   // 累积归一化时间分段
public:
    Sequence(std::vector<ActionInterval*> cs) : children(std::move(cs)) {
        duration = 0;
        for (auto* c : children) duration += c->duration;
        float acc = 0;
        for (auto* c : children) {
            acc += c->duration / duration;
            cumulative.push_back(acc);      // 例如 [0.3, 0.6, 1.0]
        }
    }

    void update(float t) override {
        // 找 t 落在哪个 child 区间
        size_t i = 0;
        while (i + 1 < cumulative.size() && t > cumulative[i]) ++i;
        float prev = (i == 0) ? 0 : cumulative[i - 1];
        float localT = (t - prev) / (cumulative[i] - prev);
        children[i]->update(std::clamp(localT, 0.0f, 1.0f));
    }
};
```

`Sequence` 自己也是一个 `ActionInterval`，duration = 各 child duration 之和。`update(t)` 时把全局 t 反算到当前 child 的局部 t。注意：**它从不直接吃 dt**，它的 dt 流由父级（最终是 ActionManager）通过 step 函数喂下来。

### 3.2 Spawn

```cpp
class Spawn : public ActionInterval {
    std::vector<ActionInterval*> children;
    void update(float t) override {
        for (auto* c : children) {
            float localT = std::min(1.0f, t * (duration / c->duration));
            c->update(localT);
        }
    }
public:
    Spawn(std::vector<ActionInterval*> cs) : children(std::move(cs)) {
        duration = 0;
        for (auto* c : cs) duration = std::max(duration, c->duration);
    }
};
```

`Spawn` 并行执行多个 child，duration = max(children.duration)。每个 child 的局部 t 是按它自己的 duration 等比放大。如果某个 child 比 Spawn 短，它会在 `t = duration_child / duration_spawn` 时达到 1.0 然后 saturate。

### 3.3 EaseInOut（装饰器）

```cpp
class EaseInOut : public ActionInterval {
    ActionInterval* inner;
    void update(float t) override {
        // t' = 3t² - 2t³（cubic Hermite）
        float et = t * t * (3 - 2 * t);
        inner->update(et);
    }
public:
    EaseInOut(ActionInterval* a) : inner(a) { duration = a->duration; }
};
```

ease 函数只在归一化 t 上做映射 —— 这是**只有 `update(t)` 契约才能做到的**事。如果还是吃 dt，ease 就要把 dt 也做非线性变换，会破坏"累加 dt 得到 elapsed"的几何意义。

### 3.4 Repeat / Reverse / DelayTime

补齐几个常用的：

```cpp
class Repeat : public ActionInterval {
    ActionInterval* inner;
    int times;
    void update(float t) override {
        float scaled = t * times;
        float localT = scaled - std::floor(scaled);
        if (scaled >= times) localT = 1.0f;
        inner->update(localT);
    }
public:
    Repeat(ActionInterval* a, int n) : inner(a), times(n) {
        duration = a->duration * n;
    }
};

class DelayTime : public ActionInterval {
    void update(float) override {}    // 真的什么都不做
public:
    explicit DelayTime(float d) { duration = d; }
};

class Reverse : public ActionInterval {
    ActionInterval* inner;
    void update(float t) override { inner->update(1.0f - t); }
public:
    explicit Reverse(ActionInterval* a) : inner(a) { duration = a->duration; }
};
```

`DelayTime::update` 是空的，但它有 duration —— `Sequence` 在算累积时段时会正确给它一份时间。这是引擎里少见的"做'什么都不做'的事是关键功能"的例子。

## 4. 时间线示意

考虑一个略复杂的复合 action：

```cpp
auto move = MoveTo::create(2.0f, {100, 0});
auto fade = FadeIn::create(1.0f);
auto delay = DelayTime::create(0.5f);
auto rot  = RotateBy::create(1.0f, 90);

auto seq = Sequence::create({
    Spawn::create({move, fade}),     // 2.0s
    delay,                           // 0.5s
    rot                              // 1.0s
});
// 总时长 3.5s
```

时间线（横坐标是秒，纵坐标是 t）：

```
0s        2s    2.5s    3.5s
|---------|-----|-------|
[ Spawn       ][delay][ rot ]
  |__ move (2s, t 直接走)
  |__ fade (1s, 在 t=0..0.5s 内 t 走完)
```

主循环每帧把 dt 喂给 ActionManager → ActionManager 喂给 seq.step(dt) → seq.step 推进 elapsed/duration → seq.update(t) → 算出当前在哪段 child → child.update(localT)。所有递归都是 `update(t)` → `update(t')`，没有任何"dt 在递归中传"的代码。

## 5. ActionManager：上层调度

```cpp
class ActionManager {
    std::vector<std::pair<Node*, ActionInterval*>> _running;
    // 三件套：pending、cancelled、dirty
    void update(float dt) {
        // ... iterate-and-mutate 三件套（见 issue #4）
        for (auto& [node, action] : _running) {
            action->step(dt);
            if (action->done) /* mark cancelled */;
        }
    }
};
```

ActionManager 是唯一一处把 dt 喂进 Action 树的入口。它内部走 [iterate-and-mutate 三件套](https://github.com/leafvmaple/blog/issues/4)，因为 action 的 `update` 里完全可能调 `node->runAction(another)` —— 又是经典的"遍历时修改"。

## 6. 设计哲学：归一化 t 让你能写"代数"

回头看，整套系统能写成几行的关键是**所有 action 共用同一个"形状"`update(float t)`**。这让它们之间可以做组合：

- 串联（Sequence）= 把全局 t 切段。
- 并联（Spawn）= 把全局 t 等比映射给每个 child。
- 装饰（Ease / Reverse / Repeat）= 把全局 t 做一次非线性变换再传给 child。

如果你把 `update(t)` 看成 `f: [0,1] → 副作用`，那么 Sequence/Spawn 是这些函数的代数运算（分段拼接、并行）。这跟函数式社区那一套"Tween 是 a → b 的态射，可组合"是完全一回事，只是 cocos2d-x 早就用 C++ 写出来了。

> 这个 pattern 我后来在很多无关地方都用到：
>
> - 自己写一个动画时间线编辑器时直接复用了这套结构（编辑器存的是组合树，导出时序列化成 JSON，运行时反序列化成同样的 Action 树）。
> - 服务端做"奖励发放序列"（拉数据 → 计算 → 派发邮件 → 通知）时把 step 写成 `step(progress) -> next_step`，组合方式照搬。
>
> **任何"一段过程，可以加速/减速/串/并/重复"的问题都是这个形状的。**

## 7. 实现细节里两个易错点

### 7.1 t = 1 时要 update 一次

```cpp
void step(float dt) {
    elapsed += dt;
    if (elapsed >= duration) {
        update(1.0f);          // 必须显式喂一次 1.0
        done = true;
    } else {
        update(elapsed / duration);
    }
}
```

如果不喂 1.0，最后一帧的 t 可能是 0.97，target 永远停在 97% 的位置上。这种 bug **肉眼几乎看不出**（差一像素，差几个不透明度），但视觉上"动画总是没收住"。一定要在 done 时强制喂一次 1.0。

### 7.2 同一个 Action 不能加给两个 Node

```cpp
auto a = MoveTo::create(...);
node1->runAction(a);
node2->runAction(a);    // ❌ 共享 elapsed 和 target，两边互相干扰
```

Action 持有 `target` 和 `elapsed` 状态，不可重入。要给两个 Node 用，复制一份（或在 runAction 内部 clone）。cocos2d-x 原版是显式 `clone()` 函数，mini-cocos 偷懒在 runAction 内部 retain + clone，提供 share-by-value 语义。

## 8. 迭代记录

<!-- 后续 Action 系统的演进追加在这里。Tween path、Bezier、自定义 ease 等。 -->

- 2026-05-22：[`67633ba`](https://github.com/leafvmaple/mini-cocos/commit/67633ba) 把 `ActionInterval` 砍掉了约 80 行重复代码 —— 原版里 `step()` / `update()` / 边界处理在 MoveTo / FadeIn / Sequence 各自重复实现了一遍，这次抽到基类的 step 模板里、子类只 override `update(t)`。本文第 2 节示范的那个"鸡形 API"就是这次清理后的样子。事实上正是先写完本文、再去看代码时发现重复，顺手清掉的 —— 写博文回头会反推代码改进，这本身是把写作纳入工程闭环的好处。

---

*仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本文属于 [mini-cocos 系列](https://github.com/leafvmaple/blog/issues/2)。*
