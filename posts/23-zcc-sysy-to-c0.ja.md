# SysY から C0 へ：教育用文法の上に `printf("Hello\n")` を編める最小フロントエンドを育てる

> リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)
> シリーズ：[zcc メインインデックス #20](https://github.com/leafvmaple/blog/issues/20) のフロントエンド深掘り
> 対象サブシステム：`parser/{sysy.l,sysy.y}` / `src/ast/ast.{h,cpp}` / `src/scanner/scanner.cpp` / `test/cases/` 回帰テスト / `test/run_tests.sh`

zcc のフロントエンドは PKU コンパイラ実習の SysY 言語から出発（[`361081b`](https://github.com/leafvmaple/zcc/commit/361081b)、2024-07）：int スカラ、一次元配列、関数、`if-else`、`while`、**char も for も文字列リテラルも printf も無し**。Zonix ユーザープログラム `printf("Hello\n")` を編めるようにするには、フロントエンドを**「ちょうど実用 C サブセットを書ける」**形まで拡張せねばならない。

これは一つの commit でなされる：[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4)（2026-03-12、"extend SysY to C0 language with char, for-loop, printf/scanf"） —— 88 行の bison + 52 行の flex を追加、AST に 17 行の宣言 + 6 行の実装を追加。言語全体が SysY から**C の極小サブセット（ここでは C0 と呼ぶ）** へ昇格、その対価が ~200 行の拡張。

この一篇では「ちょうど使えるまで拡張」の中で**必ず正しくせねばならぬ** 4 つを解きほぐす：dangling-else の LALR 二分文法、char リテラルが lex 段階で整数に同化される様、`printf`/`scanf` を vararg builtin として文法構文を占めない仕方、配列引数 decay の LALR 文法でのフラグ戦略。末尾に 15 の回帰テスト + XFAIL インフラの誠実な振り返り。

---

## 1. C0 の最小利用可能な追加

[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) この一 commit が SysY の上に加えたもの：

| 追加 | 加え方 |
|---|---|
| `char` 型 | `BasicType` 文法に `CHAR { ... }` 1 行追加；AST の `BaseType::TYPE` に `CHAR` を加える；初版は内部的に i32 として扱う（[#22 §3](https://github.com/leafvmaple/blog/issues/22) で後に真の i8 へ修正） |
| 文字リテラル `'a'` | flex に `CharLiteral [^\\']\|\\[nrt...]` パターン + エスケープ処理を追加、**`INT_CONST` を吐く**（下の §3 で詳述） |
| 文字列リテラル `"hi"` | flex に `StringLiteral \"([^\\"]\|\\.)*\"` パターン + エスケープ処理；AST の `PrimaryExprAST::TYPE` に `String` 分岐を追加、codegen は `CreateGlobalStringPtr` 経由 |
| `for (init; cond; step) stmt` | bison に `ForInitClause` / `ForStepClause` 二つの補助文法 + `MatchedStmt`/`UnmatchedStmt` に各 1 規則追加；`StmtAST::TYPE::For` の codegen は 4-BB テンプレート（cond/body/step/end） |
| `printf` / `scanf` 呼び出し | **専用構文無し** —— 普通の `IDENT '(' FuncRParams ')'` として、`CompUnitAST::Codegen` が起動時に `CreateBuiltin` で関数宣言を注入（下の §4） |

**加えなかった**もの —— `struct` / `typedef` / `union` / `switch` / `goto` / `float` / pointer 型 / preprocessor / 多ファイルリンク —— の理由は [#20 §3](https://github.com/leafvmaple/blog/issues/20) のあのテーブルに、簡単に言えば「Zonix で `printf("Hello\n")` を走らせる」に対するゼロ寄与だから。

この commit は同期に LLVM 18 + opaque pointer 時代の 3 バグも修正（commit message に明記）：`CreateCondBr` が以前 `br i32` を吐いていた（`br i1` ではなく）、`CreateLoad` が `i32` 型をハードコード、`GetElementType` が opaque pointer 下でクラッシュ。これらは同期した LLVM 升级 がもたらした連鎖問題、C0 自体の設計ではない —— だが commit が一緒に修した。

---

## 2. dangling-else：LALR 文法の二分技

C の `if-else` に古典的曖昧性：

```c
if (a)
    if (b)
        x = 1;
    else        ← この else はどの if に対応？
        y = 2;
```

文法が直接 `Stmt -> IF '(' Expr ')' Stmt | IF '(' Expr ')' Stmt ELSE Stmt` と書くと、LALR(1) が `else` を見た瞬間に reduce（外側 if に else を渡す）か shift（内側 if に else を渡す）か分からず —— bison が shift/reduce 衝突を報告、デフォルトで「shift 優先」で else を最も近い if に対応（C 意味論はちょうどこれだが、「デフォルト挙動」で正しさを揃えただけで、構造的に正しいわけではない）。

zcc の解法は古典的 [Aho/Sethi ドラゴンブック 4.3.2](https://en.wikipedia.org/wiki/Dangling_else) の二分文法：

```yacc
Stmt
    : MatchedStmt
    | UnmatchedStmt
    ;

MatchedStmt   /* 全ての if に対応する else がある */
    : IF '(' Expr ')' MatchedStmt ELSE MatchedStmt    /* if-else 内外とも対応済み */
    | /* 他の stmt: 代入 / Block / RETURN / WHILE / FOR / BREAK / CONTINUE */
    ;

UnmatchedStmt  /* 「裸の if」または「内側 if が else を待っている」を含む */
    : IF '(' Expr ')' Stmt                             /* 裸の if、else 無し */
    | IF '(' Expr ')' MatchedStmt ELSE UnmatchedStmt   /* 外側 if-else、内側 else 分岐が unmatched を含む */
    | WHILE '(' Expr ')' UnmatchedStmt
    | FOR ( ... ) UnmatchedStmt
    ;
```

効果は**デフォルト挙動でなく文法定義で**、else が最も近い if と対応するよう強制する：`MatchedStmt` 分岐に行けるなら then-stmt は `MatchedStmt` でなければならない —— つまり then-stmt 内の全 if がそれぞれ else を対応済み。任意の「裸の if」は `UnmatchedStmt` 分岐へしか入れない。こうして `if (a) if (b) x=1; else y=2;` の解析では：

- 内側 `if (b) x=1; else y=2;` は `MatchedStmt`
- 外側 `if (a) <MatchedStmt>` は `UnmatchedStmt` の「裸の if」分岐
- else は自然に内側へ対応 ✓

そして `for` と `while` も [`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) で一緒にこの二分体系に接続 —— `FOR ( ... ) MatchedStmt` は `MatchedStmt` へ、`FOR ( ... ) UnmatchedStmt` は `UnmatchedStmt` へ。さもないと `if (a) for (;;) if (b) x=1; else y=2;` のようなネストで再び shift/reduce 衝突が出る。

この文法の利点は曖昧性解消だけではない —— **bison の報告に衝突が永遠に出ない**。将来 stmt を取る新キーワード（例えば `unless`、`do-while`）を追加するなら、このパターンで 2 規則加える（match と unmatched 各 1）だけで、新たな shift/reduce を引き起こさない。**構造的正しさは「shift 優先がたまたま当たる」より安定**。

---

## 3. `char` リテラルは lex 段階で整数に同化される

[`sysy.l`](https://github.com/leafvmaple/zcc/blob/main/parser/sysy.l) の文字リテラル規則：

```
CharLiteral   '([^\\']|\\[nrt\\\'\"0abfv])'

{CharLiteral}     {
    int val = (yytext[1] == '\\') ? parse_char_escape(yytext[2])
                                  : static_cast<unsigned char>(yytext[1]);
    return yy::Parser::make_INT_CONST(val, loc);   /* ← 注意：INT_CONST を吐く */
}
```

`'a'` は lex 段階で直接 `INT_CONST(97)` として解析される —— bison 側は**「`'a'` と `97` が違う」ことを知らない**。char リテラルを整数に同化するこの手法は C 標準自体が許す（C 標準では `'a'` の型は `int`、`char` ではない）、lex がここで等価変換した。

効果は**フロントエンドのトークン種別が一つ減り、reduce 規則の一群が消える**：

| もし同化しなければ | 実際のやり方 |
|---|---|
| flex に `CHAR_CONST` トークン種別を追加；bison が `Number` / `PrimaryExpr` に reduce 1 行追加（"`CHAR_CONST` も Number"）；AST に `CharLiteralAST` を加えるか `NumberAST` に `isChar` フラグを加える | `CHAR_CONST` トークンが存在しない；bison は一字も動かない；AST `NumberAST` も一字も動かない |

`char` 型自体（宣言、引数、変数、配列）は bison の `BasicType: CHAR` 経由で文法へ + `BaseType::TYPE::CHAR` で AST へ進む —— **「char 型の存在性」と「char リテラルの存在性」は別概念**。zcc が前者を文法に入れ、後者を全部 lex で処理する選択は：

- 「char 変数を宣言」は後続式の型に影響する、**AST に構造が必要**
- リテラル `'a'` とリテラル `97` は式文脈で**完全に交換可能**、AST に差異を残す必要が無い

この原則は § 4 で再度使う：文字列リテラルも lex 段階で `STR_CONST` トークン（エスケープ処理済みの文字列内容を持つ）を吐く、bison では `PrimaryExpr` に `STR_CONST { $$ = make_unique<PrimaryExprAST>($1); }` 1 行追加、AST 側で `PrimaryExprAST::TYPE` に `String` 分岐追加。**lex がリテラル自身の計算を、bison がそれがどこに現れ得るかを、AST がそれがどの IR を生成するかを、三層が各々の仕事をする**。

---

## 4. `printf` / `scanf`：vararg builtin として、文法に入らない

これら二つは C0 でユーザー体感が最も強い機能（「`printf("Hello\n")` が書ける」がこの拡張の意義全体）、だが**文法には存在しない** —— `PRINTF`/`SCANF` トークン無し、専用 reduce 規則無し。

実装は `CompUnitAST::Codegen` の中（[`ast.cpp:241-250`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L241-L250)）：

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

`CreateBuiltin` がこれら二つを**外部宣言の vararg 関数**としてシンボルテーブルに注入する：戻り i32、第一引数は `i8*`（C 文字列）、`isVarArg = true`（以降の引数は任意型任意個数）。ユーザー視点では普通の関数と同じ：`printf("%d\n", n)` は `UnaryExprAST::TYPE::Call` 経路を通り、`GetSymbol("printf")` で builtin ヒット、`CreateCall` が `call i32 @printf(...)` を生成。

では `@printf` の真の実装はどこに？答えは zcc が出力する `.ll` ファイルは `@printf` を**宣言するだけで定義しない**。後段の `clang -c` + `ld` リンク時に：

- **`-llvm` モード**：テスト用、host libc の printf にリンク（[`test/run_tests.sh`](https://github.com/leafvmaple/zcc/blob/main/test/run_tests.sh) は host clang で走り、host libc の printf が oracle）
- **`-x64` / `-riscv64` モード**：zcc 自身の `libzccrt.a` にリンク、中に [`printf.c`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/printf.c)（`sys_write` 経由で fd=1 直書き、詳細は [#21 §1](https://github.com/leafvmaple/blog/issues/21)）

この分離の利点：**フロントエンドは printf がどの OS で走るかを知らずに済む**。同じ LLVM IR がテスト時に host libc にリンクして意味論検証、本番時に zcc-runtime にリンクして Zonix 上で走る —— リンカが最後の一歩で backend を選ぶ。**フロントエンド複雑度は「私は vararg call しか話せない」という最小契約に閉じ込められる**。

> `%d` / `%c` のような format specifier について：**zcc は完全に解析しない**。`printf("%d\n", n)` は zcc 側ではただの `@printf` への vararg call で 2 引数渡し、`"%d\n"` は普通の文字列リテラル。`%d` の意味論は libc / libzccrt 側で実装。これが vararg builtin この経路の最大の配当 —— フロントエンドはこの言語にどんな format specifier があるか知らない振りができる。

> 歴史脚注：commit message に "with %d and %c format specifiers decomposed into putint/putch/getint/getch runtime calls" —— これは [`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) 初版のやり方（フロントエンドが `printf("%d", n)` を `putint(n)` に分解）、後の freestanding runtime 落地時（[`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5)）に「フロントエンドは分解せず、runtime が完全な printf を実装」へ変更 —— これが綺麗な継ぎ目の引き方。

---

## 5. 配列引数 decay：単一 bool フラグでフロントエンドから codegen まで貫く

C で関数宣言 `int sum(int a[], int n)` は**型上の嘘** —— `int a[]` は実際は `int*`、「配列がポインタに退化」は関数境界の特別規則。zcc は [`sysy.y`](https://github.com/leafvmaple/zcc/blob/main/parser/sysy.y) でこれを独立した文法規則として識別：

```yacc
FuncFParam
    : BasicType IDENT '[' ']' ArrayDims {  /* int a[][3]: 退化ポインタ + 後続次元は配列のまま */
        $$ = std::make_unique<FuncFParamAST>(std::move($1), $2, std::move($5));
      }
    | BasicType IDENT '[' ']' {            /* int a[]: 純粋一次元退化 */
        $$ = std::make_unique<FuncFParamAST>(std::move($1), $2, true);
      }
    | BasicType IDENT {                    /* int a: スカラ */
        $$ = std::make_unique<FuncFParamAST>(std::move($1), $2);
      }
    ;
```

中央の `IDENT '[' ']'` に注目：`FuncFParamAST` を構築する時に `true` を 1 個追加で渡す —— これが `isArray` フラグ。`FuncFParamAST::ToType` が codegen 時にこのフラグを見て LLVM 型を決める：

```cpp
llvm::Type* FuncFParamAST::ToType(CodeGen* cg) {
    llvm::Type* type = btype->Codegen(cg);
    if (isArray) {
        for (auto& sizeExpr : sizeExprs)
            type = cg->GetArrayType(type, sizeExpr->ToInteger(cg));   /* 内層次元: [3 x i32] */
        type = cg->GetPointerType(type);                              /* 最外: ptr */
    }
    return type;
}
```

`int a[][3]` に対し：内側から `[3 x i32]` を作り、最後に ptr で包んで `ptr`（`[3 x i32]` を指す）。`int a[]` に対し：sizeExprs が空、直接 `ptr`（`i32` を指す）。**LLVM 17+ opaque pointer 後 ptr 型は pointee 情報を持たない、だが GEP は pointee 型を必要とする** —— これが [#22 §4](https://github.com/leafvmaple/blog/issues/22) の `Symbol.pointerParam` フラグ + `Symbol.type` で pointee element type を記録する根本動機。

完全経路：

1. **bison** が `int a[]` 仮引数を見て → `isArray=true` で `FuncFParamAST` を構築
2. **`FuncFParamAST::ToType`** → 仮引数型を `ptr`（`[N x i32]` ではなく）として生成
3. **`FuncFParamAST::Alloca`** → 関数 entry block にこの ptr を保存するスロットを割り当て、[`AddSymbol`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L664) 時に `pointerParam = true` をタグ付け、`type` フィールドには**要素型**を入れる
4. **`LValAST::ToPointer`** → `pointerParam` を見て「leading zero 無し」の GEP 形へ（詳細は [#22 §4](https://github.com/leafvmaple/blog/issues/22)）

1 つの `bool isArray` フラグが全鎖を貫く。**情報は bison 文法の「どの reduce か」から始まって運ばれ、GEP 形の選択で終わる**。このフラグが無ければ、文法層に冗長規則（「配列引数なら専用 GEP 規則を通る」）が増えるか、codegen 層が「この変数の source はどこ？」と聞き直す必要がある —— 前者は構文ノイズを持ち込み、後者は IR 後段を AST 層へ汚染する。この単 bool は真の最小継ぎ目。

---

## 6. 15 の回帰テスト + XFAIL インフラ：誠実な底支え

[`test/cases/`](https://github.com/leafvmaple/zcc/tree/main/test/cases) は現在 15 個の `.c` + 15 個の `.expected`、[`run_tests.sh`](https://github.com/leafvmaple/zcc/blob/main/test/run_tests.sh) で駆動、[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f)（2026-05-22）で追加。シナリオ別のカバー範囲：

| ファイル | カバー |
|---|---|
| `arith.c` | スカラ算術：`+ - * / %`、単項 `- !`、演算子優先順位 |
| `control.c` | `if-else`、`while` |
| `forloop.c` | for の 3 つの初期化（`int i;`、`int k=1`、空）、break、`for (;;)` 無限ループ |
| `recursion.c` | `fact(n)` 再帰 |
| `shortcircuit.c` | `&&` 短絡、`||` 短絡（観測可能な side-effect 付き `side()` で未評価を検証） |
| `globals.c` / `globalarray.c` | グローバルスカラ + グローバル配列 |
| `array1d.c` / `array1d_init.c` | 一次元配列：宣言 + initializer + インデックス |
| `array2d.c` | 多次元配列 + インデックス |
| `arrayparam.c` | 配列がポインタへ退化する関数引数（§5 の GEP 形） |
| `charscalar.c` / `chararray.c` / `charfunc.c` / `chartrunc.c` | char スカラ / 配列 / 関数戻り / i32→i8 切り詰め（[#22 §3](https://github.com/leafvmaple/blog/issues/22) の `6f1e4fe` 修正に対応するカバー） |

実行機構は「ズル」した経路：zcc が LLVM IR を吐く → **host clang がそれを host libc にリンクして走らせ** → stdout を `.expected` と diff。この測り方は**フロントエンド + LLVM IR の意味論が真の C と一致するかだけを検証**、`-x64`/`-riscv64` を Zonix 上で走らせた実行動を検証してはいない —— それは Zonix 側の [`551394f`](https://github.com/leafvmaple/zonix-plus/commit/551394f) の exec 統合テストでカバー。両者を足してこそ閉環の完全被覆。

この oracle モデルの利点は**diff 失敗時の特定が極速**：zcc が生成した IR が clang+libc で expected と違う stdout を出すなら、zcc 生成 IR が無効（clang リンク失敗）か、生成 IR の意味論が真の C と不一致（実行出力が間違い）。どちらの場合も host 工具は Zonix qemu 起動ループより数十倍速い。

`run_tests.sh` にもう一つ現状未使用の細部 —— **XFAIL インフラ**：

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

テストがソースの最初の行に `// XFAIL: reason` と書けば失敗を許可、**意外に通った**時だけ XPASS でマーカー削除のヒントを出す。**現状で XFAIL のテストは無い** —— 15 個全部通る。このインフラは「将来新機能を加える時、先に失敗ケースを書いて、それを PASS にする commit を作る」ためのもの、[LLVM lit テストフレームワーク](https://llvm.org/docs/CommandGuide/lit.html) の同じ idiom。

**今使わない機能のためのインフラ**はふつう anti-pattern —— だがここはコスト極小（10 行 shell）、収穫は次に機能を加える人がテストランナーを書き直さなくて済むこと。codegen のあの `#if 0` の `Optimize()`（[#22 §6](https://github.com/leafvmaple/blog/issues/22)）より一桁少ない代償、同じく意識的な「口を開けておく」。

---

## 7. イテレーション履歴

<!-- 後のフロントエンド / 文法 / lex / テストの進展はここに追加、時間逆順。各行に commit リンク + 一二文の説明。 -->

- 2026-05-23：本記事初出。§3 で「`char` リテラルが lex 段階で同化」の設計、§5 で「`isArray` 単一 bool が貫く」継ぎ目、§6 で XFAIL インフラが現状空回りであること・意識的な「口開け」であることを公開。
- 2026-05-22：[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f) で 15 の `test/cases/*.c` + 配套 `.expected` + `run_tests.sh`（XFAIL サポート込み）を追加。この日から zcc は**ホスト clang を oracle にした**回帰カバーを持つ。
- 2026-05-22：[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe) で `char` を「i32 として扱う」から真の i8 へ修正（[#22 §3](https://github.com/leafvmaple/blog/issues/22) 参照）。同 commit で追加された `chartrunc.c` / `charscalar.c` / `chararray.c` テストケースで sign-extend / truncate 全経路を検証。
- 2026-03-12：[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) で SysY を C0 に拡張：char / 文字 + 文字列リテラル / for-loop / printf / scanf を追加。フロントエンドが「教育言語」から「Zonix ユーザープログラムを編める」へ変わる分水嶺。同 commit で LLVM 18 opaque pointer 時代の 3 バグ（`CreateCondBr` の i1 型、`CreateLoad` の i32 ハードコード、opaque pointer 下で崩れる `GetElementType`）も一緒に修した。

---

*リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)。本記事は [zcc シリーズ](https://github.com/leafvmaple/blog/issues/20) の一篇。*
