# 渲染队列 sortKey 与 OpenGL / Vulkan 的 RHI 抽象

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的衍生深读
> 涉及子系统：`Renderer` / `RenderQueue` / `RHI` / `OpenGL` / `Vulkan` 后端

这一篇把渲染部分两件互相独立又一定要一起讲的事情合在一起：**sortKey 编码**（怎么把"按什么顺序画"塞进一个 64-bit 整数里，让排序与命中合并都用同一个 key）和 **RHI 抽象**（怎么用同一份引擎代码顶住 OpenGL 与 Vulkan 两套截然不同的 API 模型）。前者是数据，后者是接口；它们共同决定了"主线程构造命令、渲染线程消费命令"这条流水线长什么样。

## 1. 为什么不能直接按 Z 序画

最朴素的"按 z 升序画"会被两件事打穿：

- **透明物体**必须从后向前画（alpha blend），不透明物体最好从前向后画（early-Z reject）。
- **state change**（切 shader、切 texture、切 blend mode）非常贵 —— GPU 驱动里可能引发 pipeline 重建、shader 重编译、texture descriptor 重绑。一帧切 200 次和切 20 次性能能差一个数量级。

所以渲染队列要在保持"语义正确性（透明排序）"的前提下**最大化合并 state**。直觉做法：
- 不透明物体：按 (shader, texture, vertex format) 分桶；
- 透明物体：按 z 严格降序。

这两条规则同时生效的最简单实现是**编码到一个 64-bit sortKey，整个队列一次 `std::sort`**。

## 2. sortKey 的 bit-layout

mini-cocos 现在用的布局（high → low）：

```
| 63           62 | 61 ... 56 | 55 ... 32 |  31 ... 16   |  15 ... 0  |
| translucent flag|   layer   |   depth   | material id  | mesh id    |
| 1 bit           | 6 bit     | 24 bit    | 16 bit       | 16 bit     |
```

- **bit 63（最高位）translucent flag**：0 = 不透明，1 = 半透明。这样 `std::sort` 升序排完后，整个队列就是"先不透明、后半透明"两段。
- **bit 62..56（6 bit）layer**：world / UI / debug / particle 等渲染层。layer 是手动指定的优先级 —— UI 总是在 world 之后。
- **bit 55..32（24 bit）depth**：对不透明段是 z 升序（前→后，early-Z 友好）；对半透明段需要 z 降序（后→前），实现上是把 depth 取反后再编码（`depth_inv = 0xFFFFFF - depth_quantized`），这样升序排出来仍然是"后→前"。
- **bit 31..16（16 bit）material id**：(shader, blend mode) hash。
- **bit 15..0（16 bit）mesh id**：(vertex layout, texture) hash。

这套 layout 直接抄自 BGFX 与 Sebastien Aaltonen 的若干次 GDC talk。它的好处是**一次 sort 同时做完三件事**：

1. 透明 / 不透明分段。
2. 不透明段内最大化 state 合并（material → mesh 局部排序自动让相同 shader+texture 连在一起）。
3. 透明段内严格 z 排序。

排完之后扫一遍，相邻两个 cmd 的 material id 相同就跳过 state change，只下 draw call。这就是 batch 合并的本体。

### 2.1 量化 depth

depth 是 float，要塞进 24-bit 整数。做法：

```cpp
uint32_t quantizeDepth(float z, float zNear, float zFar) {
    float normalized = (z - zNear) / (zFar - zNear);    // [0, 1]
    normalized = std::clamp(normalized, 0.0f, 1.0f);
    return static_cast<uint32_t>(normalized * 0xFFFFFF);
}
```

24 位精度对 2D / 半 3D 引擎完全够用（z 差 1 / 16M 已经在像素级以下）。3D 引擎一般用 logarithmic depth 或两段 quantize，避开 near plane 附近精度集中浪费的问题。

### 2.2 关于"是否应该用 radix sort"

64-bit 整数 + N 通常在 5k 以下时，`std::sort` 比 radix sort 还快（cache 友好 + 标准库优化）。N > 50k 时再考虑 radix。mini-cocos 没碰过这个规模，stdsort 够用。

## 3. RenderCommand：主线程产出的纯数据

队列里的 cmd 是 trivially copyable 的 POD：

```cpp
struct RenderCommand {
    uint64_t sortKey;
    RenderProgramHandle program;
    TextureHandle       texture;
    BlendMode           blend;
    VertexBufferHandle  vbo;
    IndexBufferHandle   ibo;
    uint32_t            indexOffset;
    uint32_t            indexCount;
    Mat4                modelMatrix;
    // ... uniform 默认槽位
};
```

主线程的 `visit()` 遍历场景图、把每个可绘制节点产出一个或多个 RenderCommand `push_back` 到 `_commands`。**主线程不直接调任何 GL/Vulkan API**。一帧结束时：

```cpp
void Renderer::flush() {
    std::sort(_commands.begin(), _commands.end(),
              [](auto& a, auto& b){ return a.sortKey < b.sortKey; });
    // 把 _commands swap 给渲染线程消费（双缓冲）
    _rhi->submit(std::move(_commands));
}
```

把数据和 API 调用分开，三个好处：

- 主线程不被 GL context 绑死，逻辑代码可以随便跑在哪个线程。
- 命令是 POD，可以加 frame recording / replay。
- 测试可以塞 mock RHI，断言"这一帧应该有 12 个 draw call，前 3 个 shader 一致"。

## 4. RHI：把 GL 与 Vulkan 收敛到同一接口

`RenderHardwareInterface` 是一个纯虚 + handle-based 的薄抽象：

```cpp
class RHI {
public:
    virtual TextureHandle createTexture(const TextureDesc&) = 0;
    virtual void          destroyTexture(TextureHandle) = 0;

    virtual ShaderProgramHandle createProgram(const ShaderSource&) = 0;

    virtual VertexBufferHandle createVB(const void* data, size_t bytes) = 0;
    virtual IndexBufferHandle  createIB(const void* data, size_t bytes) = 0;

    virtual void submit(std::vector<RenderCommand> commands) = 0;
    virtual void present() = 0;
};
```

关键设计选择：

### 4.1 handle 而不是指针

所有 GPU 资源对外暴露的都是 `uint32_t` typed handle，不是 `Texture*`。理由：

- 跨线程安全 —— 整数复制不需要同步。
- 后端可以把真正的资源对象藏在自己的 vector / object pool 里，外部代码完全不需要 include 后端类型。
- handle 可以编码 generation bit 检测"use after free"（mini-cocos 当前没做，但留了 reserve 位）。

### 4.2 GL 后端"假装"自己有命令缓冲

Vulkan 后端的 `submit` 自然就是录制 secondary command buffer。问题是 OpenGL 没有这个概念 —— GL 调用是立即的、绑当前 context。我的做法：

```cpp
class GLBackend : public RHI {
    void submit(std::vector<RenderCommand> cmds) override {
        _pendingCmds = std::move(cmds);      // 推迟到 present()
    }
    void present() override {
        for (auto& c : _pendingCmds) executeOne(c);
        _pendingCmds.clear();
        SwapBuffers();
    }
};
```

这样 GL 后端在外观上和 Vulkan 一样是"提交命令包"，只是它私下里在 present 的时候把命令逐条翻译成 `glUseProgram` / `glBindTexture` / `glDrawElements`。**对外接口没有任何"GL 特殊路径"**，引擎侧代码完全平移。

代价是：GL 后端损失了"提前 submit 让驱动并行准备"的可能性。但 GL 驱动本来也不太能并行，损失忽略。

### 4.3 Vulkan 后端：真正的同步代价

Vulkan 后端比 GL 后端多了几个东西：

- **per-frame command pool + framebuffer**（双缓冲，避免在 GPU 用之前 reset）。
- **descriptor set 缓存**：每个 (shader, texture set) 组合复用一个 set，避免每帧重建。
- **pending deletion 队列**：destroyTexture 不能立刻释放，要等 fence 信号确认 GPU 不再使用。
- **pipeline cache**：(shader, vertex format, blend, depth state) 组合做 hash，命中直接复用 VkPipeline；没命中才编译（运行时第一次卡顿来源）。

这些都是 GL 后端不需要的。把它们封在 Vulkan 后端内部，引擎侧不需要知道。**就算未来加 Metal / D3D12 后端，引擎侧零修改**。

### 4.4 SPV inline vs runtime compile

shader source 用 GLSL 写，编译到 SPIR-V 这一步有两个选择：
- **runtime**：app 里塞 glslang，加载时编译。优点是热重载方便，缺点是 glslang 把可执行体积撑到 +10MB，启动时还要解析。
- **build time**：CMake 调 glslangValidator 把 .vert/.frag 编到 .spv，做成 resource 嵌入二进制。运行时直接 `vkCreateShaderModule(spv_bytes)`。

mini-cocos 选了**双轨**：debug build 走 runtime（热重载），release build 走 build time（小、快）。同一份 ShaderSource API 在内部分支：

```cpp
ShaderProgramHandle VulkanBackend::createProgram(const ShaderSource& src) {
    if (src.spv.empty()) {
        // debug: runtime compile
        auto spv = glslangCompile(src.glsl);
        return makeProgram(spv);
    } else {
        return makeProgram(src.spv);
    }
}
```

引擎侧调用方完全没感知。

## 5. 一帧的完整流水线

把上面三块拼起来：

```
帧开始
  ↓
visit 场景图（主线程）
  - 每个可绘制节点 → 算 sortKey → push_back 到 commands
  ↓
sort(commands)（主线程）
  ↓
rhi->submit(commands)（主线程把数据扔过去）
  ↓
后端遍历 commands（GL：present 时；Vulkan：录制 command buffer）
  - 相邻 cmd 比较 material id：相同则跳过 state change
  - 调 RHI 内部的实际 draw 函数
  ↓
present
  ↓
fence 信号回来 → 处理 pending deletion
```

测出来的关键收益：场景里 200 个 sprite，**unsorted 时 ~150 次 state change，sorted+batched 后降到 ~12 次**。draw call 数虽然没变（一个 sprite 一个 draw call），但 state change 是真正的性能瓶颈。

## 6. 为什么不上 instancing

一个常见的"显然应该做的事"是：相同 mesh + texture 的多个 sprite 应该走 `glDrawElementsInstanced`，一次 call 画 N 个。mini-cocos 没做。三个理由：

- 2D 场景里每个 sprite 通常 transform / color / UV offset 都不一样，instancing 要塞一个 per-instance buffer，复杂度高。
- 真正的高频场景（粒子）应该走 dedicated particle pipeline，不应该混在通用 sprite 里。
- 当前 batch 合并 + 几百个 sprite 已经够流畅，profile 没显示这是瓶颈。

属于"以后真需要再做"的预留接口位（RenderCommand 里多塞一个 `instanceCount` 默认 1，不影响现有路径）。

## 7. 经验

> **RHI 这一层抽象的成败，看一件事：加新后端时引擎侧改不改代码。**
>
> mini-cocos 从 GL 加 Vulkan 时，`src/` 下除 RHI 实现外**没有一行改动**。这是这套抽象唯一的验收标准。
>
> sortKey 部分的成败看另一件事：**新增一种渲染特性时，是否需要修改排序逻辑**。layer 字段就是为此预留的 —— 加一个 layer 不需要改 sort 比较函数。

具体经验：
- handle 设计的"额外一层间接"完全值得 —— 跨线程、调试、mock 全部受益。
- 不要在引擎层泄露任何 GL / Vulkan 类型。`#include <vulkan/vulkan.h>` 只允许出现在 RHI 的实现文件里。
- sortKey 编码确定后**不要再改 bit-layout**，因为它经常被 hash / cache key 用，改了相当于让全引擎缓存失效。一开始就把字段留宽（这里 6 bit layer 用不完，但留着舒服）。

## 8. 迭代记录

<!-- 后续渲染层 / RHI 的演进追加在这里。Metal 后端、indirect draw、render graph 等。 -->

- 2026-05-22：补丁 [`660ea45`](https://github.com/leafvmaple/mini-cocos/commit/660ea45) —— `Renderer::flush` 里的 `transformVerts` 在合并跨 Label 批次时漏掉了 `Color4B`，结果"批合并后 alpha 全部回 255"、Label 透明度被吃掉。这是 sortKey + 批合并设计天生暴露的角：**任何 per-vertex 属性都必须在 transform 那一段同步**，漏一项就是一个隐蔽的视觉 bug。
- 2026-05-22：[`155f650`](https://github.com/leafvmaple/mini-cocos/commit/155f650) 给 Label 加上**跨 atlas page 的 quad 批合并**：从前每个 Label 自己 emit 1 个 RenderCommand，多 page 时一段文本会被切成 N 条 cmd；现在 Label 内部按 page 分桶，每个 page 一条 cmd，跨 Label 在 Renderer 这一层再合并相邻同 page 同 material 的 cmd。配套引入了独立的 sprite shader（`shaders/vulkan/sprite.{vert,frag}`）+ `tools/compile_shaders.ps1`，OpenGL 和 Vulkan 后端各加了一条 sprite pipeline 路径。这一改让"几千字 Label 不退化为几千 draw call"成为可能。

---

*本文是 [mini-cocos 设计复盘](https://github.com/leafvmaple/blog/issues/2) 系列的衍生深读。*
