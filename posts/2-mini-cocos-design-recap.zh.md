# 用 1500 行 C++ 写一个 mini cocos2d-x：mini-cocos 的设计复盘

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 提交跨度：2026-03-25 → 2026-05-14，22 次有效提交
> 体量：~1500 行 C++17，CMake + GLFW + Lua 5.4，OpenGL 3.3 / Vulkan 双后端

这一篇是 mini-cocos 的**主索引帖**。每个子系统的深读拆成了独立文章（见文末"系列文章"），这里只保留串起整套项目的骨架与几条最贯穿的工程经验。

## 目录

- [0. 为什么要复刻一个"老古董"](#sec-0)
- [1. 起手：接缝必须在第一天划好 (aee61f3)](#sec-1)
- [2. 系列文章](#sec-2)
- [3. 一些"小"提交里的工程审美](#sec-3)
- [4. 复盘：3 周 1500 行，到底学到了什么](#sec-4)

---

<a id="sec-0"></a>
## 0. 为什么要复刻一个"老古董"

我在游戏行业做 Gameplay / 引擎相关的工作十年，cocos2d-x 是绕不开的一段历史。引擎本身已经"过时"，但它的几套抽象 —— `Ref` + `AutoreleasePool`、`EventDispatcher` 的双优先级链、`Action / ActionInterval` 时间轴、`Scheduler` 的统一回调表 —— 至今仍然是 2D 引擎里非常体面的工程范式。Unity 的 `Coroutine`、UE 的 `Timeline`、Unreal Slate 的事件冒泡，很多设计你能在 cocos2d-x 里找到同源。

但我一直没有亲手把这些东西"长出来"过。读引擎源码和写引擎源码完全是两种理解。所以我把 cocos2d-x 当作设计参考、把 OpenGL/Vulkan 当作渲染后端，在 3 周里写了一个**只保留骨架、可以加载场景、跑动作、绑 Lua、点按钮**的最小化引擎。这套博客系列不是"如何写引擎"的教程，而是把每一步**为什么这么写、为什么不那么写**的取舍写下来，作为对自己工作方式的一次外化。

---

<a id="sec-1"></a>
## 1. 起手：接缝必须在第一天划好 (`aee61f3`)

首版只做了三件事：GLFW 开窗、加载 OpenGL 3.3 Core、画一个全屏的正交投影下的四边形。没有场景图、没有事件、没有内存管理。

这一版唯一值得说的设计是**两个工厂入口**：

```cpp
View*         createDefaultView();
RenderDevice* createDefaultRenderDevice();
```

从第一行代码就分离 View（窗口/输入抽象）和 RenderDevice（渲染抽象），是为了**逼自己后面写 Vulkan 的时候没有借口去改 main.cpp**。事实证明这个决定救了我一次：后来切 Vulkan 时，引擎入口完全没动，只有平台层加了一个 `createVulkanRenderDevice()` 的工厂。

> 经验：抽象不一定要一上来就完整，但**接缝**必须在第一天就划好。后期"补一个抽象层"几乎一定要重写两遍。

这条经验贯穿了整个系列：内存模型的多套并存、EventDispatcher 的双优先级链、RHI 的 handle-based 接口、Action 的归一化时间 t —— **它们都是一开始就划在那里的接缝**，后续每加一个功能都从中间穿过，没动过。

---

<a id="sec-2"></a>
## 2. 系列文章

把原本散在一篇里的 9 个子系统分别展开成独立文章。建议先读完这一篇骨架，再按兴趣点开任何一篇深读 —— 它们之间会互相引用，但每一篇都可独立读。

| # | 主题 | 一句话内容 |
|---|---|---|
| [#3](https://github.com/leafvmaple/blog/issues/3) | mini-cocos 的三套内存模型 | `Ref` + autorelease、手写 refcount、`shared_ptr` 各自在 mini-cocos 里的边界与决策矩阵 |
| [#4](https://github.com/leafvmaple/blog/issues/4) | 遍历中修改容器的统一 pattern | pending queue + 软删除 + 脏排序，从 Scheduler / EventDispatcher 抽出来到 ECS / RCU / GC |
| [#5](https://github.com/leafvmaple/blog/issues/5) | EventDispatcher 三次迭代 | 从全局回调表到双优先级链 + 嵌套 dispatch 计数器；命中测试 + modal swallow |
| [#6](https://github.com/leafvmaple/blog/issues/6) | 渲染队列 sortKey + RHI 抽象 | 64-bit sortKey 一次 sort 同时做透明分段 / state 合并 / z 排序；让 GL "假装"有命令缓冲来对齐 Vulkan |
| [#7](https://github.com/leafvmaple/blog/issues/7) | Action / ActionInterval | `update(t)` 这个契约让 Sequence / Spawn / Ease / Repeat 变成可代数化组合的时间运算 |
| [#8](https://github.com/leafvmaple/blog/issues/8) | 资源管线 | FontAtlas 增量光栅化解掉中文 Label 性能陷阱；FileUtils 搜索路径让多分辨率 / 多语言 / mod 成为 ops 配置 |
| [#9](https://github.com/leafvmaple/blog/issues/9) | 手写 Lua metatable | 跳过 sol2 换来的可控性：编译速度、错误信息、跨边界 lifecycle 的 `alive` 标志位 |

---

<a id="sec-3"></a>
## 3. 一些"小"提交里的工程审美

这几个 commit 在 commit 历史里看起来没什么 —— 但它们各自代表一种我希望自己长期保持的工程习惯。**新的小型重构默认追加到这一节**（详见 [posts/README.md 的迭代约定](https://github.com/leafvmaple/blog/blob/main/posts/README.md)）。

### 3.1 `c724ecb` —— 删掉冗余构造函数

C++17 之后，下面两段几乎等价：

```cpp
// 旧
class Foo {
public:
    Foo() : _x(0), _y(0) {}
private:
    int _x, _y;
};
// 新
class Foo {
private:
    int _x = 0;
    int _y = 0;
};
```

但收益不止少几行：**类内初始化**让"成员的默认值"和"成员的声明"放在同一行，新人读代码不用再跳到构造函数里对照一遍。

### 3.2 `bf4b46a` —— 用 `std::erase_if` 替掉 erase-remove

```cpp
// C++17
v.erase(std::remove_if(v.begin(), v.end(), pred), v.end());
// C++20
std::erase_if(v, pred);
```

EventDispatcher 和 Scheduler 里每帧都有这种"清理已取消的 entry"的操作。erase-remove 写多了就会写错（漏 `v.end()`、忘 erase），换成 `std::erase_if` 之后**一行表达完整意图**，没法写错。

### 3.3 `6c1d2b3` —— 把键盘和鼠标拆成两个文件

把 `EventListenerKeyboard.cpp` 和 `EventListenerMouse.cpp` 从一个文件里劈开，看起来是洁癖，但实际意义是 **链接期把不同平台依赖隔离开**。后面若要做 macOS 移植，鼠标这边可能要走 NSEvent；键盘走 IOKit；分了文件，平台差异就锁在该锁的地方。

---

<a id="sec-4"></a>
## 4. 复盘：3 周 1500 行，到底学到了什么

如果非要总结成几条对自己之后引擎/Gameplay 工作的提醒：

1. **接缝在第一天划，抽象在第二个实现里完工**。一上来就抽象会过度设计；不抽象会重写两遍。
2. **"在遍历中修改"的系统**统一走 pending queue + 软删除 + 脏排序。这是引擎里反复出现的模式（→ [#4](https://github.com/leafvmaple/blog/issues/4)）。
3. **生命周期不是单一答案**：autorelease 适合值对象、显式 ref-counting 适合 GPU/IO 资源、`shared_ptr` 在嵌入脚本语言的场合反而碍事（→ [#3](https://github.com/leafvmaple/blog/issues/3)）。
4. **位域 sortKey、双优先级链、归一化时间 t** 这些"小聪明"，每一个都换来了后面多一个功能的零重构（→ [#6](https://github.com/leafvmaple/blog/issues/6) / [#5](https://github.com/leafvmaple/blog/issues/5) / [#7](https://github.com/leafvmaple/blog/issues/7)）。
5. **API 设计的最高目标是让用户写不出错的代码**。Action 体系是最好的例子。
6. **没有第二个实现，抽象就是占位符**。OpenGL → Vulkan 这一刀，是整个项目最大的收获之一（→ [#6](https://github.com/leafvmaple/blog/issues/6)）。

复刻一个老引擎，从工程结果上看没有任何"产出"—— 不会有用户、也不会有 PR。但从工程能力上看，它逼你把一连串**别人替你做过的取舍**自己再做一遍，并且**自己承担每一个错误决定的后果**。这种经历是读多少源码都换不来的。

接下来准备给 mini-cocos 加的功能是：粒子系统、Spine 骨骼动画、以及一个真正能用 Lua 写完整 demo 的样例工程。等做完再写下一篇。

---

## 迭代记录

<!-- 本主帖的迭代约定见 posts/README.md。子系统级演进追加到对应子篇里；
     跨子系统的结构变更（新增 RHI 后端、改主循环）在这里追加一句索引。 -->

*暂无。*

---

*本文记录的是 [leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos) 的设计思考。如果你也在写自己的引擎，或者有更优雅的实现思路，欢迎到仓库的 Issue 区聊聊。*
