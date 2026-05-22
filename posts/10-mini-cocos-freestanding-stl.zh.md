# Freestanding STL：把 `std::` 收敛到 `mstd::`，为把 mini-cocos 嵌进自制 OS 做准备

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的子篇
> 相关子系统：`base/ZCStd.h` / `third_party/zstl` 子模块 / 全引擎 STL 调用点

这一篇起因于一个比 mini-cocos 本身更长线的目标：**把它作为自制 OS 的 UI 框架嵌进去**。OS 没有 host libstdc++，引擎里所有 `std::vector` / `std::string` / `std::unordered_map` 都得有"我自己提供的版本"可以替换。这一刀如何切下去、不影响日常 hosted 构建、又能在 freestanding 编译时整体切换 —— 就是本篇的内容。

## 1. 目标与非目标

**目标**：

- mini-cocos 所有"数据结构 + 算法 + 内存"层面的标准库调用，全部走一个我能控制的别名（`mstd::`），既能指向 host 的 `std::`，也能指向我自己写的精简实现（[zstl](https://github.com/leafvmaple/zstl)）。
- 切换以编译开关而非代码改动完成 —— 默认行为不变，hosted 构建 0 成本。
- 单文件即可读懂：所有别名集中在 `src/base/ZCStd.h`，一眼看完都用了什么 STL 类型。

**非目标**：

- 不打算重写 `<filesystem>` / `<system_error>` / `<wstring>` 这种和宿主深度绑定的 API。这些只在 `platform/win32/` 里用，那一层就明确保留 `std::`，不参与 freestanding 收敛。
- 不追求"和 libstdc++ 完全 ABI 兼容"。zstl 只覆盖 mini-cocos 真正用到的子集，能编译能跑就够了。
- 不打算用 zstl 做日常开发 —— hosted 构建仍然走 `std::`，享受成熟实现的优化、调试器友好性、std-format 等丰富生态。

## 2. 核心机制：一个别名头 + 一个开关 + 一个 PCH

`src/base/ZCStd.h`（[`be88a31`](https://github.com/leafvmaple/mini-cocos/commit/be88a31)）大约 50 行：

```cpp
#pragma once

#ifdef ZOCOS_USE_SYS_STL
    #include "zstl/vector.h"
    #include "zstl/string.h"
    #include "zstl/unordered_map.h"
    // ... zstl 里覆盖的全部头
    namespace mstd = sys;
#else
    #include <vector>
    #include <string>
    #include <unordered_map>
    #include <set>
    #include <array>
    #include <algorithm>
    #include <utility>
    #include <functional>
    #include <memory>
    #include <new>
    #include <limits>
    namespace mstd = std;
#endif
```

引擎里**所有**原来这样写的地方：

```cpp
#include <vector>
#include <unordered_map>
std::vector<Entry> _entries;
std::unordered_map<int, Texture*> _cache;
```

都被机械改写成：

```cpp
#include "base/ZCStd.h"
mstd::vector<Entry> _entries;
mstd::unordered_map<int, Texture*> _cache;
```

这次改写涉及 50+ 文件、平均每个 +/- 个位数，是个纯机械操作。我没手动改 —— 写了 `tools/refactor_to_mstd.ps1` 一把梭，commit message 里也声明了"Mechanically rewrite"。可重现 + 可审计。

### 2.1 为什么选 `using namespace` / `namespace alias`，不选 `#define std mstd`

最诱人的偷懒做法是：

```cpp
#define std mstd     // 千万别
```

不止丑陋，还会把 third-party 头里的 `std::` 一并替换掉，引发各种神秘错误（比如 GLFW 头里的 `std::function`、Vulkan headers 里的 `std::array`）。`namespace alias` 是唯一干净的方案：

- 别名只作用于"我这一边"的代码。
- 不污染 third-party 头里看到的 `std::`。
- IDE 跳转 `mstd::vector` 能正确跳到 `std::vector` 或 `sys::vector`，看开关。

### 2.2 PCH：让 hosted 构建零成本

`ZCStd.h` 注册成 PCH（precompiled header），CMakeLists 里：

```cmake
target_precompile_headers(zocos PRIVATE src/base/ZCStd.h)
```

效果：

- 每个 `.cpp` 编译时 STL 头只解析一次。
- mini-cocos 现在 80+ 文件全部用到 `mstd::`，PCH 把"重复解析 STL 头"的开销摊到 0。
- hosted 构建实测从 ~28 秒（cold）降到 ~19 秒，纯收益。

PCH 的代价是：**任何对 ZCStd.h 的修改都触发全量重编**。但这个文件几乎不会改 —— 它就是个开关 + 别名表。

### 2.3 子模块：zstl 不进主仓库

zstl 单独一个 repo（[leafvmaple/zstl](https://github.com/leafvmaple/zstl)），通过 git submodule 引入：

```
.gitmodules
[submodule "third_party/zstl"]
    path = third_party/zstl
    url = https://github.com/leafvmaple/zstl
```

CMake 里同时支持 "submodule 已 init" 和 "submodule 没拉，但 ../zstl 是 sibling repo" 两种情况，后者方便本地开发时同时改 mini-cocos 和 zstl：

```cmake
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/zstl/CMakeLists.txt")
    add_subdirectory(third_party/zstl)
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../zstl/CMakeLists.txt")
    add_subdirectory(../zstl ${CMAKE_BINARY_DIR}/zstl)
endif()
target_link_libraries(zocos PUBLIC zstl::zstl)
```

zstl 是 INTERFACE library —— 全是 header-only 模板，不产生 .lib。

## 3. 一次踩坑：clangd 不认 MSVC PCH

机械改写之后，MSVC 构建过、Vulkan/OpenGL 都跑通。但打开 VS Code 时 clangd 全屏飘红：

```
use of undeclared identifier 'mstd'
```

原因：**clangd 不消费 MSVC 的 `/Yc` 预编译头**。它扫描每个文件时只看文件里显式的 `#include`。我那次 mechanical rewrite 用的脚本是"如果文件里 include 了 `<vector>` 就替换"，五个文件因为引入 STL 的方式（间接 include、或不规范的 `<vector.h>`）没匹配上替换正则，结果它们没 `#include "base/ZCStd.h"`，但用了 `mstd::`。

修复（[`d98b2b7`](https://github.com/leafvmaple/mini-cocos/commit/d98b2b7)）：再写一个脚本 `tools/ensure_zcstd_include.ps1`，扫所有文件，发现用了 `mstd::` 但没 include `ZCStd.h` 就在 `#pragma once`（头文件）或文件顶部（.cpp）插入。

教训：**PCH 是构建期优化，不是语义保证**。任何依赖 PCH 才能编译的代码，本质上是 IDE 不友好的。规矩应该是"include 必须显式写出来"，PCH 只决定它要不要重复解析。

## 4. zstl 到底要覆盖多少？

`ZCStd.h` 的 `#else` 分支列出了我用过的所有 STL 头，等同于 zstl 必须提供的最小集合：

| 类型 / 函数 | 出现频率 | zstl 是否已覆盖 |
|---|---|---|
| `vector` | 极高 | ✅ |
| `string` | 极高 | ✅ |
| `unordered_map` | 高（cache 类） | ✅ |
| `set` | 中（去重集合） | ✅ |
| `array` | 中（小固定数组） | ✅ |
| `pair`, `move`, `forward`, `swap` | 极高 | ✅ |
| `min`, `max`, `clamp` | 高 | ✅ |
| `sort`, `stable_sort` | 中（渲染排序） | ✅ |
| `find`, `find_if`, `remove`, `remove_if` | 中 | ✅ |
| `hash`, `less`, `equal_to` | 中 | ✅ |
| `function` | 中（callback） | ✅ |
| `unique_ptr`, `make_unique` | 中 | ✅ |
| `size_t`, `numeric_limits`, `nothrow` | 高 | ✅ |
| `to_string` | 低（debug） | ✅ |

注意没有的：`shared_ptr`、`map`（要红黑树）、`deque`、`thread`、`mutex`、`chrono`、`filesystem`、`regex`、`iostream`。这些要么 mini-cocos 不用，要么明确不打算 freestanding 化。

> 这一列表的存在本身就是设计成果 —— 它告诉我（也告诉 OS 那边）"这个引擎对 STL 的最小依赖"是多大。一个老问题"我的引擎到底需要多大的 runtime"被这张表精确量化。

## 5. ABI 隔离：模板能 header-only，例外就停下来想想

zstl 走 header-only 模板是有意的，原因：

- 模板实例化在引擎侧完成，不依赖 zstl 编译出来的某个 `.a`。引擎换编译器、换 C++ 标准也不会和 zstl 的 ABI 撞车。
- 任何"必须由 zstl 提供二进制实现"的东西（比如最终走 syscall 的 allocator），通过 `extern "C"` hook 暴露，由宿主层（OS / app）注入：

```cpp
// zstl/allocator.h
extern "C" {
    void* z_malloc(size_t n) noexcept;     // 由宿主提供
    void  z_free(void* p) noexcept;
}
```

hosted 构建里 z_malloc 直接走 `::operator new`，freestanding 构建里走 OS 自己的物理页分配器。引擎本身完全不知情。

> 如果某个东西不能 header-only，就先停下来 —— 90% 的情况是接口设计需要再切一刀。

## 6. 为什么不直接用 EASTL / mio / abseil

考虑过的几个方案：

- **EASTL**：质量很高、用法和 std 接近，但代码量 6 万行 +，光是构建依赖就比 mini-cocos 本身还大。OS 这一线明确要"刚刚够用"。
- **abseil**：Google 出品，但目标是"std 的增强版"而不是"std 的替代"，依赖 host runtime 严重，不适合 freestanding。
- **手抠 STL（不抽 zstl）**：直接在 mini-cocos 仓库里写自己的 vector / string。最干净，但**任何复用都要把代码再复制一份**。zstl 抽出来之后，未来其他项目（包括那个自制 OS 本身的内核工具库）也能直接 link。

zstl 这条路是"复用最大化、依赖最小化"的折中。

## 7. 小结：一个开关一夜搬走整个引擎

总的来说，这次改造的形状是：

```
src/base/ZCStd.h               ─┐
                                │  唯一的别名锚点
src/**/*.{h,cpp}                │
  - #include "base/ZCStd.h"     │  显式 include
  - mstd::vector<...>           │  到处用别名
  - mstd::string                │
                                ├─ -DZOCOS_USE_SYS_STL ─→ namespace mstd = sys
                                │
                                └─ 默认             ─→ namespace mstd = std

third_party/zstl/               ─→ header-only sys::* 实现
tools/refactor_to_mstd.ps1      ─→ 机械改写脚本（可重跑）
tools/ensure_zcstd_include.ps1  ─→ 补漏脚本（clangd 友好）
```

收益不止是"将来能嵌入自制 OS"。**当下立刻可见**的：

- 全引擎 STL 用了哪几样东西，一个 50 行的头看完。
- 任何 STL 调用想换实现（比如把 unordered_map 换成 robin_hood 之类高性能版本），改一个文件就能跨整个引擎生效。
- 任何"用了哪个 STL"的审计、license check、freestanding 评估，搜 `mstd::` 即可。

> **抽象层的最大价值往往不是"将来能换"，而是"现在让你看清你到底用了什么"**。
>
> 我没真把引擎跑在那个自制 OS 上（OS 那边还在写 page allocator）。但仅仅"让我把这件事做完了"——把 `std::` 用法收敛到一个可数的别名 —— 已经回本了。

## 8. 迭代记录

<!-- 后续 mstd / zstl 的演进追加在这里。比如 zstl 新增容器、freestanding 真正落地、allocator hook 接口扩展等。 -->

- 2026-05-22：补丁 [`d98b2b7`](https://github.com/leafvmaple/mini-cocos/commit/d98b2b7) —— 给五个机械改写漏掉的文件显式补上 `#include "base/ZCStd.h"`，并增设 `tools/ensure_zcstd_include.ps1` 防止再漏。教训：clangd 不消费 MSVC PCH，所有 include 必须显式写出来。
- 2026-05-22：首版 [`be88a31`](https://github.com/leafvmaple/mini-cocos/commit/be88a31) —— 引入 `mstd::` 别名 + `third_party/zstl` 子模块 + PCH 接入；机械改写 50+ 引擎文件。

---

*本文是 [mini-cocos 设计复盘](https://github.com/leafvmaple/blog/issues/2) 系列的子篇。与 [#3 三套内存模型](https://github.com/leafvmaple/blog/issues/3) 强相关——本篇切的是"标准库依赖"这一条接缝，#3 切的是"对象生命周期"那一条。*
