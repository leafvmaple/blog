<!--pub:2026-04-05-->
# `shared_ptr` 没有的语义：autorelease 的"这一帧死"

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的衍生深读
> 涉及子系统：`Ref` / `AutoreleasePool` / `TextureCache` / `Animation`

mini-cocos 当前的内存模型分布（grep 实测）：

```
$ grep -rE "\bautorelease\(\)|->retain\(\)|->release\(\)" src/ | wc -l
56                          # Ref + autorelease (cocos 风) 的调用点
$ grep -rE "\bunique_ptr<|mstd::make_unique" src/ | wc -l
21                          # std::unique_ptr 单一所有权
$ grep -rE "\bshared_ptr<|make_shared" src/ | wc -l
0                           # shared_ptr —— 一处也没有，且是有意为之
```

三个数字对应三种不同的对象生命周期策略：**`Ref` + autorelease 处理「值对象 + 场景图节点 + Lua 暴露对象」、手写 refcount 处理「GPU/IO 资源」、`unique_ptr` 处理「单一所有者的内部组件」**。`shared_ptr` 的 0 不是偶然，是设计立场 —— 下面 §2 详述。

这一篇把每种模型在 mini-cocos 里的具体职责写清楚，重点放在"什么时候**不该**用引用计数"和"为什么坚决不用 `shared_ptr`"这两条上 —— 是整套体系里最容易被忽视、做错最难发现的地方。

## 1. `Ref` + AutoreleasePool 在做什么

```cpp
class Ref {
public:
    void retain();           // ++_referenceCount
    void release();          // 计数归零时 delete this
    void autorelease();      // 把自己丢进当前帧的 AutoreleasePool
private:
    unsigned int _referenceCount = 1;
};
```

如果只看这段代码，会觉得它就是个手写版 `std::shared_ptr`。但 `autorelease()` 这一行才是 cocos2d-x 抽象的真正核心：

- `Sprite::create()` 内部做 `obj->autorelease(); return obj;` —— 调用方拿到的是一个"这一帧结束如果没人 retain 就消失"的对象。
- 这一帧内 `addChild(sprite)` 会触发父节点的 `retain`；如果调用方什么也不做就丢掉局部变量，sprite 在 pool drain 时自然销毁，没有泄漏。
- AutoreleasePool 本身是一个**显式作用域**对象，引擎在主循环每帧 push 一个；可以在某些重负载场景（批量构造 / 反序列化）手动 push/pop 一个嵌套 pool，让短命对象立刻被回收，不等到帧末。

这个机制最大的优点 —— 也是 `shared_ptr` 永远学不来的 —— 是它把"对象的默认生命周期"定为**这一帧**。2D 引擎里的临时几何、临时 label、effect 对象 90% 都符合这个模式：调用方根本不想思考释放问题。

## 2. 为什么不直接上 `std::shared_ptr`

从纯现代 C++ 视角，这一层"应该"是 `std::shared_ptr` + `std::enable_shared_from_this`。我没用，有两个**不可替代**的理由：

### 2.1 Lua 绑定要求"C++ 永远是主"

Lua userdata 的 `__gc` 触发时间由 Lua GC 自己决定 —— 可能远晚于 C++ 期望的销毁时机。如果用 `shared_ptr` 表达所有权，那么：

```lua
local s = Sprite:create()
scene:addChild(s)
-- 一段时间后：
scene:removeAllChildren()
-- 但 lua 局部变量 s 还在，shared_ptr 的引用计数 >= 1
-- 引擎想"立刻释放整个场景"做不到
```

C++ 这边永远不知道 Lua 还持有多少份所有权。换成 `Ref` 之后，**Lua userdata 在绑定层显式 `retain()` 一次**，并在 `__gc` 里 `release()`。这样：

- 销毁场景 → 引擎主动把所有节点 `release()`；
- Lua 局部变量 s 还在 → 它持有的 userdata 只是一个被 retain 过的句柄，**对象本身可能已经被 release 到 0 然后 delete 了**；
- 这意味着 Lua 那一侧"必须 check is-alive"才能再用 —— mini-cocos 在绑定层加了一个 `_alive` 标志位，访问已死对象时抛 Lua 错误而不是 UAF。

这个设计的本质是：**所有权在 C++ 一侧，Lua 持的本质上是弱引用**。`shared_ptr` 的对称所有权语义和这个目标天然冲突。

### 2.2 "帧粒度延迟销毁" `shared_ptr` 没法表达

```cpp
auto* s = Sprite::create();   // refcount=1, 已 autorelease
if (some_cond) {
    scene->addChild(s);       // retain → refcount=2
}
// 离开作用域；s 没被任何变量持有
// 帧末 pool drain → release → refcount=1（如果没 add）或 1（如果 add 了）
// add 了的话：scene 持有 1 份，正常活；
// 没 add 的话：refcount→0，delete。
```

用 `shared_ptr` 写等价代码，没有 add 的分支就要求调用方写 `auto s = std::make_shared<Sprite>(...)` 然后让 RAII 处理 —— **但一旦 add 了，shared_ptr 在 add 函数返回时引用就增加，调用方那一份 RAII 没有意义**。本质上 `shared_ptr` 把"是否被持有"的判断时机定在每个赋值/析构点，而 autorelease 把它统一定在"帧末"。**对游戏循环来说，帧末才是天然的判定时机**。

### 2.3 接受的代价

- 忘记 retain / 多 release → UAF。
- 循环引用要靠人工打破（mini-cocos 里 parent → child 是强引用、child → parent 是裸指针）。

这些坑是 cocos2d-x 历史上反复出现的真问题。mini-cocos 里我只接受一个固定约定来兜底：**任何 `create()` 返回的对象都已 autoreleased；如果要存到成员变量，必须立刻 `retain()`，并在析构里 `release()`**。这条规则一旦执行，95% 的生命周期 bug 就消失了。

## 3. TextureCache 反例：GPU 资源不能走 autorelease

```cpp
struct Entry {
    TextureHandle texture;
    Size          pixelSize;
    int           refCount;     // 手写计数，不继承 Ref
};
std::unordered_map<std::string, Entry> _entriesByKey;
```

**TextureCache 里的 Entry 故意没继承 `Ref`**，它走的是**手写、即时**的引用计数。

为什么？因为 autorelease 的语义是"等到帧末才销毁"。GPU 资源不能这样：

- 切场景时，旧场景的 unload 必须**当场释放 GPU 显存**，否则下一帧加载新场景就是**显存峰值翻倍**。手机端这是 OOM crash。
- GPU 资源还隐含一条"被 GPU 占用"的限制 —— 在 Vulkan 后端，texture 释放必须等到 fence 信号（GPU 真的不再使用），引擎里需要一个显式的 `pendingDeletion` 队列。这套机制和 autorelease pool 在语义上是冲突的：autorelease 是"延迟一帧再 delete"，pendingDeletion 是"延迟到 GPU 不再用才 delete"。混在一起没法清晰描述。

所以 TextureCache 走**显式 refcount**：
- 调用方拿到 Entry 后必须自己 `++refCount`；
- unload 时 `--refCount`，归零时**当场进 pendingDeletion 队列**（Vulkan）或**当场 glDeleteTextures**（GL）。
- TextureCache 自己拥有缓存里的一份逻辑引用，提供 `purgeUnreferenced()` 把外部引用为 0 的 entry 全部清理。

这跟 cocos2d-x 原版的 `TextureCache` 设计是一致的；区别只是我把它从 `Ref` 子类降级成了 POD struct + 手写计数，**降低了表面 API 但去掉了 autorelease 的歧义**。

## 4. Animation 正例：值对象就交给 autorelease

```cpp
class Animation : public Ref {
    std::vector<Rect> _frames;     // UV 元数据
    float _delayPerFrame;
};
```

`Animation` 仅仅是一堆 UV 元数据 + 一个帧延时常量，没有任何外部资源句柄。它的销毁哪怕延迟若干帧也完全没影响。继承 `Ref` 之后：

```cpp
auto* anim = Animation::createWithFrames(frames, 0.1f);  // autoreleased
sprite->runAction(Animate::create(anim));                 // Animate 内部 retain
// 调用方什么也不用做
```

这是 `Ref` 体系最舒服的用法：临时构造、交给目标对象消费、自己不持有 —— 调用方代码里几乎看不到生命周期相关的字符。

ref-counting 不是宗教，是工具：**资源**（GPU 显存、文件句柄、socket）必须显式、即时释放，走手写 refcount；**值对象**（动画元数据、配置、消息）适合 autorelease pool；**跨 C++/脚本边界的对象**走 `Ref`，让 C++ 一侧保持所有权主导。一套引擎里两套甚至三套内存模型并存是常态，不是设计缺陷 —— **用一种模型解决所有问题才是设计缺陷**。

## 5. 决策矩阵

mini-cocos 里我用下面这张表做内存模型的决策。新增类型时按表查一下，不要凭感觉：

| 对象特征 | 推荐模型 | 例子 |
|---|---|---|
| 持有 GPU/IO 资源、释放必须立即生效 | 手写 refcount，**不**继承 `Ref` | Texture、VertexBuffer、Sound |
| 只持有元数据 / 计算结果 / 消息 | `Ref` + autorelease | Animation、Event、Rect、ValueMap |
| 场景图节点、需要被 add/remove | `Ref` + autorelease | Node、Sprite、Label、Scene |
| 跨 Lua 边界且 Lua 会持有句柄 | `Ref`（让 C++ 主导所有权） | 一切暴露给 Lua 的类 |
| 纯 C++ 内部、生命周期与某个所有者绑定 | `std::unique_ptr` 成员 | RenderDevice 内部的 pipeline cache |
| 多个独立所有者、生命周期完全对称 | `std::shared_ptr` | 目前 mini-cocos 里**没出现** |

最后一行不是凑数，是设计立场：**如果发现一个对象"似乎需要 `shared_ptr`"，先反问一次"它真的有多个对称所有者吗"**。绝大多数时候答案是"没有，只是我懒得想清楚谁是主"。

## 6. 迭代记录

<!-- 后续 mini-cocos 在内存管理上的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句话说明。 -->

- 2026-05-22：[`be88a31`](https://github.com/leafvmaple/mini-cocos/commit/be88a31) 把全引擎的 STL 调用从 `std::` 收敛到 `mstd::` 别名（背靠 [zstl](https://github.com/leafvmaple/zstl) 子模块），为把 mini-cocos 嵌进自制 OS 做铺垫。这一刀切的是"标准库依赖"那条接缝，和本文讨论的"对象生命周期"接缝正交。详见 [#10 Freestanding STL via mstd/zstl](https://github.com/leafvmaple/blog/issues/10)。

---

*仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本文属于 [mini-cocos 系列](https://github.com/leafvmaple/blog/issues/2)。*
