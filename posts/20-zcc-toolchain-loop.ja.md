# zcc が吐く ELF を Zonix で直接走らせる：自作ツールチェーンと OS の閉環

> リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)
> コミット期間：2024-07-03 → 2026-05-22、116 コミット、二つの集中開発期にまたがる（2025-08 の本体実装 / 2026-03–05 の Zonix との閉環）
> 規模：~3,142 行の C++17 + アセンブリ + リンカスクリプト、**LLVM IR 単一バックエンド**、**x86_64 / riscv64 二種類の freestanding runtime**
> 機能：C サブセットフロントエンド（int / char / 一次元 + 多次元配列 / 関数 / for-while-break-continue / 短絡 `&&`/`||`）、LLVM IR codegen、`-llvm` / `-x64` / `-riscv64` 三種類の出力、自前の `crt0 + libzccrt.a + linker.ld`、Zonix OS と一つの `syscall.h` を共有

本記事は zcc の**メインインデックス**です。これは独立したおもちゃのコンパイラではない —— その存在理由のすべては [Zonix OS #11](https://github.com/leafvmaple/blog/issues/11) との**自己ホスティング鎖の雛形**を形成することにある：自作コンパイラが C ソースを ELF に編み、自作 runtime で freestanding 実行ファイルに包み、自作カーネル `exec()` でロードし、自分で定義した syscall 番号でカーネルへ戻る（詳細は [#18 ユーザーモード ELF 実行](https://github.com/leafvmaple/blog/issues/18)）。

この鎖の中で**最も重要な継ぎ目**は、つまらない一枚のヘッダ —— zcc の `src/runtime/syscall.h` と Zonix の `include/abi/syscall.h` は二つの**物理コピー**を保持するが、同一の「論理契約」（6 つの syscall 番号 + fd 定数）を定義し、両者が永遠にバイト同期するよう一つの CI スクリプトが守っている。二つの物理ファイルが存在するのは怠慢ではない —— zcc は独立リポジトリとして単独でビルドできなければならず、Zonix のサブモジュールパスへ逆向きに依存できない —— だが Zonix カーネル、ユーザープログラムの `.S` スタブ、zcc runtime の三者が必要としているのは「4 番が write」という結論そのもの。**二つの物理ファイル、一つの論理契約、自動検証** —— これが [#21](https://github.com/leafvmaple/blog/issues/21) 全体で解きほぐすこと。

本文に入る前にプロジェクトの指標を並べる。2026-05-22 時点：

| 指標 | 数値 | 意味 |
|---|---|---|
| コミット数 | **116** | 期間 2024-07-03 → 2026-05-22、主に 2025-08 と 2026-03–05 に集中 |
| 総コード行数 | **~3,142** | `.cpp/.h/.c/.l/.y/.S/.ld` すべて計上 |
| フロントエンド (`parser/`) | **710** | flex 132 + bison 578（LALR(1) C++ skeleton + variant tokens） |
| AST + codegen (`src/ast/` + `src/ir/`) | **1,529** | LLVM 非依存の AST ノード + LLVM IRBuilder を呼ぶ codegen 薄層 |
| メインドライバ (`src/main.cpp`) | **181** | コマンドライン + `llc` + `clang -c` + `ld` をつなぐ完全な後段パイプライン |
| Freestanding runtime (`src/runtime/`) | **450** | `printf` + `crt0.S` + `syscall.S` + `linker.ld`、**x64 / riscv64 各一式** |
| Zonix と共有するヘッダファイル | **1** | `syscall.h`、コンパイラとカーネルが同一の物理ファイルを include |
| 回帰テストケース | **15** | `test/cases/*.c`、host clang を oracle に、stdout を diff |

二点だけ補足を：

- 3 千行は「短い」ためではない。**自前 OS の `printf("Hello\n")` 経路をちょうど通せる最小集合**で止める意図 —— 下の §3 でなぜさらに進めないかを展開する。この抑制こそ「もう一つの C コンパイラ」と区別される鍵。
- あの「1」 —— 一枚の `syscall.h` がコンパイラ・カーネル・アセンブリスタブ三者に同時に提供される —— は**三者契約の物理的源泉**。どの一方の「どの番号が write か」の記憶のずれも、コンパイル時に発見される、ランタイムで wrong syscall が静かに分岐を間違える前に。これは Zonix [#14](https://github.com/leafvmaple/blog/issues/14) の `BootInfo` が bootloader / カーネルの共有契約であるのと同根 —— **境界をまたぐ常数の取り決めには唯一の物理源を**。

下の三つの決定が、この 3,100 行で閉環を完成できる理由を説明する。

## 目次

- [0. 設計制約](#sec-0)
- [1. 第一の決定：IR バックエンドは差し替え可能な薄層 (`ba52eea`)](#sec-1)
- [2. 第二の決定：ABI と runtime はコンパイラの構成要素 (`962ce2b` / `06b07a5`)](#sec-2)
- [3. 第三の決定：フロントエンドは意図的に「小さな C」で止める (`3871ee4`)](#sec-3)
- [4. シリーズ記事](#sec-4)
- [5. 閉環の後もなお成立する事実](#sec-5)

---

<a id="sec-0"></a>
## 0. 設計制約

zcc の目標は「もう一つの C コンパイラを書く」ではない。**[Zonix OS](https://github.com/leafvmaple/zonix-plus) のために、ロード可能な ELF を吐けるツールチェーンを供える**こと。この制約が、やりたかった多くを逆に削ぎ落とす：

- **完全な C を実装しない** —— `typedef` / `struct` / `float` / `union` / `switch` / `goto` / preprocessor 全部なし。理由は Zonix の `exec` がロードする最初のユーザープログラムが `hello.c` で、`printf("Hello\n"); return 0;`。これが編めれば十分、増える複雑度は「閉環」目標へゼロ寄与。
- **自前バックエンドを書かない** —— 命令選択・レジスタ割付・スケジューリングは LLVM (`llc`) に委ねる。zcc は `.ll` を吐くだけ、下流は `llc + clang -c + ld` でつなぐ。3,100 行で通せる前提は後段の委譲。
- **ホスト libc に依存しない** —— `crt0` が直接 `int $0x80` / `ecall` を呼び、`printf` は syscall で stdout (fd=1) に直書き。Zonix 起動時には glibc などリンクできるものは無い。

第三条が継ぎ目の鍵。「教育用 C コンパイラ」がデフォルトでホスト libc にリンクすると、編まれたプログラムは自前 OS で `printf` 一行さえ走らない —— なぜならホスト libc の `printf` が最終的に呼ぶのは Linux ABI の `syscall` 命令・番号・規約、すべてホストのもので、**自前 OS の trap dispatcher と合わない**。閉環するには、ターゲット OS と取り決めた runtime を必ず自前で持つ必要がある。

この一条が「コンパイラプロジェクト」と「OS プロジェクト」の継ぎ目を正確に一枚の `syscall.h` の上に引いた。下の三つの決定が、このヘッダが**どうやって唯一の真実源となるか、なぜこの一筆が 1,500 行の codegen より重いか**を説明する。

---

<a id="sec-1"></a>
## 1. 第一の決定：IR バックエンドは差し替え可能な薄層 (`ba52eea`)

zcc の初版（2024-07、[`361081b`](https://github.com/leafvmaple/zcc/commit/361081b)）の目標は PKU コンパイラ実習の SysY → Koopa IR。`1cae145` で Koopa バックエンド、`3b0780b` で二つ目の LLVM バックエンドを追加し、一時期は両 IR を並行維持：AST ノードの `Codegen()` がテンプレ/アダプタ層で backend を選んでいた。

[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea)（2026-03-12、"remove Koopa backend and template-based IR adapter layer"）が Koopa の経路を丸ごと削除、LLVM を残す。これは**直感に反する**決断 —— 多くのチュートリアルは「多 IR バックエンド対応」を見せ場にする。ここで削る論理は：

> **AST はすでに `CodeGen` のメソッド名にしか依存しておらず、LLVM の型そのものには依存しない**。Koopa バックエンドは [#22](https://github.com/leafvmaple/blog/issues/22) でオンラインになって以降「動く」だけで、ELF 生成に誰も使っていない；LLVM バックエンドに永遠に劣るコピーを維持するくらいなら、アダプタ層もろとも消す。**継ぎ目の意味は多バックエンドではなく、「差し替え可能な継ぎ目を先に持ち、差し替えるかを後で決める」**。

`src/ir/codegen.h` がこの継ぎ目。先頭数メソッドの宣言を見れば：

```cpp
class CodeGen {
public:
    llvm::Value* CreateAdd(llvm::Value* lhs, llvm::Value* rhs);
    llvm::Value* CreateLoad(llvm::Value* src);
    llvm::Value* CreateGEP(llvm::Type* type, llvm::Value* array, std::vector<llvm::Value*> index);
    llvm::BasicBlock* CreateBasicBlock(const std::string& name, llvm::Function* func);
    // ... 計 ~140 メソッド
};
```

これは**ほぼ `llvm::IRBuilder` の一対一転送**、加えてわずかな AST 向け便利メソッド（`MakeArrayType(elemType, dims)` で多次元配列型を一発構築、`StoreScalar(value, dest, elemType)` で i32→i8 切り詰めを内包）。「IRBuilder にもう一枚薄い窓ガラスを被せた」程度のラッパは、かつて Koopa/LLVM 二面派の差し替え可能な継ぎ目だった；今残る価値は：

1. **AST が `<llvm/IR/IRBuilder.h>` を直接 include しない**：本当に `BaseType::TYPE::INT → llvm::Type::getInt32Ty()` を結ぶ `ast/type.cpp` 一箇所を除き、`src/ast/` 全体に LLVM の型は現れない。これで AST の単体テストは理屈上 `CodeGen` をモックして走らせられる（今はやってない）。
2. **いつか本当にバックエンドを差し替えたい時**（例：RISC-V アセンブリを直接吐いて LLVM を経由しない）に変更が要るのは `codegen.{h,cpp}` の ~500 行、AST の 1,016 行は一文字も変えなくて済む。

`ba52eea` の削除の振り返り、`codegen.h` 薄層が `IRBuilder` の厄介な API（opaque pointer 後の `CreateGEP` は明示的に source element type を渡さねばならない、多次元配列の初期化は row-major で平坦化）をどう収めたかは、[#22](https://github.com/leafvmaple/blog/issues/22) 全体で扱う。

---

<a id="sec-2"></a>
## 2. 第二の決定：ABI と runtime はコンパイラの構成要素 (`962ce2b` / `06b07a5`)

「自前 OS で走らせられる」コンパイラは、**必ず自前で runtime を持たねばならない**。Zonix の `exec` が ELF をロードしたあと、制御は ELF のエントリポイントへ落ちる —— そのアドレスのコードは `crt0._start` でなければならず、それがスタックフレームを掃除し、`main` を呼び、`main` の返り値を `sys_exit` に渡す。この `crt0` はコンパイラプロジェクトが供えるしかない、なぜなら：

- **ホスト libc の `crt0` は使えない**：TLS をセットアップし、`__libc_start_main` を呼び、ELF init array を走らせる —— これらのスタブは Zonix には全くない。
- **毎回ユーザーに手書きさせるわけにいかない**：それは各ユーザープログラムにアセンブリエントリを保持させる羽目になる。
- **OS に供えさせるわけにいかない**：Zonix は zcc がどの calling convention を選んだか、終了コードをどのレジスタに置くかを知らない。

そこで [`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5)（2026-03-13、"add freestanding runtime library and ELF generation for custom OS"）が `src/runtime/` を zcc 自身のソースツリーに加える。構成：

```
src/runtime/
├── syscall.h         ← 唯一の真実源、純粋 C マクロ、アセンブリから include 可
├── printf.c          ← sys_write 経由、libc に非依存
├── minilib.h
├── x64/
│   ├── crt0.S        ← _start: call main; sys_exit(rax)
│   ├── syscall.S     ← sys_write / sys_read / sys_open / sys_close / sys_exit / sys_pause
│   └── linker.ld     ← 0x400000 にロード、.text/.rodata/.data/.bss を敷く
└── riscv64/          ← 同じ三点セット、規約は ecall + a0/a7 へ
```

`-x64` / `-riscv64` は `main.cpp` のコマンドラインで起動：LLVM IR → `llc` でアセンブリ → `clang -c` で `.o` → `ld -T linker.ld crt0.o user.o libzccrt.a` で最終 ELF を組む（[`main.cpp:107-146`](https://github.com/leafvmaple/zcc/blob/main/src/main.cpp#L107-L146)）。一行のコマンドでロード可能な ELF が出る、**ユーザーは `crt0` / `linker.ld` の存在を知らずに済む**。

だがこれは runtime をリポジトリに物理的に放り込んだだけ。本当に「OS と契約を形成する」鍵は [`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b)（2026-04-08、"implement full syscall ABI with shared header"）：

```c
/* src/runtime/syscall.h —— 純粋 C マクロ、.S からも #include 可 */
#define NR_EXIT  1
#define NR_READ  3
#define NR_WRITE 4
#define NR_OPEN  5
#define NR_CLOSE 6
#define NR_PAUSE 29
```

このファイルは Zonix [`include/abi/syscall.h`](https://github.com/leafvmaple/zonix-plus/blob/main/include/abi/syscall.h) と**字句的に同じ** —— zonix-plus リポジトリは git submodule + symlink/copy ではなく、二つの物理コピーで保持し、自動 diff スクリプトで一致を保証する（詳細は [#21](https://github.com/leafvmaple/blog/issues/21) で）。三人の消費者：

| 消費者 | 使い方 |
|---|---|
| Zonix カーネル `kernel/trap/syscall.cpp` | C++ コード `case NR_WRITE:` が `sys_write` 処理関数へ飛ぶ |
| zcc ユーザープログラムの `printf.c` | C コード `sys_write(1, &c, 1);` —— `sys_write` 自身は `.S` スタブ |
| zcc runtime `syscall.S` | アセンブリ `movq $NR_WRITE, %rax; int $0x80` |

**どの一方が一つの番号を書き間違えても、同一のヘッダを include しているのでコンパイル時に引き戻される**。この継ぎ目は Zonix [#14](https://github.com/leafvmaple/blog/issues/14) の `BootInfo` が bootloader / カーネル共有契約であるのと同根 —— **境界を跨ぐ常数の取り決めには唯一の物理源を**。

なぜ `syscall.h` は純粋 C マクロでなければならず、`enum class` / `constexpr` ではダメか？`.S` ファイルから include される必要があるから。アセンブリの preprocessor は `#define` しか認識せず、C++ の型は読めない。この制約が逆に「真にクロス言語の契約」であることを証明する —— 「C++ 定数をアセンブリ用にコピーした」のではなく。

`syscall.h` の zcc 側での具体的な使い方、`crt0.S` が `main` の返り値を `sys_exit` にどう渡すか、`linker.ld` がなぜエントリポイントを `0x400000` に置くか（Zonix のユーザーアドレス空間配置、詳細は Zonix [#18](https://github.com/leafvmaple/blog/issues/18) §1）は、[#21](https://github.com/leafvmaple/blog/issues/21) 全体で扱う。

---

<a id="sec-3"></a>
## 3. 第三の決定：フロントエンドは意図的に「小さな C」で止める (`3871ee4`)

zcc の出発点は PKU コンパイラ実習の SysY 言語（int スカラ + 一次元配列 + 関数 + while + if-else、**char / for / 文字列リテラル / printf は無し**）。Zonix 上の `hello.c` を編むには：

```c
int main() {
    int i;
    for (i = 0; i < 5; i = i + 1)
        printf("hello %d\n", i);
    return 0;
}
```

[`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4)（2026-03-12、"extend SysY to C0 language with char, for-loop, printf/scanf"）が加えたのはこれだけ：

1. `char` 型 + 文字リテラル（`'a'` は lex で直接 `INT_CONST` を吐き、型は AST 側で `CHAR` とタグ付け）
2. 文字列リテラル + `printf` / `scanf` を vararg builtin として（`CompUnitAST::Codegen` でハードコード注入）
3. `for (init; cond; step) stmt` 構文 + `break` / `continue`
4. 短絡 `&&` / `||` は SysY に既存、そのまま使用

**加えなかった**ものの方がより語る価値がある：

| 加えていない機能 | 理由 |
|---|---|
| `struct` / `typedef` | Zonix のユーザープログラムは現状 `int main() { printf(...); return 0; }` レベル、struct 需要ゼロ |
| `float` / `double` | IEEE 754 + FP レジスタ呼出規約 + soft-float fallback、工数爆発；ユーザープログラム不要 |
| `switch` / `goto` | LLVM 層は `switch` 命令 + label —— だが LALR 文法で扱うには reduce を 4-5 条追加、既存の `break/continue` ジャンプ機構（[`EnterWhile`/`ExitWhile`](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.cpp#L356) のスタック）と直接的な再利用が効かない |
| preprocessor (`#include` / `#define`) | lexer 全体の再設計が要る。Zonix のユーザープログラムは多ファイル化されてない、マクロ需要なし |
| ポインタ型（ユーザー側の明示的 `int*`） | 配列引数はすでにポインタ退化扱い（[`pointerParam` フラグ](https://github.com/leafvmaple/zcc/blob/main/src/ir/codegen.h#L24-L30)）で足りる |
| 多ファイルリンク（`.o` 間のシンボル解決） | zcc は一度に一翻訳単位しか編まない、最後の `ld` で runtime の `.o` をリンクする |

このリストを書き出すと「じゃあこのコンパイラ何の役にも立たない」と思われやすい。だが**鍵は「この決断を下す瞬間」** —— `struct` を加えるのは一週間、`float` は二週間、preprocessor は最低二週間 —— これらの時間を Zonix 側に向ければ [#19 侵入式リンクリスト](https://github.com/leafvmaple/blog/issues/19) や SMP スケジューラに進める。**抑制が完全性より重い**、このプロジェクトの KPI は「閉環できる」ことであって「busybox を編める」ことではない。

C0 進化の詳細（dangling-else を MatchedStmt/UnmatchedStmt でどう解く / `char` は i8 だが式は i32 で統一 / 配列引数 decay の GEP 処理 / `printf` を vararg builtin として注入）は、[#23](https://github.com/leafvmaple/blog/issues/23) 全体で扱う。

---

<a id="sec-4"></a>
## 4. シリーズ記事

メインインデックスは骨格をつなぐだけ。三つのサブシステムをそれぞれ深掘り記事に：

| # | テーマ | 一文要約 |
|---|---|---|
| [#21](https://github.com/leafvmaple/blog/issues/21) | 唯一の `syscall.h` 継ぎ目 + freestanding runtime | 一枚の `.h` を C++ カーネル / C ユーザープログラム / `.S` アセンブリが同時に include；`crt0` が `main` の終了コードを `sys_exit` にどう渡すか；`linker.ld` がなぜエントリを 0x400000 に書くか；「`clang test/hello.c` からカーネル `exec()` で走らせるまで」を端から端まで通す |
| [#22](https://github.com/leafvmaple/blog/issues/22) | IR バックエンドを 1 つ削る：LLVM codegen 薄層の取捨 | `ba52eea` で Koopa を削った振り返り；`codegen.h` がなぜ ~140 メソッドの IRBuilder 薄層なのか；多次元配列の row-major 平坦化 + opaque pointer 後の `CreateGEP` で source element type を明示する必要；`i8 char` が i32 式の中で持つ切り詰め/拡張の規律 |
| [#23](https://github.com/leafvmaple/blog/issues/23) | SysY → C0：フロントエンドの最小利用可能な拡張 | bison LALR の dangling-else（MatchedStmt/UnmatchedStmt 二分文法）；なぜ `char` を lex で `INT_CONST` として吐き、型は AST 側に置くか；`printf` / `scanf` を vararg builtin として注入；配列引数の decay と `FuncFParamAST::isArray` フラグ |

---

<a id="sec-5"></a>
## 5. 閉環の後もなお成立する事実

ここに置く数行は、**技術判断時には推測だったが、ここに書く時点で一年半の反復に逐一反例されてなお生き残った**もの。

1. **3,100 行で `hello.c` 全鎖を通せる**。フロントエンド 710 + AST/codegen 1,529 + メインドライバ 181 + runtime 450 = 2,870。残り 200 行は scanner / type / 各種 helper に散る。この数字が逆向きに示すのは：自前 OS で `printf("Hello\n")` を編むには、フロントエンドが「int main / int 配列 / for / printf」をカバーすれば足り、後段は自前で書かず全部 LLVM に委ね、runtime はホスト libc に非依存で書く —— これで足りる。

2. **Koopa バックエンドを削った日、AST は一行も動いていない**。[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) の diff は `src/ir/` とビルドスクリプトに集中、`src/ast/` はゼロ変更。これが「差し替え可能な継ぎ目を先に持つ」価値の物証 —— 継ぎ目の設計が巧妙だったからではなく、AST が初めから `CodeGen` のメソッド名にしか依存せず IR の型に依存しなかったから（詳細は [#22](https://github.com/leafvmaple/blog/issues/22)）。

3. **一枚の `syscall.h` が「4 番は read か write か」のずれを本当に止めた**。[`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b)（2026-04-08）から現在まで 6 週間、三者（カーネル / ユーザープログラム C / ユーザープログラム `.S`）に「この番号は X だと思った」というバグは一度も発生していない。これは制約ではなく物証：境界をまたぐ常数の取り決めの物理源を一つに圧縮すれば、ずれは消える（詳細は [#21](https://github.com/leafvmaple/blog/issues/21)）。

4. **`char` は i8 だが式は i32 で走る、これは LLVM IR の「デフォルトの社会的ルール」**。zcc 初期は `char` も i32 として扱い、`char arr[3] = {1,2,3}` が実際に 12 バイト占有、`arr[1]` のアドレス計算で GEP のストライドが 4 になっていた。[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe)（2026-05-22、"make char an 8-bit type and correct array addressing"）でやっと修正。この修正は store/load 全経路に触れる —— `char` 値の格納は i32→i8 切り詰め、`char` 値の取り出しは i8→i32 sign-extend。`codegen.h` の `StoreScalar` / `CreateLoadInt` / `ConvertInt` 三つの helper はこの仕事のためにある（詳細は [#22](https://github.com/leafvmaple/blog/issues/22) §3）。

5. **freestanding `printf` にバッファは無い**。[`printf.c`](https://github.com/leafvmaple/zcc/blob/main/src/runtime/printf.c) の `put_char` は文字ごとに `sys_write(1, &c, 1)` を一回 —— stdout バッファゼロ。ホスト libc 視点では狂気の沙汰 —— syscall コストはユーザー/カーネル切替；だが Zonix のような実験カーネルでは**むしろ利点**：テスト時に出力が即座に見える、`printf` の途中でクラッシュしてもログを失わない、`fflush(stdout)` も不要。本当にバッファが必要なユーザープログラムが現れたら補えばよい、今ではない。

6. **回帰テストは host clang を oracle に使う**。[`test/run_tests.sh`](https://github.com/leafvmaple/zcc/blob/main/test/run_tests.sh) は各 `test/cases/*.c` に対し：zcc が LLVM IR を吐く → host clang でホスト libc にリンクして走らせ、stdout と `.expected` を diff（[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f)、2026-05-22）。これは「ズル」した測定 —— `-x64 -riscv64` を Zonix で走らせた実出力を検証してはいない、だが**フロントエンド + LLVM IR の意味論が真の C と一致する**ことは検証する。Zonix 側の端から端までの被覆は [`551394f`](https://github.com/leafvmaple/zonix-plus/commit/551394f) の exec 統合テストで補う。両者を足してこそ閉環の完全被覆（詳細は [#23](https://github.com/leafvmaple/blog/issues/23) §4）。

---

## イテレーション履歴

<!-- 本メインインデックスは索引 + メタ経験帖。サブシステムレベルの進展は対応する子篇へ；
     サブシステムをまたぐ構造変更（新バックエンド追加、runtime レイアウト変更、ABI 拡張）は一行でここに索引する。 -->

- 2026-05-23：zcc が独立してシリーズ化。それ以前は Zonix [#18 §6](https://github.com/leafvmaple/blog/issues/18) で一筆だけ。同時に Zonix [#11 §4 テーブル](https://github.com/leafvmaple/blog/issues/11) に「配套ツールチェーン」の行を追加、[#18 §6](https://github.com/leafvmaple/blog/issues/18) を正式な紹介 + 本記事へのリンクに拡張。
- 2026-05-22：[`6f1e4fe`](https://github.com/leafvmaple/zcc/commit/6f1e4fe) `char` を真の i8 型に修正（以前は i32 として扱われていた）、同時に配列アドレス計算の GEP ストライドを 4 から 1 に修正、`chartrunc` / `charscalar` / `chararray` など 5 テストケースを失敗から救出（詳細は [#22](https://github.com/leafvmaple/blog/issues/22) §3）；[`eb0f05f`](https://github.com/leafvmaple/zcc/commit/eb0f05f) で 15 の回帰テストケースを追加、host clang を oracle に使う。
- 2026-04-08：[`962ce2b`](https://github.com/leafvmaple/zcc/commit/962ce2b) で `syscall.h` を唯一の真実源に格上げ、Zonix カーネル（[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）/ zcc runtime / `.S` スタブ三者で物理 include。この日から境界をまたぐ syscall 番号契約には物理源が一つだけ。
- 2026-03-13：[`06b07a5`](https://github.com/leafvmaple/zcc/commit/06b07a5) で freestanding runtime（`crt0.S` / `syscall.S` / `linker.ld` / `printf.c`）と ELF 生成パスを追加。`-x64` / `-riscv64` オプションが初めて Zonix `exec()` で直接ロードできる ELF を吐けるように。
- 2026-03-12：[`ba52eea`](https://github.com/leafvmaple/zcc/commit/ba52eea) で Koopa IR バックエンド + テンプレートアダプタ層を削除。`src/ast/` は一文字も動かず。同日 [`3871ee4`](https://github.com/leafvmaple/zcc/commit/3871ee4) で SysY を C0 に拡張（`char` / `for` / `printf` / `scanf` を追加）。両者で「Zonix への接続準備完了」の言語層 + 後段層がそろう。
- 2025-08：プロジェクト本体実装完成。[`d927451`](https://github.com/leafvmaple/zcc/commit/d927451)（pass lv3 test）から [`f4344fe`](https://github.com/leafvmaple/zcc/commit/f4344fe)（pass autotest lv9）まで、完全な SysY スカラ / 配列 / 関数 / 制御フローをカバー、ただし runtime も ELF パスも無し。

---

*リポジトリ：[leafvmaple/zcc](https://github.com/leafvmaple/zcc)。配套 OS：[Zonix OS メインインデックス](https://github.com/leafvmaple/blog/issues/11)。*
