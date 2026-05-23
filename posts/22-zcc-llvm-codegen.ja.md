# IR バックエンドを 1 つ削った日に正味 -1,414 行：zcc の LLVM codegen はどう薄層になったか

> リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)
> シリーズ：[zcc メインインデックス #20](https://github.com/leafvmaple/blog/issues/20) の後段深掘り
> 対象サブシステム：`src/ir/codegen.{h,cpp}` / `src/ast/ast.cpp` の `Codegen()` メソッド / 初期に削除された `src/ir/{ir.h,koopa_ir.*,llvm_ir.*}` と `src/ast/ast.tpp`

zcc の後段設計を理解するための一つの commit を選ぶなら、[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea)（2026-03-12、"remove Koopa backend and template-based IR adapter layer"）。これは**2,552 行削除、1,138 行追加、正味 -1,414**。削除されたもの：

- `Env<Type, Value, BasicBlock, Function>` テンプレートアダプタ層丸ごと（`src/ir/ir.h`、167 行）
- Koopa IR バックエンド（`koopa_ir.{h,cpp}`、846 行）
- LLVM IR バックエンドの初期実装（`llvm_ir.{h,cpp}`、431 行）
- テンプレート化された AST codegen（`src/ast/ast.tpp`、782 行）

追加されたもの：単一の `CodeGen` クラス（`src/ir/codegen.{h,cpp}`、初版 410 行、現在 497 行）+ AST codegen をテンプレから通常メンバ関数へ戻す（`ast.cpp` が 720 行増）。**commit message の鍵は "preserving identical LLVM IR output for all existing test cases"** —— これが削除の正当性証明：等価類は変わらず、1,414 行少なくなった。

この篇では、この「減算リファクタ」の背後にあるいくつかを解きほぐす：薄層はどれだけ薄くあるべきか、IRBuilder の上にラッパが要るか、char-i8 / 式-i32 の切り詰め/拡張規律、opaque pointer 後の GEP の二つの形、短絡 `&&`/`||` がなぜ制御フローを通り boolean 算術を通らないか。

---

## 1. Koopa バックエンドを削るということそのもの

zcc の初目標は PKU コンパイラ実習の SysY → Koopa IR（[`1cae145`](https://github.com/leafvmaple/zcc/commit/1cae145) で Koopa バックエンド追加）。その後、教育需要で Koopa を、真の編集パイプライン接続のために LLVM バックエンドも（[`3b0780b`](https://github.com/leafvmaple/zcc/commit/3b0780b)）、結果両 IR を並行維持。アーキテクチャ上の解は IR アダプタテンプレートを導入：

```cpp
// 削除済みの src/ir/ir.h（リファクタ前の姿）
template<typename Type, typename Value, typename BasicBlock, typename Function>
class Env {
public:
    virtual Value* CreateAdd(Value* lhs, Value* rhs) = 0;
    virtual Value* CreateLoad(Value* src) = 0;
    // ...
};

// AST ノードの codegen はテンプレ経由、理論上両バックエンドで走る
template<typename E>
llvm::Value* BinaryExprAST::ToValue(E* env) { /* ... */ }
```

代償は `ast.tpp` の 782 行のテンプレートコード + 明示的テンプレート実体化、二つの `koopa_ir.cpp` / `llvm_ir.cpp` が同じ「加減乗除 ⇒ IR」ロジックを各々書く —— ただ底層 SDK が違うだけ。

**本当の問題**は Koopa バックエンドが ELF を吐けないこと。Koopa は教育用 IR、出力する `.koopa` は PKU の `koopac` 工具を通す必要があるが、「Koopa → 真の機械コード」の道は既製で無い。[#20](https://github.com/leafvmaple/blog/issues/20) の目標が「Zonix で走らせる ELF を吐く」に変わった瞬間、Koopa のこの道は**永遠に終点に届かない** —— その上に投じた維持コストは沈没コスト。

[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) の削除方法：

1. `ast.tpp` の全テンプレート `Codegen<E>` メソッドを `ast.cpp` の通常メンバ関数へ戻し、具体の `CodeGen* cg` を直接呼ぶ
2. 元の `llvm_ir.{h,cpp}` をより直接的な `codegen.{h,cpp}` に書き直す（部分は残すが簡略化、下の §2）
3. `ir.h`（テンプレ基底）、`koopa_ir.{h,cpp}`、`llvm_ir.{h,cpp}` 旧版、`ast.tpp` の計 5 ファイル 1,945 行を削除
4. 検証：既存の全 `test/cases/*.c` が吐く LLVM IR がリファクタ前と**バイト単位で同一** —— これが commit message の "preserving identical LLVM IR output" の物証

> このリファクタが成立する前提は「差し替え可能な継ぎ目を先に持ち、差し替えるかを後で決める」。AST が初めから LLVM IRBuilder を直接呼んでいたら、Koopa 削除という事象は起こらない、なぜなら二つのバックエンドを持ったことが無いから。**多バックエンドを持ったことの価値は「将来また切り替えられる」ではなく、「今、それが保つに値しないと確信できる」** —— 抽象を持って初めて抽象の代償が見える。

削除後、`src/ast/` は LLVM の型に一字も依存しない、`ast/type.cpp` で `BaseType::TYPE::INT` を `llvm::Type::getInt32Ty()` にマップする 1 箇所の境界だけ。これで AST は `CodeGen*` を介して間接的に LLVM に触れる —— 薄層の存在が「AST は LLVM ヘッダを直接 include しない」をテンプレの代償なしに成立させる。

---

## 2. codegen.h 薄層はどれだけ薄いか

[`src/ir/codegen.h`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.h) は 138 行宣言、`codegen.cpp` は 359 行実装。メソッドをカテゴリ別に：

| カテゴリ | メソッド数 | 性質 |
|---|---|---|
| 型構築（`GetInt32Type` / `GetArrayType` / ...） | 11 | ほぼ全部 `IRBuilder` の一行転送 |
| 関数 / 基本ブロック / 呼び出し | 6 | 同上 |
| メモリ（`CreateAlloca` / `CreateLoad` / `CreateStore` / `CreateGEP`） | 9 | 大半は転送、少数は char 切り詰めロジックを内包 |
| 定数 | 5 | 転送 + `MakeArrayConstant` 多次元集約 |
| 算術 / 比較 | 13 | 全部転送 |
| 制御フロー | 6 | 全部転送 |
| 型変換（`ConvertInt`） | 3 | 本当に価値のあるラッパ（下の §3） |
| スコープ / while 追跡 | 7 | 自前で持つ `vector<map<string, Symbol>>` と `vector<WhileData>` |

合わせて ~70 個の public メソッド（オーバーロード込み ~140）、そのうち**本当に `IRBuilder` より多くを成すのは 10 個未満**：

```cpp
// codegen.h で本当に「何かを内包する」メソッド群
llvm::Type*  MakeArrayType(llvm::Type* elem, const std::vector<int>& dims);  // 多次元配列型を一発構築
llvm::Type*  PeelArray(llvm::Type* type, int levels);                        // 層数で剥がす
void         StoreScalar(llvm::Value* value, llvm::Value* dest, llvm::Type* elemType);  // 自動切り詰め i32→i8
llvm::Value* CreateLoadInt(llvm::Value* ptr, llvm::Type* elemType);          // 自動拡張 i8→i32
llvm::Value* ConvertInt(llvm::Value* value, llvm::Type* dst);                // 整数間の切り詰め/拡張
llvm::Constant* MakeArrayConstant(llvm::Type* elemType, const std::vector<int>& dims,
                                  const std::vector<llvm::Value*>& flatValues);  // row-major 多次元集約定数
void         EnterScope() / ExitScope() / AddSymbol() / GetSymbol();          // スコープ + シンボルテーブル
void         EnterWhile() / ExitWhile() / GetWhileEntry() / GetWhileEnd();    // break/continue のジャンプ先
```

この 10 個は**IRBuilder の転送ではない** —— 「言語層の概念」を「IR 層の動作」に翻訳する真の接点。残り 60 は AST が `CodeGen*` を介してのみ LLVM に触れさせるため、`<llvm/IR/IRBuilder.h>` を直接 include させないため。

この比率は**合理的**：薄く、主に「間接性」を担う転送が大半；本当に言語層抽象を加えるもの（多次元配列型、char 切り詰め/拡張、シンボルテーブル、ループジャンプスタック）を独立に列挙、それぞれが AST で繰り返し使われるパターンに対応。**「工程的に見える」ために汎用 helper を薄層に詰め込まない** —— `PeelArray` のように LValAST 一箇所でしか使わない、だがそこで本当に 2-3 行書く必要のある補助ロジックは、薄層に入って十分；「半年後にもう一人ユーザーが出る」という幻覚は持たない。

---

## 3. char-i8、式-i32：切り詰め/拡張の規律 (`6f1e4fe`)

zcc 初期は `char` も `i32` として処理 —— `char arr[3] = {1, 2, 3}` がメモリ上 12 バイト占有、`arr[1]` のアドレス計算で GEP ストライド 4。問題は [`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe)（2026-05-22、"make char an 8-bit type and correct array addressing"）でやっと全面修正。

LLVM IR では `char` は `i8`、`int` は `i32`、だが**全ての式中間値は i32 で統一** —— これが LLVM の「社会的ルール」、理由：

1. C 意味論はもとから「`char c = 'a' + 1`」のような暗黙昇格を許す
2. 算術命令は i8 で走るが定数の即値は自動的に i32 に拡張される、混ぜると醜い
3. 比較 / 短絡論理はすべて「i32 を 0 と比べる」で真偽を表す、i32 で統一が一番楽

これは**任意の i8 格納境界で切り詰め/拡張する**ことを要求する：

- **store i32 → i8**：`char` 変数 / 配列要素に書く時、式の i32 を i8 に切り詰め
- **load i8 → i32**：`char` 変数 / 配列要素を読む時、sign-extend で i32 に戻す
- **call 時**：i32 実引数が `char` 宣言の仮引数に渡る時に i8 に切り詰め；`char` 宣言の戻り値は呼び出し点で i32 に拡張
- **return 時**：`char` を返す関数、return の値を先に切り詰め

この 5 種類の境界はすべて `codegen.h` の 3 メソッドで統一処理：

```cpp
// codegen.cpp:166-181
void CodeGen::StoreScalar(llvm::Value* value, llvm::Value* dest, llvm::Type* elemType) {
    Builder.CreateStore(ConvertInt(value, elemType), dest);   // 書く前に ConvertInt で対象に切り詰め/拡張
}

llvm::Value* CodeGen::CreateLoadInt(llvm::Value* ptr, llvm::Type* elemType) {
    llvm::Value* v = Builder.CreateLoad(elemType, ptr);
    return ConvertInt(v, GetInt32Type());                     // 読出後ただちに i32 に拡張
}

llvm::Value* CodeGen::ConvertInt(llvm::Value* value, llvm::Type* dst) {
    llvm::Type* src = value->getType();
    if (src == dst || !src->isIntegerTy() || !dst->isIntegerTy())
        return value;
    unsigned sb = src->getIntegerBitWidth(), db = dst->getIntegerBitWidth();
    if (sb < db) return Builder.CreateSExt(value, dst);       // 狭 → 広：sign-extend
    if (sb > db) return Builder.CreateTrunc(value, dst);      // 広 → 狭：truncate
    return value;
}
```

呼出点は AST に散る：`StmtAST::TYPE::Assign` は `StoreScalar` 経由、`StmtAST::TYPE::Ret` は `ConvertInt(retval, getReturnType())`、`UnaryExprAST::Call` が関数戻り値を i32 に拡張、`CreateCall` が各実引数を渡す前に `ConvertInt(args[i], ft->getParamType(i))`。**規律の強度は「全境界が helper を通る強制」で保証**、AST ノードがこの層を超えて直接 store/load を書くことは許されない —— こうして i8/i32 のずれは「一箇所忘れた」で残らない。

**なぜ sign-extend で zero-extend ではないか？** SysY/C0 の `char` は符号付き扱い（C と同じ）。`char c = -1; int i = c;` は `i == -1` であるべきで `255` ではない。この一点は `ConvertInt` が `CreateZExt` ではなく `CreateSExt` を使う、その一行に隠れる —— **ConvertInt 単一点で決まる意味論選択**。いつか `unsigned char` を支えたくなったら、この関数一つを変えれば足りる（実際は `BaseType` に unsigned フラグを加え、`ConvertInt` の引数に signedness ヒントを加える必要も）。

---

## 4. opaque pointer 時代の GEP：二つの形

LLVM 15 以降は全てのポインタが `ptr` 型で pointee 型情報を持たない —— すべての GEP（`getelementptr`）は**source element type を明示的に第一引数として渡す**必要がある。これは zcc にとって大きな設計駆動：**シンボルテーブルに各バインディングの storage element type を記録する**必要、さもないと後で `arr[i]` を行う時に GEP に何の型を渡すかが分からない。

[`codegen.h:24-30`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.h#L24-L30) の `Symbol` 構造体：

```cpp
struct Symbol {
    llvm::Value*   value = nullptr;       // alloca / global のアドレス、または局所 const の即値定数
    llvm::Function* function = nullptr;   // 関数シンボル
    VAR_TYPE       kind = VAR_TYPE::VAR;
    llvm::Type*    type = nullptr;        // 鍵：storage の element type
    bool           pointerParam = false;  // 「配列がポインタに退化した」仮引数か
};
```

`type` フィールドはバインディング形態によって意味が違う：

| バインディング形態 | `type` フィールドの意味 |
|---|---|
| スカラ `int x` | `i32` |
| スカラ `char c` | `i8` |
| 一次元 `int a[3]` | `[3 x i32]`（**配列型全体**） |
| 多次元 `int m[2][3]` | `[2 x [3 x i32]]` |
| 配列仮引数 `int p[]` | `i8`/`i32` 等 **pointee element type**（`[N x T]` ではない） |

最後の行が §4 タイトル「二つの形」の由来。`LValAST::ToPointer` が `pointerParam` フラグを見て GEP の形を決める（[`ast.cpp:611-639`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L611-L639)）：

```cpp
if (sym.pointerParam) {
    // 配列退化引数：addr はスロット、中に pointer が入る。先に真のポインタを load。
    llvm::Value* base = cg->LoadPointer(addr);
    addr = cg->CreateGEP(container, base, idx);              // gep T, ptr <loaded>, i0, i1, ...
    elemOut = cg->PeelArray(container, (int)idx.size() - 1);
} else {
    // 本物の配列オブジェクト：addr はすでに配列ポインタ、leading zero で「配列に入る」必要。
    vector<llvm::Value*> gidx{cg->GetInt32(0)};
    for (auto* v : idx) gidx.push_back(v);
    addr = cg->CreateGEP(container, addr, gidx);             // gep [N x T], ptr <addr>, 0, i0, i1, ...
    elemOut = cg->PeelArray(container, (int)idx.size());
}
```

二つの GEP の違い：

```
本物の配列 int m[2][3]：
    %m = alloca [2 x [3 x i32]]
    %p = getelementptr [2 x [3 x i32]], ptr %m, i32 0, i32 i, i32 j     ← leading zero あり
                                                       ↑   ↑
                                                       第一次元   第二次元

配列引数 int m[][3]（[3 x i32] を指すポインタに退化）：
    %m = alloca ptr                              ← 仮引数スロット
    store %incoming_ptr, ptr %m                  ← 関数実引数を格納
    %loaded = load ptr, ptr %m                   ← LoadPointer
    %p = getelementptr [3 x i32], ptr %loaded, i32 i, i32 j   ← leading zero なし
                                                ↑
                                                incoming_ptr から直接出発
```

なぜ配列引数には leading zero が無いか？退化ポインタは**すでに配列の最初の要素を指している**、「配列オブジェクト自体を指す」のではない。`gep [3 x i32], ptr, i` は C の `ptr[i]` に等価、ストライドは一つの `[3 x i32]` のバイト数（12）；`gep [3 x i32], ptr, i, j` は `ptr[i][j]` に等価。

これが `Symbol.type` が配列引数の場合に**要素型**を保存し配列型ではない理由でもある —— 配列型自体は退化時にすでに一層剥がされているから。`FuncFParamAST::Alloca` がバインディングを作る所で明示的に `pointerParam = true` をタグ付け（[`ast.cpp:664`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L664)）、GEP の形の分岐全体がこの一 bool で守られる。

---

## 5. 短絡 `&&` / `||` は制御フローを通る、boolean 算術を通らない

これは「教育時に書き間違いやすい」古典点。SysY/C0 の `a && b` は**`a == 0` の時 `b` を評価しない**ことを要求する —— だから書いてはいけない：

```llvm
%a_val = ...
%b_val = ...        ; ← 誤：b はすでに評価された
%bool_a = icmp ne i32 %a_val, 0
%bool_b = icmp ne i32 %b_val, 0
%and = and i1 %bool_a, %bool_b
```

正しい実装は IR の中で**分岐**を使う、`and` 命令ではなく。[`LAndExprAST::ToValue`](https://github.com/leafvmaple/zcc/blob/main/src/ast/ast.cpp#L486-L506)：

```cpp
auto* leftVal = left->ToValue(cg);
auto* rightBB = cg->CreateBasicBlock("land_right", func);
auto* endBB   = cg->CreateBasicBlock("land_end", func);
auto* result  = cg->CreateAlloca(cg->GetInt32Type(), "land_result");
auto* cond    = cg->CreateICmpNE(leftVal, cg->GetInt32(0));

cg->CreateStore(cond, result);                       // 先に left の真偽を result に格納
cg->CreateCondBr(cond, rightBB, endBB);              // 真なら right を計算しに飛ぶ

cg->SetInsertPoint(rightBB);
cond = cg->CreateICmpNE(right->ToValue(cg), cg->GetInt32(0));
cg->CreateStore(cond, result);                       // result を上書き
cg->CreateBr(endBB);

cg->SetInsertPoint(endBB);
return cg->CreateLoad(result);
```

`||` は同形、`CreateCondBr(cond, endBB, rightBB)` だけ逆（真なら直接 end に飛ぶ）。

```
%result = alloca i32
%a = ...                                    ; ← left の値
%cond_a = icmp ne i32 %a, 0
store i32 %cond_a, ptr %result              ; ← 短絡時の結果
br i1 %cond_a, label %land_right, label %land_end

land_right:
%b = ...                                    ; ← right は a が真の時だけ評価
%cond_b = icmp ne i32 %b, 0
store i32 %cond_b, ptr %result
br label %land_end

land_end:
%out = load i32, ptr %result
```

`result` alloca は**意図的に単純な解**：理論的に LLVM の標準手法は SSA `phi` ノードを使う、だが phi は AST 側で各 incoming がどの BB から来るかを記憶する必要があり、書くのが面倒。alloca + load は LLVM の `mem2reg` pass で最適化時に phi に昇格できる、**生成時に簡単に書く / 最適化時に昇格**の経路は教育性コンパイラで合理的選択。

> SSA / phi vs alloca について：最適化を通さない状態では生成された IR の直読みでは phi ノードの方がコンパクト；`mem2reg` は alloca + load/store を phi ノードに昇格、最終的に同じコードが生成される。clang 自身も大量に alloca を使う IR を吐く、最初から phi を直接構築はしない —— フロントエンドが各 SSA 変数の全 incoming を追跡するのは複雑すぎる。zcc はこの idiom を借りた。

---

## 6. `Optimize()` が `#if 0` で囲まれている：誠実な不帰路一段

[`codegen.cpp:19-41`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.cpp#L19-L41) にこの段：

```cpp
void CodeGen::Optimize() {
#if 0
    llvm::PassBuilder pb;
    llvm::FunctionAnalysisManager fam;
    // ...
    llvm::FunctionPassManager fpm;
    fpm.addPass(llvm::ADCEPass());        // 死コード除去
    fpm.addPass(llvm::SimplifyCFGPass()); // CFG 簡略化（ブロック合併、空ブロック削除）
    // ...
    mpm.run(Module, mam);
#endif
}
```

これが zcc 側の最適化 pass —— 現状 `#if 0` で閉じられている。関数自体は `main.cpp:163` から呼ばれているが、中で何も起きない。

なぜ削除しない？かつてこの段は走った —— ADCE + SimplifyCFG はすでに検証済み、IR 出力がよりきれいになる。閉じた理由は工程的取捨：

- **下流の `llc` がすでにこの二つの最適化をやる**。zcc の出力は `llc -O0` を通る（[`main.cpp:129`](https://github.com/leafvmaple/zcc/blob/main/src/main.cpp#L129)）、だが `llc` 自体が instruction selection の前に標準 mid-end 簡略化を一回走らせる。zcc 側の ADCE はほとんど価値が無い —— 同じ死命令を `llc` がもう一度掃除する。
- **ビルド複雑度が上がる**。`llvm::PassBuilder` の導入は `codegen.cpp` に大量の `<llvm/Passes/*>` と `<llvm/Transforms/*>` ヘッダ include を増やし、コンパイル時間が顕著に伸びる。
- **debug 時、IR は「素」であるほど読みたい**。zcc 自身の論理にバグが出た時（例えば §4 の GEP 形を選び間違える）、ADCE を通った IR はすでに「生成したつもりだが消された」命令を除去している、かえって調べにくい。

最終状態は**コードを残す、`#if 0` で閉じる** —— 次に本当に zcc 側で特定の pass を必要とする人（例えば将来の zcc 固有の定数畳み込み）が現れたら、`#if 0` を `#if 1` に変えれば最初から走れる。**削除しない = 未来への軌跡**：かつてここに到達した、撤回には理由がある、理由は commit 履歴にある。

この種の「誠実に `#if 0` を残す」は Zonix [#13 §3](https://github.com/leafvmaple/blog/issues/13) の「swap には逆引きテーブルが無い」と同じ「現状を認める、完備の振りをしない」抑制。

---

## 7. イテレーション履歴

<!-- 後の codegen / IR / 最適化 pass の進展はここに追加、時間逆順。各行に commit リンク + 一二文の説明。 -->

- 2026-05-23：本記事初出。§6 で `Optimize()` が `#if 0` で閉じられていることを明示、TODO ではなく誠実な工程的取捨である旨を公開。
- 2026-05-22：[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe) `char` を「i32 として扱う」から真の i8 + sign-extend / truncate 全経路へ修正（§3 参照）。同 commit で LValAST のアドレス計算を二種類の GEP 形に書き直す（§4 参照） —— opaque pointer 時代に必ず正しくせねばならぬ事、それ以前の実装は無効な IR を吐いていたが `llc` が一時的に許容していた。`Symbol.type` フィールドで storage element type を記録するのもこの時。
- 2026-03-12：[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) で Koopa バックエンド + テンプレートアダプタ層を削除（§1 参照）。正味 -1,414 行、全既存テスト出力 LLVM IR がバイト単位で一致。プロジェクトが「教育両バックエンド」から「ELF 工具に専念」へ変わる分水嶺。

---

*リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)。本記事は [zcc シリーズ](https://github.com/leafvmaple/blog/issues/20) の一篇。*
