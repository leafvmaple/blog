<!--pub:2026-02-15-->
# 删掉一个 IR 后端那天净减 1,414 行：zcc 的 LLVM codegen 是怎么瘦成薄壳的

> 仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)
> 系列：[zcc 主索引帖 #20](https://github.com/leafvmaple/blog/issues/20) 的后端深读
> 涉及子系统：`src/ir/codegen.{h,cpp}` / `src/ast/ast.cpp` 的 `Codegen()` 方法 / 早期被删除的 `src/ir/{ir.h,koopa_ir.*,llvm_ir.*}` 和 `src/ast/ast.tpp`

如果只看一个 commit 来理解 zcc 后端的设计，应该看 [`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea)（2026-03-12，"remove Koopa backend and template-based IR adapter layer"）。它**删了 2,552 行、加了 1,138 行，净 -1,414**。删掉的东西包括：

- 一整套 `Env<Type, Value, BasicBlock, Function>` 模板适配层（`src/ir/ir.h`，167 行）
- Koopa IR 后端（`koopa_ir.{h,cpp}`，846 行）
- LLVM IR 后端的早期实现（`llvm_ir.{h,cpp}`，431 行）
- 模板化的 AST codegen（`src/ast/ast.tpp`，782 行）

加进来的：单一的 `CodeGen` 类（`src/ir/codegen.{h,cpp}`，初版 410 行，目前 497 行）+ 把 AST codegen 从模板搬回普通成员函数（`ast.cpp` 增加 720 行）。**commit message 里关键的一句是"preserving identical LLVM IR output for all existing test cases"**——这是删除的合法性证明：等价类没变，少了 1,414 行。

这一篇拆这次"减法重构"背后的几件事：薄壳应该多薄、IRBuilder 之上还要不要加封装、char-i8 / 表达式-i32 的窄扩纪律、opaque pointer 之后 GEP 的两种形状、短路 `&&`/`||` 为什么必须走控制流而不是 boolean 算术。

---

## 1. 删掉 Koopa 后端这件事本身

zcc 的最初目标是 PKU 编译实验课 SysY → Koopa IR（[`1cae145`](https://github.com/leafvmaple/zcc/commit/1cae145) 加 Koopa 后端）。后来一边教学需求加 Koopa、一边为了对接真编译流水线又加了 LLVM 后端（[`3b0780b`](https://github.com/leafvmaple/zcc/commit/3b0780b)），结果是同时维护两套 IR。架构上的解法是引入一层 IR 适配模板：

```cpp
// 已删除的 src/ir/ir.h（重构前的样子）
template<typename Type, typename Value, typename BasicBlock, typename Function>
class Env {
public:
    virtual Value* CreateAdd(Value* lhs, Value* rhs) = 0;
    virtual Value* CreateLoad(Value* src) = 0;
    // ...
};

// AST 节点的 codegen 走模板，理论上对两个后端都跑
template<typename E>
llvm::Value* BinaryExprAST::ToValue(E* env) { /* ... */ }
```

代价是 `ast.tpp` 里 782 行模板代码 + 显式模板实例化、两份 `koopa_ir.cpp` / `llvm_ir.cpp` 各自把同样的"加减乘除 ⇒ IR"逻辑写一遍——只是底层 SDK 不同。

**真问题**是：Koopa 后端跑不出 ELF。Koopa 是教学 IR，它输出的 `.koopa` 文件需要走 PKU 的 `koopac` 工具链才能继续编译，没有现成的"Koopa → 真实机器码"路径。当 [#20](https://github.com/leafvmaple/blog/issues/20) 的目标变成"产出能在 Zonix 上跑的 ELF"，Koopa 这条路就**永远不会到达终点**——任何在它上面投入的维护成本都是沉没成本。

[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) 的删除方式是：

1. 把 `ast.tpp` 里所有模板 `Codegen<E>` 方法搬回 `ast.cpp` 的普通成员函数，直接调具体的 `CodeGen* cg`
2. 把原本的 `llvm_ir.{h,cpp}` 重写为更直接的 `codegen.{h,cpp}`（这部分留着但简化了，下文 §2）
3. 删掉 `ir.h`（模板基类）、`koopa_ir.{h,cpp}`、`llvm_ir.{h,cpp}` 旧版、`ast.tpp` 全部 5 个文件 1,945 行
4. 验证：所有现有 `test/cases/*.c` 跑出来的 LLVM IR 与重构前**字节级相同**——这是 commit message 那句"preserving identical LLVM IR output"的物证

> 这次重构能成立的前提是"先有可换的接缝、再决定换不换"。如果 AST 一开始就直接调 LLVM IRBuilder，删 Koopa 这件事根本不会发生，因为它从来没有过两个后端。**有过多后端这件事的价值，不是"未来可以再换"，而是"现在能确定它不值得保留"**——只在拥有过抽象之后才知道抽象的代价。

删完之后 `src/ast/` 的代码一字不依赖 LLVM 类型，除了 `ast/type.cpp` 里把 `BaseType::TYPE::INT` 映射到 `llvm::Type::getInt32Ty()` 这一处真正的边界。从此 AST 通过 `CodeGen*` 间接接触 LLVM——薄壳的存在让"AST 不直接 include LLVM 头"这件事在不需要模板的代价下成立。

---

## 2. codegen.h 这层薄壳到底多薄

[`src/ir/codegen.h`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.h) 138 行声明、`codegen.cpp` 359 行实现。方法按类别看：

| 类别 | 方法数 | 性质 |
|---|---|---|
| 类型构造（`GetInt32Type` / `GetArrayType` / ...） | 11 | 几乎全是 `IRBuilder` 一行转发 |
| 函数 / 基本块 / 调用 | 6 | 同上 |
| 内存（`CreateAlloca` / `CreateLoad` / `CreateStore` / `CreateGEP`） | 9 | 大部分转发，少数加了 char 截断逻辑 |
| 常量 | 5 | 转发 + `MakeArrayConstant` 多维聚合 |
| 算术 / 比较 | 13 | 全转发 |
| 控制流 | 6 | 全转发 |
| 类型转换（`ConvertInt`） | 3 | 真正有价值的封装（下面 §3） |
| 作用域 / while 跟踪 | 7 | 自己维护的 `vector<map<string, Symbol>>` 和 `vector<WhileData>` |

加起来 ~70 个 public 方法（加上少量重载到 ~140），其中**真正比 `IRBuilder` 多做事的不到 10 个**：

```cpp
// codegen.h 里真正"封装了什么"的那些方法
llvm::Type*  MakeArrayType(llvm::Type* elem, const std::vector<int>& dims);  // 一步建多维数组类型
llvm::Type*  PeelArray(llvm::Type* type, int levels);                        // 按层数剥离
void         StoreScalar(llvm::Value* value, llvm::Value* dest, llvm::Type* elemType);  // 自动截断 i32→i8
llvm::Value* CreateLoadInt(llvm::Value* ptr, llvm::Type* elemType);          // 自动扩展 i8→i32
llvm::Value* ConvertInt(llvm::Value* value, llvm::Type* dst);                // 整型间窄/扩
llvm::Constant* MakeArrayConstant(llvm::Type* elemType, const std::vector<int>& dims,
                                  const std::vector<llvm::Value*>& flatValues);  // row-major 多维聚合常量
void         EnterScope() / ExitScope() / AddSymbol() / GetSymbol();          // 作用域 + 符号表
void         EnterWhile() / ExitWhile() / GetWhileEntry() / GetWhileEnd();    // break/continue 跳转目标
```

这 10 个方法**不是 IRBuilder 的转发**——它们是把"语言层概念"翻译成"IR 层动作"的真正接口。其余 60 个方法是为了让 AST 能完全通过 `CodeGen*` 接触 LLVM、避免它直接 include `<llvm/IR/IRBuilder.h>`。

这个比例是**合理的**：薄到主要承担"间接性"职责的转发占大多数；真正添加语言层抽象的（多维数组类型、char 窄扩、符号表、循环跳转栈）单独列出，每一个都对应 AST 里反复用到的模式。**不要为了"看起来工程"而往薄壳里塞通用辅助方法**——`PeelArray` 这种只有 LValAST 一处用、但 LValAST 那处确实要写 2-3 行的辅助逻辑，进了薄壳就够了；不会有"再过半年还会有第二个用户"的幻觉。

---

## 3. char-i8、表达式-i32：窄扩纪律 (`6f1e4fe`)

zcc 早期把 `char` 也按 `i32` 处理——`char arr[3] = {1, 2, 3}` 在内存里实际占 12 字节、`arr[1]` 算地址时 GEP 步长按 4。问题在 [`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe)（2026-05-22，"make char an 8-bit type and correct array addressing"）才被全面修对。

LLVM IR 里 `char` 应当是 `i8`、`int` 是 `i32`，但**所有表达式中间值统一在 i32**——这是 LLVM 的"社会规则"，原因：

1. C 语义本来就允许"`char c = 'a' + 1`"这种隐式提升
2. 算术指令在 i8 上能跑但常数立即数会被自动扩成 i32，混着写很丑
3. 比较 / 短路逻辑全部以 i32 比 0 来表示真假，统一在 i32 最省事

这就要求**任何 i8 存储边界都做窄扩**：

- **store i32 → i8**：写 `char` 变量 / 数组元素时，把表达式的 i32 截到 i8
- **load i8 → i32**：读 `char` 变量 / 数组元素时，sign-extend 回 i32
- **call 时**：i32 实参传给声明为 `char` 的形参时截到 i8；声明为 `char` 的返回值在调用点扩回 i32
- **return 时**：声明返回 `char` 的函数，return 值前先截

这五种边界场景全部由 `codegen.h` 的三个方法统一处理：

```cpp
// codegen.cpp:166-181
void CodeGen::StoreScalar(llvm::Value* value, llvm::Value* dest, llvm::Type* elemType) {
    Builder.CreateStore(ConvertInt(value, elemType), dest);   // 写入前先 ConvertInt 截/扩到目标
}

llvm::Value* CodeGen::CreateLoadInt(llvm::Value* ptr, llvm::Type* elemType) {
    llvm::Value* v = Builder.CreateLoad(elemType, ptr);
    return ConvertInt(v, GetInt32Type());                     // 读出后立刻扩回 i32
}

llvm::Value* CodeGen::ConvertInt(llvm::Value* value, llvm::Type* dst) {
    llvm::Type* src = value->getType();
    if (src == dst || !src->isIntegerTy() || !dst->isIntegerTy())
        return value;
    unsigned sb = src->getIntegerBitWidth(), db = dst->getIntegerBitWidth();
    if (sb < db) return Builder.CreateSExt(value, dst);       // 窄 → 宽：sign-extend
    if (sb > db) return Builder.CreateTrunc(value, dst);      // 宽 → 窄：truncate
    return value;
}
```

调用点遍布 AST：`StmtAST::TYPE::Assign` 走 `StoreScalar`、`StmtAST::TYPE::Ret` 用 `ConvertInt(retval, getReturnType())`、`UnaryExprAST::Call` 把函数返回值扩到 i32、`CreateCall` 把每个实参在传入前 `ConvertInt(args[i], ft->getParamType(i))`。**纪律的强度由"所有边界都强制过 helper"保证**，AST 节点不允许跨过这层直接写 store/load——这样 i8/i32 漂移不会因为"忘了一处"而留下。

**为什么 sign-extend 而不是 zero-extend？** 因为 SysY/C0 里 `char` 视为有符号（和 C 语言一样）。`char c = -1; int i = c;` 应该得到 `i == -1` 而不是 `255`。这一条藏在 `ConvertInt` 用 `CreateSExt` 而不是 `CreateZExt` 那一行里——是个**完全靠 ConvertInt 这个单点决定的语义选择**。如果哪天要支持 `unsigned char`，改这一个函数就够了（实际还要在 `BaseType` 里加 unsigned 标志、`ConvertInt` 接收类型加一个 signedness hint）。

---

## 4. opaque pointer 时代的 GEP：两种形状

LLVM 15 之后所有指针都是 `ptr` 类型，不带 pointee 类型信息——所有 GEP（`getelementptr`）必须**显式传入 source element type** 作为第一个参数。这对 zcc 是个不小的设计驱动：**必须在符号表里记下每个绑定的 storage element type**，否则后续做 `arr[i]` 时不知道 GEP 应该填什么类型。

[`codegen.h:24-30`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.h#L24-L30) 的 `Symbol` 结构：

```cpp
struct Symbol {
    llvm::Value*   value = nullptr;       // alloca / global 的地址，或局部 const 的立即常量
    llvm::Function* function = nullptr;   // 函数符号
    VAR_TYPE       kind = VAR_TYPE::VAR;
    llvm::Type*    type = nullptr;        // 关键：storage 的 element type
    bool           pointerParam = false;  // 是否是"数组退化成指针"的形参
};
```

`type` 字段对不同绑定意义不同：

| 绑定形态 | `type` 字段含义 |
|---|---|
| 标量 `int x` | `i32` |
| 标量 `char c` | `i8` |
| 一维 `int a[3]` | `[3 x i32]`（**整个数组类型**） |
| 多维 `int m[2][3]` | `[2 x [3 x i32]]` |
| 数组参数 `int p[]` | `i8`/`i32` 等 **pointee element type**（不是 `[N x T]`） |

最后那一行就是 §4 标题"两种形状"的来源。`LValAST::ToPointer` 看 `pointerParam` 标位决定 GEP 形状（[`ast.cpp:611-639`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L611-L639)）：

```cpp
if (sym.pointerParam) {
    // 数组退化参数：addr 是一个槽，里面装着 pointer。先 load 出真正的指针。
    llvm::Value* base = cg->LoadPointer(addr);
    addr = cg->CreateGEP(container, base, idx);              // gep T, ptr <loaded>, i0, i1, ...
    elemOut = cg->PeelArray(container, (int)idx.size() - 1);
} else {
    // 真正的数组对象：addr 已经是数组指针，需要 leading zero "走进"数组。
    vector<llvm::Value*> gidx{cg->GetInt32(0)};
    for (auto* v : idx) gidx.push_back(v);
    addr = cg->CreateGEP(container, addr, gidx);             // gep [N x T], ptr <addr>, 0, i0, i1, ...
    elemOut = cg->PeelArray(container, (int)idx.size());
}
```

两条 GEP 的差异：

```
真正的数组 int m[2][3]：
    %m = alloca [2 x [3 x i32]]
    %p = getelementptr [2 x [3 x i32]], ptr %m, i32 0, i32 i, i32 j     ← 有 leading zero
                                                       ↑   ↑
                                                       第一层维度   第二层

数组参数 int m[][3]（退化为 ptr 指向 [3 x i32]）：
    %m = alloca ptr                              ← 形参槽
    store %incoming_ptr, ptr %m                  ← 存入函数实参
    %loaded = load ptr, ptr %m                   ← LoadPointer
    %p = getelementptr [3 x i32], ptr %loaded, i32 i, i32 j   ← 无 leading zero
                                                ↑
                                                直接从 incoming_ptr 起步
```

为什么数组参数没有 leading zero？因为退化指针**已经指向数组的第一个元素**，不是"指向数组对象本身"。`gep [3 x i32], ptr, i` 等价于 C 的 `ptr[i]`，步长是一个 `[3 x i32]` 的字节数（12）；`gep [3 x i32], ptr, i, j` 等价于 `ptr[i][j]`。

这也是为什么 `Symbol.type` 在数组参数情况下存的是**元素类型**而不是数组类型——因为数组类型本身在退化时已经被剥掉一层了。`FuncFParamAST::Alloca` 处建立绑定时显式标 `pointerParam = true`（[`ast.cpp:664`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L664)），整个 GEP 形状的分支就被这一个 bool 守住。

---

## 5. 短路 `&&` / `||` 走控制流，不走 boolean 算术

这是个经典的"教学时容易写错"的点。SysY/C0 的 `a && b` 要求**当 `a == 0` 时 `b` 不被求值**——所以不能写成：

```llvm
%a_val = ...
%b_val = ...        ; ← 错：b 已经被求值了
%bool_a = icmp ne i32 %a_val, 0
%bool_b = icmp ne i32 %b_val, 0
%and = and i1 %bool_a, %bool_b
```

正确实现要用 IR 里的**分支**而不是 `and` 指令。[`LAndExprAST::ToValue`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L486-L506)：

```cpp
auto* leftVal = left->ToValue(cg);
auto* rightBB = cg->CreateBasicBlock("land_right", func);
auto* endBB   = cg->CreateBasicBlock("land_end", func);
auto* result  = cg->CreateAlloca(cg->GetInt32Type(), "land_result");
auto* cond    = cg->CreateICmpNE(leftVal, cg->GetInt32(0));

cg->CreateStore(cond, result);                       // 先把 left 的真假存进 result
cg->CreateCondBr(cond, rightBB, endBB);              // 真才跳去算 right

cg->SetInsertPoint(rightBB);
cond = cg->CreateICmpNE(right->ToValue(cg), cg->GetInt32(0));
cg->CreateStore(cond, result);                       // 覆盖 result
cg->CreateBr(endBB);

cg->SetInsertPoint(endBB);
return cg->CreateLoad(result);
```

`||` 同形，只是 `CreateCondBr(cond, endBB, rightBB)` 颠倒（真就直接跳 end）。

```
%result = alloca i32
%a = ...                                    ; ← left 的值
%cond_a = icmp ne i32 %a, 0
store i32 %cond_a, ptr %result              ; ← 短路情况下的结果
br i1 %cond_a, label %land_right, label %land_end

land_right:
%b = ...                                    ; ← right 只在 a 为真时才求值
%cond_b = icmp ne i32 %b, 0
store i32 %cond_b, ptr %result
br label %land_end

land_end:
%out = load i32, ptr %result
```

`result` 这个 alloca 是**有意为之的简单方案**——理论上 LLVM 的标准做法是用 SSA `phi` 节点，但 phi 需要 AST 这边记住每个 incoming 来自的 BB，写起来繁琐。alloca + load 走 LLVM 的 `mem2reg` pass 同样能在优化时被提升回 phi，**生成期写得简单 / 优化期再提升**这条路径在教学性编译器里是合理选择。

> 关于 SSA / phi vs alloca：在不优化的情况下生成的 IR 直接读起来 phi 节点更紧凑、`mem2reg` 会把 alloca + load/store 提成 phi 节点最终生成相同的代码。clang 自己生成的 IR 也大量用 alloca，不会一开始就直接构造 phi——因为前端要追踪每个 SSA 变量的所有 incoming 太复杂。zcc 抄了这个 idiom。

---

## 6. `Optimize()` 被 `#if 0` 包着：一段诚实的不归路

[`codegen.cpp:19-41`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.cpp#L19-L41) 有这么一段：

```cpp
void CodeGen::Optimize() {
#if 0
    llvm::PassBuilder pb;
    llvm::FunctionAnalysisManager fam;
    // ...
    llvm::FunctionPassManager fpm;
    fpm.addPass(llvm::ADCEPass());        // 死代码消除
    fpm.addPass(llvm::SimplifyCFGPass()); // CFG 简化（合并块、删空块）
    // ...
    mpm.run(Module, mam);
#endif
}
```

这是 zcc 端的优化 pass——目前被 `#if 0` 关掉。函数还在被 `main.cpp:163` 调用，但里面什么都不发生。

为什么不删？因为这一段曾经能跑——ADCE + SimplifyCFG 这两个 pass 都已经过验证、IR 输出更干净。关掉的原因是工程权衡：

- **下游 `llc` 已经会做这两个优化**。zcc 的产出走 `llc -O0`（[`main.cpp:129`](https://github.com/leafvmaple/zcc/blob/main/src/main.cpp#L129)），但 `llc` 本身在 instruction selection 之前会跑一遍标准 mid-end 简化。zcc 这边的 ADCE 几乎没价值——同样的死指令 `llc` 会再清一次。
- **构建复杂度上去了**。`llvm::PassBuilder` 引入会让 `codegen.cpp` 多 include 一打 `<llvm/Passes/*>` 和 `<llvm/Transforms/*>` 头文件，编译时间显著上涨。
- **debug 时希望看到的 IR 越"原始"越好**。zcc 自己手写的逻辑出错时（比如 §4 那个 GEP 形状选错），ADCE 跑过的 IR 已经把"我以为生成了但被删掉"的指令消除掉，反而难调。

所以最后的状态是**留代码、关 `#if 0`**——下次真有人需要 zcc 端做某个特定的 pass（比如未来某种 zcc-specific 的常量折叠），把 `#if 0` 改成 `#if 1` 就能从头开始。**不删等于一份未来的轨迹**：曾经走到过这里、撤回是有理由的，理由在 commit 历史里。

这种"诚实地把 `#if 0` 留下"是 Zonix [#13 §3](https://github.com/leafvmaple/blog/issues/13) 里"swap 没有反查表"那类**承认现状、不假装完备**的同款克制。

---

## 7. 迭代记录

<!-- 后续 codegen / IR / 优化 pass 演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-05-23：本子篇首次落地。在 §6 公开承认 `Optimize()` 被 `#if 0` 关闭、是诚实的工程取舍而不是 TODO。
- 2026-05-22：[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe) 把 `char` 从"按 i32 处理"改成真正的 i8 + sign-extend / truncate 全链路（见 §3）。同 commit 重写 LValAST 寻址走两种 GEP 形状（见 §4）——这是 opaque pointer 时代必须做对的事，之前的实现产 invalid IR 但被 `llc` 容忍了一阵。`Symbol.type` 字段记录 storage element type 也是这次加的。
- 2026-03-12：[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) 删 Koopa 后端 + 模板适配层（见 §1）。净 -1,414 行，所有现有测试输出 LLVM IR 字节级一致。这是项目从"教学双后端"到"专心做 ELF 工具链"的分水岭。

---

*仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)。本文属于 [zcc 系列](https://github.com/leafvmaple/blog/issues/20)。*
