# 从 SysY 到 C0：在一份教学文法上长出能编 `printf("Hello\n")` 的最小前端

> 仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)
> 系列：[zcc 主索引帖 #20](https://github.com/leafvmaple/blog/issues/20) 的前端深读
> 涉及子系统：`parser/{sysy.l,sysy.y}` / `src/ast/ast.{h,cpp}` / `src/scanner/scanner.cpp` / `test/cases/` 回归测试 / `test/run_tests.sh`

zcc 的前端是从 PKU 编译实验课的 SysY 语言起步的（[`361081b`](https://github.com/leafvmaple/zcc/commit/361081b)，2024-07）：int 标量、一维数组、函数、`if-else`、`while`，**没有 char、没有 for、没有字符串字面量、没有 printf**。要让它能编 Zonix 用户程序 `printf("Hello\n")`，必须扩前端到一个**刚好能写实用 C 子集**的形态。

这件事在一个 commit 完成：[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4)（2026-03-12，"extend SysY to C0 language with char, for-loop, printf/scanf"）—— 加 88 行 bison + 52 行 flex，AST 加 17 行声明 + 6 行实现。整个语言从 SysY 升级到一个**C 的极简子集（这里叫 C0）** 就值这 ~200 行扩展。

这一篇拆 4 件**因为"扩到刚好能用"而必须做对**的事：dangling-else 的 LALR 二分文法、char 字面量怎么在 lex 阶段就被同化为整数、`printf`/`scanf` 作为 vararg builtin 怎么不占文法语法、数组参数 decay 在 LALR 文法里的标位策略。结尾配一段对 15 个回归测试 + XFAIL 基础设施的诚实复盘。

---

## 1. C0 的最小可用增量

[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) 这一个 commit 在 SysY 之上加了：

| 增量 | 怎么加的 |
|---|---|
| `char` 类型 | `BasicType` 文法多一条 `CHAR { ... }`；AST 的 `BaseType::TYPE` 加 `CHAR`；初版还把内部按 i32 处理（[#22 §3](https://github.com/leafvmaple/blog/issues/22) 后来才纠正到真正 i8） |
| 字符字面量 `'a'` | flex 加 `CharLiteral [^\\']\|\\[nrt...]` 模式 + 转义处理，**产出 `INT_CONST`**（下面 §3 详述） |
| 字符串字面量 `"hi"` | flex 加 `StringLiteral \"([^\\"]\|\\.)*\"` 模式 + 处理转义；AST 的 `PrimaryExprAST::TYPE` 加 `String` 分支，codegen 走 `CreateGlobalStringPtr` |
| `for (init; cond; step) stmt` | bison 加 `ForInitClause` / `ForStepClause` 两条辅助文法 + 在 `MatchedStmt`/`UnmatchedStmt` 各加一条规则；`StmtAST::TYPE::For` 在 codegen 里走 4-BB 模板（cond/body/step/end）|
| `printf` / `scanf` 调用 | **没有专门的语法**——它们就是普通的 `IDENT '(' FuncRParams ')'`，靠 `CompUnitAST::Codegen` 启动时 `CreateBuiltin` 注入函数声明（下面 §4） |

**没加**的——`struct` / `typedef` / `union` / `switch` / `goto` / `float` / pointer 类型 / preprocessor / 多文件链接——理由都在 [#20 §3](https://github.com/leafvmaple/blog/issues/20) 那张表里，简单说就是它们对"编一个 `printf("Hello\n")` 跑在 Zonix 上"零贡献。

这个 commit 同期顺手修了三个 LLVM 18 + opaque pointer 时代的 bug（commit message 列得很清楚）：`CreateCondBr` 之前生成 `br i32` 而不是 `br i1`、`CreateLoad` 硬编码 `i32` 类型、`GetElementType` 在 opaque pointer 下会崩。这些是同期 LLVM 升级带来的连锁问题，不是 C0 本身的设计——但 commit 把它们一起修了。

---

## 2. dangling-else：LALR 文法的二分招式

C 的 `if-else` 有个经典歧义：

```c
if (a)
    if (b)
        x = 1;
    else        ←  这个 else 配哪个 if？
        y = 2;
```

如果文法直接写 `Stmt -> IF '(' Expr ')' Stmt | IF '(' Expr ')' Stmt ELSE Stmt`，LALR(1) 在看到 `else` 的时候不知道是 reduce（让外层 if 接管 else）还是 shift（让内层 if 接管 else）——bison 会报 shift/reduce 冲突，并按"shift 优先"的默认让 else 配最近的 if（这恰好是 C 语义要的结果，但是靠"默认行为"凑出来的正确，不是结构性的）。

zcc 的解法是经典的 [Aho/Sethi 龙书 4.3.2](https://en.wikipedia.org/wiki/Dangling_else) 的二分文法：

```yacc
Stmt
    : MatchedStmt
    | UnmatchedStmt
    ;

MatchedStmt   /* 所有 if 都有匹配的 else */
    : IF '(' Expr ')' MatchedStmt ELSE MatchedStmt    /* if-else 内外都已匹配 */
    | /* 其它 stmt: 赋值 / Block / RETURN / WHILE / FOR / BREAK / CONTINUE */
    ;

UnmatchedStmt  /* 含有"裸 if"或"内层 if 还在等 else" */
    : IF '(' Expr ')' Stmt                             /* 裸 if，没 else */
    | IF '(' Expr ')' MatchedStmt ELSE UnmatchedStmt   /* 外层 if-else，但内层 else-分支还含 unmatched */
    | WHILE '(' Expr ')' UnmatchedStmt
    | FOR ( ... ) UnmatchedStmt
    ;
```

效果是**通过文法定义而非默认行为**强制 else 跟最近的 if 配对：能走 `MatchedStmt` 的分支，then-stmt 必须是 `MatchedStmt`——也就是 then-stmt 里面的所有 if 都已经各自配好 else。任何"裸 if"只能进 `UnmatchedStmt` 分支。这样 `if (a) if (b) x=1; else y=2;` 的解析里：

- 内层 `if (b) x=1; else y=2;` 是 `MatchedStmt`
- 外层 `if (a) <MatchedStmt>` 走 `UnmatchedStmt` 的"裸 if"分支
- else 自然配到内层 ✓

而 `for` 和 `while` 在 [`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) 一起接入这个二分体系——`FOR ( ... ) MatchedStmt` 进 `MatchedStmt`、`FOR ( ... ) UnmatchedStmt` 进 `UnmatchedStmt`。否则 `if (a) for (;;) if (b) x=1; else y=2;` 这种嵌套会再次触发 shift/reduce 冲突。

这条文法的好处不只是消歧——它**让冲突永远不出现在 bison 报告里**。如果未来加一条带 stmt 的新 keyword（比如 `unless`、`do-while`），按这个 pattern 加两条规则（match 和 unmatched 各一）就行，永远不会触发新的 shift/reduce。**结构性正确比"shift 优先碰巧对"更稳定**。

---

## 3. `char` 字面量在 lex 阶段就同化成整数

[`sysy.l`](https://github.com/leafvmaple/zcc/blob/main/parser/sysy.l) 的字符字面量规则：

```
CharLiteral   '([^\\']|\\[nrt\\\'\"0abfv])'

{CharLiteral}     {
    int val = (yytext[1] == '\\') ? parse_char_escape(yytext[2])
                                  : static_cast<unsigned char>(yytext[1]);
    return yy::Parser::make_INT_CONST(val, loc);   /* ← 注意：产出 INT_CONST */
}
```

`'a'` 在 lex 阶段直接被解析为 `INT_CONST(97)` —— bison 那边**根本不知道"`'a'` 和 `97` 不一样"**。这种把 char 字面量同化到整数的做法是 C 标准本身允许的（C 标准里 `'a'` 的类型就是 `int`，不是 `char`），lex 这层做了等价转换。

效果是**前端少一个 token 种类、少一组规约规则**：

| 如果不同化 | 实际做法 |
|---|---|
| flex 多一种 `CHAR_CONST` token；bison 在 `Number` / `PrimaryExpr` 里多一条规约（"`CHAR_CONST` 也算 Number"）；AST 加一个 `CharLiteralAST` 或 `NumberAST` 多一个 `isChar` 标位 | 不存在 `CHAR_CONST` token；bison 一字未动；AST `NumberAST` 也一字未动 |

`char` 类型本身（声明、参数、变量、数组）还是通过 bison 的 `BasicType: CHAR` 走文法 + `BaseType::TYPE::CHAR` 进 AST 的——**`char` 类型的存在性 vs `char` 字面量的存在性是两个独立的概念**。zcc 选择前者进文法、后者全在 lex 处理，是因为：

- "声明一个 char 变量"会影响后续表达式的类型，**必须在 AST 里有结构**
- "字面量 `'a'`"和字面量 `97` 在表达式上下文里**完全可互换**，不需要在 AST 里保留差异

这条原则 § 4 又用了一次：字符串字面量也是 lex 阶段产 `STR_CONST` token（带处理过转义的字符串内容），bison 里只在 `PrimaryExpr` 加一条 `STR_CONST { $$ = make_unique<PrimaryExprAST>($1); }`，AST 那边 `PrimaryExprAST::TYPE` 加一个 `String` 分支。**lex 处理"字面量本身怎么算"、bison 处理"它在哪里能出现"、AST 处理"它生成什么 IR"**，三层各干各的事。

---

## 4. `printf` / `scanf`：作为 vararg builtin，不进文法

这俩在 C0 里是用户体感最强的功能（"能写 `printf("Hello\n")` 是这次扩展的整个意义"），但**它们在文法里不存在**——没有 `PRINTF`/`SCANF` token、没有专门的规约规则。

实现就在 `CompUnitAST::Codegen`（[`ast.cpp:241-250`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L241-L250)）：

```cpp
void CompUnitAST::Codegen(CodeGen* cg) {
    auto* intType = cg->GetInt32Type();
    auto* ptrType = cg->GetPointerType(cg->GetInt8Type());

    cg->CreateBuiltin("printf", intType, {ptrType}, true);   /* ← isVarArg=true */
    cg->CreateBuiltin("scanf",  intType, {ptrType}, true);

    for (auto& decl : decls) decl->Codegen(cg);
    for (auto& funcDef : funcDefs) funcDef->Codegen(cg);
}
```

`CreateBuiltin` 把它俩当成**外部声明的 vararg 函数**注入符号表：返回 i32、第一个参数是 `i8*`（C 字符串）、`isVarArg = true`（之后的参数任意类型任意个数）。从用户视角它们和普通函数一样：`printf("%d\n", n)` 走 `UnaryExprAST::TYPE::Call` 路径、`GetSymbol("printf")` 命中 builtin、`CreateCall` 生成 `call i32 @printf(...)`。

那么 `@printf` 的真正实现在哪？答案是 zcc 输出的 `.ll` 文件**只声明、不定义** `@printf`。后续 `clang -c` + `ld` 链接时：

- **`-llvm` 模式**：测试用，链 host libc 的 printf（[`test/run_tests.sh`](https://github.com/leafvmaple/zcc/blob/main/test/run_tests.sh) 用 host clang 跑，host libc 的 printf 是 oracle）
- **`-x64` / `-riscv64` 模式**：链 zcc 自己的 `libzccrt.a`，里面有 [`printf.c`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/printf.c)（走 `sys_write` 直写 fd=1，详见 [#21 §1](https://github.com/leafvmaple/blog/issues/21)）

这个分离的好处：**前端不需要知道 printf 跑在哪个 OS 上**。同一份 LLVM IR 在测试时链 host libc 验证语义、在生产时链 zcc-runtime 跑到 Zonix 上——靠链接器在最后那一步选 backend。**前端复杂度被锁在"我只会说 vararg call"这条最小契约**。

> 关于 `%d` / `%c` 这些 format specifier：**zcc 完全不解析它们**。`printf("%d\n", n)` 在 zcc 这边就是个调 `@printf` 传两个参数的 vararg call、`"%d\n"` 是个普通字符串字面量。`%d` 的语义在 libc / libzccrt 那一端实现。这是 vararg builtin 这条路径最大的红利——前端可以装不知道这个语言有哪些 format specifier。

> 历史注脚：commit message 里写"with %d and %c format specifiers decomposed into putint/putch/getint/getch runtime calls"——这是 [`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) 初版的做法（前端会拆 `printf("%d", n)` 成 `putint(n)`），后来在 freestanding runtime 落地时（[`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5)）改成"前端不拆、runtime 实现完整 printf"——这是更干净的接缝划法。

---

## 5. 数组参数 decay：用一个 bool 标位贯穿前端到 codegen

C 里函数声明 `int sum(int a[], int n)` 是个**类型上的谎言**——`int a[]` 实际是 `int*`，"数组退化为指针"是函数边界的特殊规则。zcc 在 [`sysy.y`](https://github.com/leafvmaple/zcc/blob/main/parser/sysy.y) 里把这件事识别成单独的语法规则：

```yacc
FuncFParam
    : BasicType IDENT '[' ']' ArrayDims {  /* int a[][3]: 退化指针 + 后续维度仍然是数组 */
        $$ = std::make_unique<FuncFParamAST>(std::move($1), $2, std::move($5));
      }
    | BasicType IDENT '[' ']' {            /* int a[]: 纯一维退化 */
        $$ = std::make_unique<FuncFParamAST>(std::move($1), $2, true);
      }
    | BasicType IDENT {                    /* int a: 标量 */
        $$ = std::make_unique<FuncFParamAST>(std::move($1), $2);
      }
    ;
```

注意中间那条 `IDENT '[' ']'`：构造 `FuncFParamAST` 时多传一个 `true`——这就是 `isArray` 标位。`FuncFParamAST::ToType` 在 codegen 时看这个标位决定生成什么 LLVM 类型：

```cpp
llvm::Type* FuncFParamAST::ToType(CodeGen* cg) {
    llvm::Type* type = btype->Codegen(cg);
    if (isArray) {
        for (auto& sizeExpr : sizeExprs)
            type = cg->GetArrayType(type, sizeExpr->ToInteger(cg));   /* 内层维度: [3 x i32] */
        type = cg->GetPointerType(type);                              /* 最外层: ptr */
    }
    return type;
}
```

对 `int a[][3]`：从内层往外建 `[3 x i32]`，最后包一层 ptr 得到 `ptr`（指向 `[3 x i32]`）。对 `int a[]`：sizeExprs 为空，直接 `ptr`（指向 `i32`）。**LLVM 17+ opaque pointer 之后 ptr 类型不带 pointee 信息，但 GEP 需要 pointee 类型**——这是 [#22 §4](https://github.com/leafvmaple/blog/issues/22) 那套 `Symbol.pointerParam` 标位 + `Symbol.type` 记录 pointee element type 的根本动因。

完整链路：

1. **bison** 看到 `int a[]` 形参 → 用 `isArray=true` 构造 `FuncFParamAST`
2. **`FuncFParamAST::ToType`** → 把形参类型生成为 `ptr`（不是 `[N x i32]`）
3. **`FuncFParamAST::Alloca`** → 在函数 entry block 分配一个槽存这个 ptr，[`AddSymbol`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L664) 时标 `pointerParam = true`、`type` 字段填**元素类型**
4. **`LValAST::ToPointer`** → 看 `pointerParam` 走"无 leading zero"的 GEP 形状（详见 [#22 §4](https://github.com/leafvmaple/blog/issues/22)）

一个 `bool isArray` 标位贯穿这整条链路。**信息从 bison 文法的"哪条规约"开始携带，到 GEP 形状的选择结束**。没有这个标位，要么文法层多出冗余规则（"如果是数组参数则单独走一条 GEP 规则"），要么 codegen 层要回去问"这个变量的 source 在哪里"——前一种引入语法噪音、后一种把 IR 后端污染回 AST 层。这条单 bool 是真正的最小接缝。

---

## 6. 15 个回归测试 + XFAIL 基础设施：一个诚实的兜底

[`test/cases/`](https://github.com/leafvmaple/zcc/tree/main/test/cases) 目前有 15 个 `.c` + 15 个 `.expected`，由 [`run_tests.sh`](https://github.com/leafvmaple/zcc/blob/main/test/run_tests.sh) 驱动，[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f)（2026-05-22）加。覆盖范围按场景：

| 文件 | 覆盖 |
|---|---|
| `arith.c` | 标量算术：`+ - * / %`、单目 `- !`、运算符优先级 |
| `control.c` | `if-else`、`while` |
| `forloop.c` | for 三种初始化（`int i;`、`int k=1`、空）、break、`for (;;)` 无穷循环 |
| `recursion.c` | `fact(n)` 递归 |
| `shortcircuit.c` | `&&` 短路、`||` 短路（带可观察 side-effect 的 `side()` 验证不被求值） |
| `globals.c` / `globalarray.c` | 全局标量 + 全局数组 |
| `array1d.c` / `array1d_init.c` | 一维数组：声明 + initializer + 索引 |
| `array2d.c` | 多维数组 + 索引 |
| `arrayparam.c` | 数组退化为指针的函数参数（§5 的 GEP 形状） |
| `charscalar.c` / `chararray.c` / `charfunc.c` / `chartrunc.c` | char 标量 / 数组 / 函数返回 / i32→i8 截断（[#22 §3](https://github.com/leafvmaple/blog/issues/22) 那个 `6f1e4fe` 修复对应的覆盖） |

运行机制走一条"作弊"路径：zcc 出 LLVM IR → **host clang 把它链宿主 libc 跑起来** → 把 stdout 跟 `.expected` diff。这种测法**只验证前端 + LLVM IR 的语义和真 C 一致**，不验证 `-x64`/`-riscv64` 跑在 Zonix 上的真实行为——那部分由 Zonix 那边 [`551394f`](https://github.com/leafvmaple/zonix-plus/commit/551394f) 的 exec 集成测试覆盖。两边测试加起来才是闭环的完整覆盖。

这种 oracle 模型的优点是**diff 失败时定位极快**：如果 zcc 生成的 IR 让 clang+libc 跑出和 expected 不一样的 stdout，要么 zcc 生成的 IR 是无效的（clang 链接失败），要么生成的 IR 语义和真 C 不一致（运行输出不对）。两种情况 host 工具链都比 Zonix qemu 启动循环快几十倍。

`run_tests.sh` 里还有一个目前没用上的细节——**XFAIL 基础设施**：

```bash
if head -n 1 "$src" | grep -q "XFAIL"; then
    is_xfail=1
fi
# ...
if [ $ok -eq 1 ] && [ "$got" = "$want" ]; then
    if [ $is_xfail -eq 1 ]; then
        echo "XPASS $name (now passes - remove the XFAIL marker)"
        ...
```

测试在源码第一行写 `// XFAIL: reason` 就允许它失败、只有当它**意外通过**时才报 XPASS 提示去掉标记。**目前没有任何一个测试是 XFAIL**——15 个全过。这套基础设施是为"未来添加新特性时先写一个失败用例、做 commit 把它转 PASS"准备的，是 [LLVM lit 测试框架](https://llvm.org/docs/CommandGuide/lit.html) 的同款 idiom。

**为现在用不上的特性建基础设施**通常是反 pattern——但这里成本极低（10 行 shell），收益是下一个想加特性的人不用重写测试运行器。比 codegen 那个 `#if 0` 的 `Optimize()`（[#22 §6](https://github.com/leafvmaple/blog/issues/22)）少一个数量级的代价、同样有意识的"留口子"。

---

## 7. 迭代记录

<!-- 后续前端 / 文法 / lex / 测试 演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-05-23：本子篇首次落地。在 §3 拆"`char` 字面量在 lex 阶段同化"的设计、§5 拆"`isArray` 单 bool 贯穿"的接缝、§6 公开承认 XFAIL 基础设施目前空跑、是有意识的留口子。
- 2026-05-22：[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f) 加 15 个 `test/cases/*.c` + 配套 `.expected` + `run_tests.sh`（含 XFAIL 支持）。从这天起 zcc 有了一套**和宿主 clang 做 oracle 对比**的回归覆盖。
- 2026-05-22：[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe) 把 `char` 从"按 i32 处理"改成真正的 i8（见 [#22 §3](https://github.com/leafvmaple/blog/issues/22)）。配合同 commit 加的 `chartrunc.c` / `charscalar.c` / `chararray.c` 测试用例验证 sign-extend / truncate 全链路。
- 2026-03-12：[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) 把 SysY 扩为 C0：加 char / 字符 + 字符串字面量 / for-loop / printf / scanf。这是前端从"教学语言"变成"能编 Zonix 用户程序"的分水岭。同 commit 一起修了 LLVM 18 opaque pointer 时代的 3 个 bug（`CreateCondBr` 的 i1 类型、`CreateLoad` 的硬编码 i32、`GetElementType` 在 opaque pointer 下崩）。

---

*仓库：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)。本文属于 [zcc 系列](https://github.com/leafvmaple/blog/issues/20)。*
