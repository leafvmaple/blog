<!--pub:2026-03-18-->
# zcc 编出的 ELF 直接跑在 Zonix 上：自研工具链与 OS 的闭环

> 仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)
> 提交跨度：2024-07-03 → 2026-05-22，116 次提交，跨两个集中开发期（2025-08 主体实现 / 2026-03–05 与 Zonix 闭环）
> 体量：~3,142 行 C++17 + 汇编 + 链接脚本，**LLVM IR 单后端**，**x86_64 / riscv64 两套 freestanding runtime**
> 能力：C 子集前端（int / char / 一维 + 多维数组 / 函数 / for-while-break-continue / 短路 `&&`/`||`）、LLVM IR codegen、`-llvm` / `-x64` / `-riscv64` 三种输出、自带 `crt0 + libzccrt.a + linker.ld`、与 Zonix OS 共享一份 `syscall.h`

这一篇是 zcc 的**主索引帖**。它不是一个独立的玩具编译器——它存在的全部理由是和 [Zonix OS #11](https://github.com/leafvmaple/blog/issues/11) 形成一条**自举链的雏形**：自己写的编译器把 C 源码编成 ELF、用自己写的 runtime 把它包成 freestanding 可执行、由自己写的内核 `exec()` 加载、通过自己定义的 syscall 号回到内核（详见 [#18 用户态 ELF 执行](https://github.com/leafvmaple/blog/issues/18)）。

整套链路里**最关键的接缝**是一份很无聊的头文件——zcc 的 `src/runtime/syscall.h` 和 Zonix 的 `include/abi/syscall.h` 保留两份**物理拷贝**，但定义同一份"逻辑契约"（6 个系统调用号 + fd 常量），由一个 CI 脚本守住两边永远字节同步。两份文件的存在不是疏忽——zcc 必须作为独立仓库可编译，不能反向依赖 Zonix 子模块的路径——而 Zonix 内核、用户程序 `.S` 桩、zcc runtime 三方需要的就是"4 号是 write"这条结论本身。**两份物理文件、一份逻辑契约、自动化验证**，是 [#21](https://github.com/leafvmaple/blog/issues/21) 整篇要拆的事。

正文之前先列项目指标。数据截止 2026-05-22：

| 指标 | 数值 | 含义 |
|---|---|---|
| 提交数 | **116** | 跨度 2024-07-03 → 2026-05-22，主要集中在 2025-08 与 2026-03–05 |
| 总代码行数 | **~3,142** | `.cpp/.h/.c/.l/.y/.S/.ld` 全部计入 |
| 前端 (`parser/`) | **710** | flex 132 + bison 578（LALR(1) C++ skeleton + variant tokens） |
| AST + codegen (`src/ast/` + `src/ir/`) | **1,529** | 不依赖 LLVM 的 AST 节点 + 调 LLVM IRBuilder 的 codegen 薄壳 |
| 主驱动 (`src/main.cpp`) | **181** | 命令行 + 调用 `llc` + `clang -c` + `ld` 串完整后端流水线 |
| Freestanding runtime (`src/runtime/`) | **450** | `printf` + `crt0.S` + `syscall.S` + `linker.ld`，**x64 / riscv64 各一份** |
| 与 Zonix 共享的头文件 | **1** | `syscall.h`，编译器和内核都 include 这同一个物理文件 |
| 回归测试用例 | **15** | `test/cases/*.c`，host clang 当 oracle，diff stdout |

两条要单独说一句：

- 三千行不是为了"短"。它是**有意停在能跑通自家 OS 上 `printf("Hello\n")` 这条路径的最小集合**，下面 §3 会展开为什么不再往前推。这种克制是这个项目区别于"再写一个 C 编译器"的关键。
- 那个 "1" —— 一份 `syscall.h` 同时服务编译器、内核、汇编桩——是**三方契约的物理来源**。任何一方对"哪个号是 write"的记忆漂移，编译期就会被发现，而不是运行时 wrong syscall 静默走错分支。这条道理和 Zonix [#14](https://github.com/leafvmaple/blog/issues/14) 里 `BootInfo` 作为 bootloader / 内核共享契约同源——**接口契约要有唯一的物理来源**。

下面三条决策解释这套 3,100 行能完成闭环的原因。

## 目录

- [0. 设计约束](#sec-0)
- [1. 第一个决定：IR 后端是可替换的薄壳 (`ba52eea`)](#sec-1)
- [2. 第二个决定：ABI 和 runtime 是编译器的组成部分 (`962ce2b` / `06b07a5`)](#sec-2)
- [3. 第三个决定：前端有意停在"小 C" (`3871ee4`)](#sec-3)
- [4. 系列文章](#sec-4)
- [5. 闭环之后还成立的几条事实](#sec-5)

---

<a id="sec-0"></a>
## 0. 设计约束

zcc 的目标不是"再写一个 C 编译器"。是**给 [Zonix OS](https://github.com/leafvmaple/zonix-plus) 配一个能编出可加载 ELF 的工具链**。这条约束反过来劈掉了很多本来想做的事：

- **不实现完整 C**——`typedef` / `struct` / `float` / `union` / `switch` / `goto` / preprocessor 全都没有。原因是 Zonix 的 `exec` 加载的第一个用户程序是 `hello.c`：`printf("Hello\n"); return 0;`。能编这个就够了，多出来的复杂度对"闭环"目标零贡献。
- **不写自己的 backend**——指令选择、寄存器分配、调度全交给 LLVM (`llc`)。zcc 只产出 `.ll`，下游靠 `llc + clang -c + ld` 拼完。3,100 行能跑通的前提就是把后端委派出去。
- **不依赖宿主 libc**——`crt0` 直接调 `int $0x80` / `ecall`，`printf` 用 syscall 直写 stdout（fd=1）。Zonix 启动时根本没有 glibc 可链。

第三条是接缝的关键。一个"教学 C 编译器"如果默认 link 宿主 libc，它编出来的程序在自家 OS 上一行 `printf` 都跑不起来——因为 `printf` 在宿主 libc 里最终调的是 Linux ABI 的 `syscall` 指令、号码、约定，全是宿主的，**和你自己 OS 的 trap 分发器对不上**。要闭环就必须自带一套和目标 OS 协商好的 runtime。

这一条把"编译器项目"和"OS 项目"的接缝精确地划在了一份 `syscall.h` 上。下面三条决策解释这份头文件**怎么成为单一真相源的、为什么这一笔比 1,500 行 codegen 都重要**。

---

<a id="sec-1"></a>
## 1. 第一个决定：IR 后端是可替换的薄壳 (`ba52eea`)

zcc 的第一版（2024-07，[`361081b`](https://github.com/leafvmaple/zcc/commit/361081b)）目标是 PKU 编译实验课的 SysY → Koopa IR。`1cae145` 加了 Koopa 后端、`3b0780b` 加了第二个 LLVM 后端，一度同时维护两套 IR：AST 节点的 `Codegen()` 通过模板/适配层选 backend。

[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea)（2026-03-12，"remove Koopa backend and template-based IR adapter layer"）把 Koopa 整条路径删掉，留 LLVM。这是个**反直觉**的决定——很多教程把"支持多 IR 后端"当成炫技点。这里删它的逻辑是：

> **AST 已经只依赖 `CodeGen` 的方法名，不依赖任何 LLVM 类型本身**。Koopa 后端在 [#22](https://github.com/leafvmaple/blog/issues/22) 上线后只是"能跑"，没人用它产 ELF；与其维护一个永远落后于 LLVM 后端的副本，不如把适配层一起删了。**接缝的意义不在多后端，而在"先有可换的接缝、再决定换不换"**。

`src/ir/codegen.h` 是这条接缝。看一眼前几个方法签名：

```cpp
class CodeGen {
public:
    llvm::Value* CreateAdd(llvm::Value* lhs, llvm::Value* rhs);
    llvm::Value* CreateLoad(llvm::Value* src);
    llvm::Value* CreateGEP(llvm::Type* type, llvm::Value* array, std::vector<llvm::Value*> index);
    llvm::BasicBlock* CreateBasicBlock(const std::string& name, llvm::Function* func);
    // ... 共 ~140 个方法
};
```

它**几乎是 `llvm::IRBuilder` 的一比一转发**，加一点点 AST 友好的便利方法（`MakeArrayType(elemType, dims)` 一步建多维数组类型、`StoreScalar(value, dest, elemType)` 顺手处理 i32→i8 截断）。这种"薄到只比 IRBuilder 多一层窗户纸"的封装，曾经是 Koopa/LLVM 两面派的可换接缝；现在它的存留价值变成：

1. **AST 不直接 include `<llvm/IR/IRBuilder.h>`**：除了 `ast/type.cpp` 这一处真正映射 `BaseType::TYPE::INT → llvm::Type::getInt32Ty()`，整个 `src/ast/` 不出现 LLVM 类型。这让 AST 单元测试理论上可以 mock `CodeGen` 跑（虽然目前没这么做）。
2. **如果哪天真的要再换 backend**（比如直接产 RISC-V 汇编、跳过 LLVM），改的是 `codegen.{h,cpp}` 这 ~500 行，AST 1,016 行一字不用动。

`ba52eea` 的删除复盘、`codegen.h` 薄壳具体如何收敛 `IRBuilder` 的几个棘手 API（`CreateGEP` 在 opaque pointer 之后必须传 source element type、多维数组初始化要 row-major 展平），是 [#22](https://github.com/leafvmaple/blog/issues/22) 整篇要讲的事。

---

<a id="sec-2"></a>
## 2. 第二个决定：ABI 和 runtime 是编译器的组成部分 (`962ce2b` / `06b07a5`)

一个"能在自家 OS 上跑"的编译器，**必须自带 runtime**。Zonix 的 `exec` 加载一个 ELF 之后，控制权落在 ELF 的 entry point——那个地址里的代码必须是 `crt0._start`，它清栈帧 / 调用 `main` / 把 `main` 的返回值传给 `sys_exit`。这个 `crt0` 必须由编译器项目提供，因为：

- **不能用宿主 libc 的 `crt0`**：它 setup TLS、调用 `__libc_start_main`、走 ELF init array——这些桩 Zonix 全都没有。
- **不能让用户每次手写**：那等于每个用户程序都得维护一个汇编入口。
- **不能要求 OS 来提供**：Zonix 不知道 zcc 选了什么 calling convention、不知道它把退出码放在哪个寄存器。

所以 [`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5)（2026-03-13，"add freestanding runtime library and ELF generation for custom OS"）把 `src/runtime/` 加进 zcc 自己的源树。结构是：

```
src/runtime/
├── syscall.h         ← 单一真相源，纯 C 宏，能被汇编 include
├── printf.c          ← 走 sys_write，不依赖任何 libc
├── minilib.h
├── x64/
│   ├── crt0.S        ← _start: call main; sys_exit(rax)
│   ├── syscall.S     ← sys_write / sys_read / sys_open / sys_close / sys_exit / sys_pause
│   └── linker.ld     ← 加载到 0x400000，铺 .text/.rodata/.data/.bss
└── riscv64/          ← 同上三件套，convention 换成 ecall + a0/a7
```

`-x64` / `-riscv64` 给 `main.cpp` 的命令行选项触发：先 LLVM IR → `llc` 出汇编 → `clang -c` 出 `.o` → `ld -T linker.ld crt0.o user.o libzccrt.a` 拼出最终 ELF（见 [`main.cpp:107-146`](https://github.com/leafvmaple/zcc/blob/main/src/main.cpp#L107-L146)）。一行命令就出可加载 ELF，**不需要用户知道 `crt0` / `linker.ld` 的存在**。

但这只是把 runtime 物理上塞进了仓库。真正"和 OS 形成契约"的关键是 [`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b)（2026-04-08，"implement full syscall ABI with shared header"）：

```c
/* src/runtime/syscall.h —— 注意是纯 C 宏，能被 .S 文件 #include */
#define NR_EXIT  1
#define NR_READ  3
#define NR_WRITE 4
#define NR_OPEN  5
#define NR_CLOSE 6
#define NR_PAUSE 29
```

这份文件在 Zonix [`include/abi/syscall.h`](https://github.com/leafvmaple/zonix-plus/blob/main/include/abi/syscall.h) 里**逐字相同**——zonix-plus 仓库通过 git submodule + symlink/copy 让两边物理同步（详见 [#21](https://github.com/leafvmaple/blog/issues/21) 的接缝实现）。三个消费者：

| 消费者 | 怎么用 |
|---|---|
| Zonix 内核 `kernel/trap/syscall.cpp` | C++ 代码 `case NR_WRITE:` 跳到 `sys_write` 处理函数 |
| zcc 用户程序的 `printf.c` | C 代码 `sys_write(1, &c, 1);`——`sys_write` 自身是 `.S` 桩 |
| zcc runtime `syscall.S` | 汇编 `movq $NR_WRITE, %rax; int $0x80` |

**任何一方写错一个号，编译期就被 include 的同一份头文件拽回来**。这条接缝和 Zonix [#14](https://github.com/leafvmaple/blog/issues/14) 里 `BootInfo` 是 bootloader / 内核共享契约同源——**只要存在跨边界的常量约定，就给它一个唯一的物理来源**。

为什么 `syscall.h` 必须是纯 C 宏、不能是 `enum class` / `constexpr`？因为它要被 `.S` 文件 include。汇编 preprocessor 只认 `#define`，认不了 C++ 类型。这条约束反过来证明了它是真的"跨语言契约"，而不是"我把 C++ 常量复制了一份给汇编"。

`syscall.h` 在 zcc 这边的具体使用、`crt0.S` 怎么把 `main` 的返回值递给 `sys_exit`、`linker.ld` 为什么把 entry point 写在 `0x400000`（Zonix 的用户地址空间布局，详见 Zonix [#18](https://github.com/leafvmaple/blog/issues/18) §1），是 [#21](https://github.com/leafvmaple/blog/issues/21) 整篇要讲的事。

---

<a id="sec-3"></a>
## 3. 第三个决定：前端有意停在"小 C" (`3871ee4`)

zcc 起步是 PKU 编译实验课的 SysY 语言（int 标量 + 一维数组 + 函数 + while + if-else，**没有 char / for / 字符串字面量 / printf**）。要编 Zonix 上的 `hello.c`，必须扩到能写：

```c
int main() {
    int i;
    for (i = 0; i < 5; i = i + 1)
        printf("hello %d\n", i);
    return 0;
}
```

[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4)（2026-03-12，"extend SysY to C0 language with char, for-loop, printf/scanf"）只加了这几样：

1. `char` 类型 + 字符字面量（`'a'` 走 lex 直接产 `INT_CONST`，类型在 AST 里标 `CHAR`）
2. 字符串字面量 + `printf` / `scanf` 作为 vararg builtin（`CompUnitAST::Codegen` 里硬编码注入）
3. `for (init; cond; step) stmt` 语法 + `break` / `continue`
4. 短路 `&&` / `||` 已经在 SysY 里有，沿用

**没加**的更值得说：

| 没加的特性 | 为什么 |
|---|---|
| `struct` / `typedef` | Zonix 的用户程序目前都是 `int main() { printf(...); return 0; }` 级别，零 struct 需求 |
| `float` / `double` | 涉及 IEEE 754 + FP 寄存器调用约定 + soft-float fallback，工程量爆炸；用户程序不需要 |
| `switch` / `goto` | LLVM 层是 `switch` 指令 + label——但 LALR 文法处理起来要加 4-5 条 reduce，且和现有 `break/continue` 跳转逻辑（[`EnterWhile`/`ExitWhile`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.cpp#L356) 那套栈结构）不是直接复用 |
| preprocessor (`#include` / `#define`) | 整个 lexer 要重做一遍。Zonix 的用户程序不分文件、没有 macro 需求 |
| pointer 类型（用户态显式 `int*`） | 数组参数已经退化成指针（[`pointerParam` 标位](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.h#L24-L30)）够用 |
| 多文件链接（`.o` 之间的符号解析） | 现在 zcc 一次只编一个翻译单元，靠最后 `ld` 把 runtime 的 `.o` 链进来 |

这个清单写出来很容易让人觉得"那这编译器没什么用啊"。但**重点是"做这条决策的瞬间"**——加 `struct` 是一周工作量、加 `float` 是两周、加 preprocessor 至少两周——而这些时间用在 Zonix 这边可以推到 [#19 侵入式链表](https://github.com/leafvmaple/blog/issues/19) 或 SMP 调度上去。**克制比完整重要**，因为这个项目的 KPI 是"能闭环"不是"能编 busybox"。

C0 演进的具体细节（dangling-else 怎么用 MatchedStmt/UnmatchedStmt 解 / `char` 是 i8 但表达式统一在 i32 跑 / 数组参数 decay 的 GEP 处理 / `printf` 作为 vararg builtin 注入），是 [#23](https://github.com/leafvmaple/blog/issues/23) 整篇要讲的事。

---

<a id="sec-4"></a>
## 4. 系列文章

主索引帖只串骨架。三个子系统各自一篇深读：

| # | 主题 | 一句话内容 |
|---|---|---|
| [#21](https://github.com/leafvmaple/blog/issues/21) | 单一 `syscall.h` 接缝 + freestanding runtime | 一份 `.h` 同时被 C++ 内核、C 用户程序、`.S` 汇编 include；`crt0` 怎么把 `main` 的退出码递给 `sys_exit`；`linker.ld` 为什么把 entry 写在 0x400000；"从 `clang test/hello.c` 到内核 `exec()` 跑起来"端到端走一遍 |
| [#22](https://github.com/leafvmaple/blog/issues/22) | 删掉一个 IR 后端：LLVM codegen 薄壳的取舍 | `ba52eea` 删 Koopa 的复盘；`codegen.h` 为什么是 ~140 个方法的 IRBuilder 薄壳；多维数组的 row-major 展平 + opaque pointer 之后 `CreateGEP` 必须显式传 source element type；`i8 char` 在 i32 表达式里的窄/扩纪律 |
| [#23](https://github.com/leafvmaple/blog/issues/23) | SysY → C0：前端的最小可用扩展 | bison LALR 的 dangling-else（MatchedStmt/UnmatchedStmt 二分文法）；为什么 `char` lex 产 `INT_CONST` 而类型标在 AST 上；`printf` / `scanf` 作为 vararg builtin 注入；数组参数 decay 与 `FuncFParamAST::isArray` 标位 |

---

<a id="sec-5"></a>
## 5. 闭环之后还成立的几条事实

下面这几条放在这里，是因为它们**在做技术决策时还是猜测、写到这里已经被一年半的迭代各自反例过一遍**。

1. **3,100 行就够跑通 `hello.c` 全链路**。前端 710 + AST/codegen 1,529 + 主驱动 181 + runtime 450 = 2,870。剩下 200 行散在 scanner / type / 几个 helper。这个数字反过来说明：编一个能在自家 OS 上跑的 `printf("Hello\n")`，前端只要够覆盖 "int main / int 数组 / for / printf"，后端只要不自己写、全委派给 LLVM，runtime 只要不依赖宿主 libc——就够了。

2. **删掉 Koopa 后端那天 AST 一行没动**。[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) 的 diff 集中在 `src/ir/` 和构建脚本，`src/ast/` 零改动。这是"先有可换的接缝"价值的物证——不是因为接缝设计得多巧妙，而是因为 AST 从一开始就只依赖 `CodeGen` 的方法名、不依赖 IR 类型本身（详见 [#22](https://github.com/leafvmaple/blog/issues/22)）。

3. **一份 `syscall.h` 真的杜绝了"4 号到底是 read 还是 write"的漂移**。从 [`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b)（2026-04-08）到现在 6 周，三方（内核 / 用户程序 C / 用户程序 `.S`）没有出现过一次"我以为这个号是 X"的 bug。这条约定不是约束、是物证：只要存在跨边界的常量约定，把它的物理来源压缩到一个文件，漂移就消失了（详见 [#21](https://github.com/leafvmaple/blog/issues/21)）。

4. **`char` 是 i8 但表达式跑 i32 是 LLVM IR 的"默认社会规则"**。早期 zcc 把 `char` 也按 i32 处理，`char arr[3] = {1,2,3}` 实际占 12 字节、`arr[1]` 算地址时 GEP 步长按 4。[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe)（2026-05-22，"make char an 8-bit type and correct array addressing"）才修对。这个修复触及 store/load 全链路——任何 `char` 值的存入要 truncate i32→i8、任何 `char` 值的取出要 sign-extend i8→i32。`codegen.h` 里 `StoreScalar` / `CreateLoadInt` / `ConvertInt` 三个 helper 就是为这件事服务的（详见 [#22](https://github.com/leafvmaple/blog/issues/22) §3）。

5. **freestanding `printf` 没有 buffer**。[`printf.c`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/printf.c) 的 `put_char` 每个字符直接 `sys_write(1, &c, 1)` 一次 syscall，没有任何 stdout buffer。这在宿主 libc 看起来是疯子行为——syscall 的开销是用户态/内核切换；但在 Zonix 这种实验内核上**反而是优点**：测试时打印的内容立刻可见，永远不会因为程序崩在 `printf` 之后丢日志，也不需要 `fflush(stdout)`。等真的有用户程序在意性能再补 buffer，现在不是。

6. **回归测试用 host clang 当 oracle**。[`test/run_tests.sh`](https://github.com/leafvmaple/zcc/blob/main/test/run_tests.sh) 对每个 `test/cases/*.c`：zcc 出 LLVM IR → 用 host clang 链宿主 libc 跑、把 stdout 和 `.expected` diff（[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f)，2026-05-22）。这是个"作弊"测法——不验证 `-x64 -riscv64` 跑在 Zonix 上的真实输出，但验证了**前端 + LLVM IR 的语义和真 C 一致**。Zonix 那边的端到端覆盖由 [`551394f`](https://github.com/leafvmaple/zonix-plus/commit/551394f) exec 集成测试补上。两边测试加起来才是闭环的完整覆盖（详见 [#23](https://github.com/leafvmaple/blog/issues/23) §4）。

---

## 迭代记录

<!-- 本主帖是索引 + 元经验帖，不沉淀具体子系统结论。子系统级演进追加到对应子篇；
     跨子系统的结构变更（新增 backend、改 runtime 布局、扩 ABI）在这里追加一句索引。 -->

- 2026-05-23：zcc 独立成系列。在此之前它在 Zonix [#18 §6](https://github.com/leafvmaple/blog/issues/18) 里只被点了一笔。配套把 Zonix [#11 §4 表格](https://github.com/leafvmaple/blog/issues/11) 加了一行"配套工具链"链接、[#18 §6](https://github.com/leafvmaple/blog/issues/18) 扩成正式简介 + 链到本篇。
- 2026-05-22：[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe) `char` 改为真正的 i8 类型（之前按 i32），同时把数组寻址 GEP 步长从 4 改为 1，连带把 `chartrunc` / `charscalar` / `chararray` 等 5 个测试用例从失败救回（详见 [#22](https://github.com/leafvmaple/blog/issues/22) §3）；[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f) 加 15 个回归测试用例，host clang 当 oracle。
- 2026-04-08：[`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b) `syscall.h` 改为单一真相源，物理 include 在 Zonix 内核（[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）、zcc runtime、`.S` 桩三方。从这天起跨边界的 syscall 号契约只有一个物理来源。
- 2026-03-13：[`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5) 加 freestanding runtime（`crt0.S` / `syscall.S` / `linker.ld` / `printf.c`）和 ELF 生成路径。`-x64` / `-riscv64` 选项首次能产出可直接被 Zonix `exec()` 加载的 ELF。
- 2026-03-12：[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) 删 Koopa IR 后端 + 模板适配层。`src/ast/` 一字未动。同日 [`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) 把 SysY 扩为 C0（加 `char` / `for` / `printf` / `scanf`）。两件事一起完成了"准备好接入 Zonix"的语言层 + 后端层准备。
- 2025-08：项目主体实现完成。从 [`d927451`](https://github.com/leafvmaple/zcc/commit/d927451)（pass lv3 test）到 [`f4344fe`](https://github.com/leafvmaple/zcc/commit/f4344fe)（pass autotest lv9），覆盖了完整的 SysY 标量 / 数组 / 函数 / 控制流，但还没有 runtime、没有 ELF 路径。

---

*仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)。配套 OS：[Zonix OS 主索引帖](https://github.com/leafvmaple/blog/issues/11)。*
