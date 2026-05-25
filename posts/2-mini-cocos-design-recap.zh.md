<!--pub:2026-03-28-->
# mini-cocos：cocos2d-x 的从零重写与设计复盘

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 提交跨度：2026-03-25 → 2026-05-22，41 次提交
> 体量：~11,000 行 C++17，CMake + GLFW + Lua 5.4，OpenGL 3.3 / Vulkan 双后端

这一篇是 mini-cocos 的**主索引帖**。每个子系统的深读拆成了独立文章（见 §2 系列文章），这里只串骨架。

正文之前，先列一下项目的指标。数据截止 2026-05-22：

| 指标 | 数值 | 含义 |
|---|---|---|
| 提交数 | **41** | 跨度 2026-03-25 → 2026-05-22 |
| `src/` C++ 行数 | **11,237** | 全引擎主体，不含 `third_party/` |
| OpenGL 3.3 后端 LOC | **900** | `src/platform/opengl/` |
| Vulkan 后端 LOC | **2,311** | `src/platform/vulkan/`，是 GL 后端的 2.6×（显式资源管理 + descriptor set + pipeline state object + command buffer 录制） |
| `RenderDevice` 接口纯虚函数数 | **6** | `src/base/ZCRenderDevice.h`：`beginFrame` / `submit` / `endFrame` / `createTexture` / `destroyTexture` / `updateTextureRegion` |
| `mstd::` 引用数 / 残留 `std::` | **468 / 48** | 90% 已收敛到 [zstl](https://github.com/leafvmaple/zstl) 子模块；剩余 48 处集中在 string 工具、`std::function` 槽位、IO 边界 |

两条要单独说一句：

- **6 个纯虚函数撑起两个差 2.6× 体量的后端**。`RenderDevice` 没有暴露任何 GL / Vulkan 概念（没有 program handle 类型、没有 command buffer 概念），让 GL 后端假装拥有命令队列、让 Vulkan 后端在内部把多次 `submit` 合并成一次 `vkQueueSubmit`。这种"接口故意比两个后端都窄"的设计在 [#6](https://github.com/leafvmaple/blog/issues/6) 详述。
- **第二个后端是 RHI 抽象的唯一裁判**。只有 GL 后端的时候，"通用"是一种自我感觉；直到 Vulkan 真的跑起来，才知道哪些 API 是真接缝、哪些是伪装成接缝的 GL 假设。这条经验和 zonix-plus 系列里"三套 ISA 跑同一份 `kernel/`"是同源（[#11](https://github.com/leafvmaple/blog/issues/11)）。

## 目录

- [0. 项目范围](#sec-0)
- [1. 起手：接缝必须在第一天划好 (`aee61f3`)](#sec-1)
- [2. 系列文章](#sec-2)
- [3. 一些"小"提交里的工程审美](#sec-3)
- [4. Vulkan 落地之后还成立的几条事实](#sec-4)

---

<a id="sec-0"></a>
## 0. 项目范围

mini-cocos 把 cocos2d-x 当作设计参考、OpenGL / Vulkan 当作渲染后端，写一个**只保留骨架、可以加载场景、跑动作、绑 Lua、点按钮**的最小化引擎。cocos2d-x 引擎本身已经"过时"，但它的几套抽象 —— `Ref` + `AutoreleasePool`、`EventDispatcher` 的双优先级链、`Action / ActionInterval` 时间轴、`Scheduler` 的统一回调表 —— 至今仍然是 2D 引擎里非常体面的工程范式。Unity 的 `Coroutine`、UE 的 `Timeline`、Unreal Slate 的事件冒泡，很多设计能在 cocos2d-x 里找到同源。

这套博客系列不是"如何写引擎"的教程，而是把每一步**为什么这么写、为什么不那么写**的取舍写下来。

---

<a id="sec-1"></a>
## 1. 起手：接缝必须在第一天划好 (`aee61f3`)

首版只做了三件事：GLFW 开窗、加载 OpenGL 3.3 Core、画一个全屏的正交投影下的四边形。没有场景图、没有事件、没有内存管理。

这一版唯一值得说的设计是**两个工厂入口**：

```cpp
View*         createDefaultView();
RenderDevice* createDefaultRenderDevice();
```

从第一行代码就分离 View（窗口/输入抽象）和 RenderDevice（渲染抽象），是为了**让后来写 Vulkan 的时候没有借口去改 `main.cpp`**。这个决定的回报在 Vulkan 后端落地时兑现：引擎入口完全没动，平台层只加了一个 `createVulkanRenderDevice()` 工厂。

这条接缝贯穿了整个系列：内存模型的多套并存、EventDispatcher 的双优先级链、RHI 的 handle-based 接口、Action 的归一化时间 `t` —— **它们都是一开始就划在那里的接缝**，后续每加一个功能都从中间穿过，没动过。

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
| [#10](https://github.com/leafvmaple/blog/issues/10) | Freestanding STL via mstd / zstl | 把全引擎的 `std::` 调用收敛到 `mstd::` 别名，背靠 [zstl](https://github.com/leafvmaple/zstl) 子模块，为"把 mini-cocos 嵌进自制 OS"打地基 |

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
## 4. Vulkan 落地之后还成立的几条事实

下面这几条放在这里，是因为它们**在只有 GL 单后端的初版时只是直觉，到 Vulkan 双后端的现在依然没被反例打掉**。

1. **OpenGL 后端 900 行 vs Vulkan 后端 2,311 行，背后是 6 个相同的纯虚函数**。`RenderDevice` 没有暴露任何后端概念（program handle、command buffer、descriptor set），让 GL 后端假装拥有命令队列、让 Vulkan 后端在内部把多次 `submit` 合并成一次 `vkQueueSubmit`。这种"接口故意比两个后端都窄"在 GL 时代看是过度抽象，到 Vulkan 落地时才回报（详见 [#6](https://github.com/leafvmaple/blog/issues/6)）。

2. **第二个后端是 RHI 抽象的唯一裁判**。只有 GL 时，"通用"是一种自我感觉；Vulkan 真的跑起来才知道哪些 API 是真接缝。这条经验和 zonix-plus 系列里"三套 ISA 跑同一份 `kernel/`"是同源（[#11](https://github.com/leafvmaple/blog/issues/11)）。

3. **`mstd::` 引用 468 处、残留 `std::` 48 处**。90% 已收敛到 [zstl](https://github.com/leafvmaple/zstl) 子模块；剩余 48 处集中在 string 工具、`std::function` 槽位、IO 边界。把整个引擎 freestanding 化的瓶颈现在就是这 48 处（详见 [#10](https://github.com/leafvmaple/blog/issues/10)）。

4. **Action 系统 1,082 行支持 `Sequence` / `Spawn` / `Ease` / `Repeat` 任意嵌套**。所有组合性的根本前提是 `update(t∈[0,1])` 这一个契约 —— `Ease(action, easeFn)` 等价于 `update(easeFn(t))`，一个高阶函数（详见 [#7](https://github.com/leafvmaple/blog/issues/7)）。

5. **Lua 绑定 1,529 行手写 metatable**。和 sol2"三行能搞定"是反方向；这 1,529 行换回的是编译速度、错误信息可读、以及 Lua/C++ 边界 `_alive` 标志位带来的"对象在 Lua 这边持有时可能已被 C++ delete 掉"的安全（详见 [#9](https://github.com/leafvmaple/blog/issues/9)）。

6. **渲染主路径上一次 `std::sort` 同时做三件事**：透明分段、state 合并、z 排序。靠的是 64-bit sortKey 的 bit 编码，不需要分别的 render pass / pipeline 缓存（详见 [#6](https://github.com/leafvmaple/blog/issues/6)）。

下一步：粒子系统、Spine 骨骼动画、以及一个真正能用 Lua 写完整 demo 的样例工程。

---

## 迭代记录

<!-- 本主帖的迭代约定见 posts/README.md。子系统级演进追加到对应子篇里；
     跨子系统的结构变更（新增 RHI 后端、改主循环）在这里追加一句索引。 -->

- 2026-05-22：新增子篇 [#10 Freestanding STL via mstd/zstl](https://github.com/leafvmaple/blog/issues/10)。这不是某个子系统内部的演进，而是跨子系统的一条新接缝——把 `std::` 调用收敛到 `mstd::` 别名（背靠新引入的 [zstl](https://github.com/leafvmaple/zstl) 子模块），为未来把 mini-cocos 嵌进自制 OS 作为 UI 框架做准备。现阶段 hosted 构建与之前完全等价。
- 2026-05-22：一批渲染层 + Label 重构（[`155f650`](https://github.com/leafvmaple/mini-cocos/commit/155f650) / [`6e06290`](https://github.com/leafvmaple/mini-cocos/commit/6e06290) / [`67633ba`](https://github.com/leafvmaple/mini-cocos/commit/67633ba) 等）—— Label 结构靠齐 cocos2d-x、`FontAtlasCache` 抽出、Renderer 跨 Label 批合并、ActionInterval / EventDispatcher 顺手去重。详见各子篇（[#6](https://github.com/leafvmaple/blog/issues/6) / [#7](https://github.com/leafvmaple/blog/issues/7) / [#8](https://github.com/leafvmaple/blog/issues/8) / [#5](https://github.com/leafvmaple/blog/issues/5)）迭代记录节。

---

*仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。*
