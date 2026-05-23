# `iretq` がついでにプロセスを ring 3 へ落とす：fork の trapret を再利用して信頼できない ELF を実行

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`kernel/exec/{exec,elf_loader}.cpp` / `kernel/trap/trap.cpp` / `include/abi/syscall.h` / `kernel/lib/unistd.h` / `user/zcc`

[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)（2026-04-08）以前、Zonix で走るのはすべて**カーネルスレッド** —— 同特権レベル（ring 0 / EL1）・同アドレス空間、本質的に「信頼するコード」だった。このコミットと [`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9)（自作 C コンパイラ zcc をサブモジュールとして統合）が質的な転換点を越えた：**信頼できない、ディスク上のある ELF ファイルから来たコードが隔離されたアドレス空間に置かれ、ring 3 へ降格して走り、システムコールという狭い窓口からしかカーネルへ戻れない**。

exec 実装の総量は小さい —— `kernel/exec/exec.cpp` 172 行 + `elf_loader.cpp` 116 行 = 288 行；ABI 側 `include/abi/syscall.h` が唯一の真実源で、現時点で 6 つのシステムコール番号（`NR_EXIT`/`NR_READ`/`NR_WRITE`/`NR_OPEN`/`NR_CLOSE`/`NR_PAUSE`）を定義。本記事は密に噛み合う四つを述べる：ユーザーアドレス空間の構築、ELF のロード、特権境界の越境、「ユーザーがカーネルへ渡すあらゆるポインタは悪意あり得る」への防御。これは [#12](https://github.com/leafvmaple/blog/issues/12) で埋めた継ぎ目の実現でもある —— ユーザープロセスは同じ `trapret` 経路を再利用し、`iretq` が復元時に RPL=3 を見て自動で ring 3 へ降格させる。

---

## 1. ユーザーアドレス空間：新しいページテーブル、だがカーネルは見えていなければならない

`exec()` の第一歩は新プロセスに独立したアドレス空間を作ること、**カーネルページテーブルを直接使ってはならない** —— さもないとユーザーコードがカーネル全体を読み書きできる。だが完全に空白なページテーブルも作れない、微妙な制約があるからです：

> **ユーザープログラムがシステムコールを起こすか割り込みに中断され、CPU がカーネルへ陥入するとき、その瞬間使っているのはまだユーザーのページテーブル。** ユーザーページテーブルにカーネルのマッピングが無ければ、陥入の瞬間 —— カーネルコード、カーネルスタック、割り込みハンドラ —— がすべて見つからず、その場で triple fault。

だから解は：**新しいユーザー PML4 を作り、高位半のカーネルマッピングをそのまま複製する。** ユーザーとカーネルが同一の高位半マッピングを共有する（ただし高位半のページテーブルエントリは「ring 0 のみアクセス可」の権限ビットを持ち、ユーザーモードは触れない）：

```cpp
pde_t* create_user_pgdir() {
    auto* pgdir = (pde_t*)kmalloc(PG_SIZE);
    memset(pgdir, 0, PG_SIZE);                    // 低位半（ユーザー領域）は空、ELF が埋めるのを待つ
    // カーネルの高位半トップレベルエントリを丸ごと複製：カーネルは各アドレス空間で見える
    memcpy(&pgdir[USER_TOP_ENTRIES], &boot_pgdir[USER_TOP_ENTRIES],
           (PAGE_TABLE_ENTRIES - USER_TOP_ENTRIES) * sizeof(pde_t));
    return pgdir;
}
```

これは主流カーネルがすべて使う「高位半共有」レイアウト：アドレス空間の低位半は各プロセス私有（ユーザーコード/データ/スタック）、高位半は全プロセスが同一のカーネルマッピングを共有。利点は**システムコールでカーネルへ陥入するとき CR3 を切り替える必要がない** —— カーネルは現在のページテーブルにあり、高価な TLB 刷新を省ける。代償はカーネルマッピングが各プロセスの高位半を占めることだが、64 ビットアドレス空間は十分広く、問題ない。

ユーザースタックは低位半の頂部に別途マップし、`VM_USER_RW`（ユーザー読み書き可）を付ける：

```cpp
uintptr_t setup_user_stack(pde_t* pgdir) {
    for (uintptr_t va = USER_STACK_TOP - USER_STACK_SIZE; va < USER_STACK_TOP; va += PG_SIZE) {
        Page* page = pmm::pgdir_alloc_page(pgdir, va, VM_USER_RW);
        memset(phys_to_virt(pmm::page_to_phys(page)), 0, PG_SIZE);   // ゼロ化、カーネルメモリ内容をユーザーへ漏らさない
    }
    return USER_STACK_TOP;
}
```

ゼロ化の行に注目 —— 新規割り当ての物理ページは以前の別プロセスのデータを持つかもしれず、そのままユーザーへ渡せば情報漏洩。**「ユーザーモードへ露出しようとする」あらゆるメモリは先にゼロ化する**、これは [#13](https://github.com/leafvmaple/blog/issues/13) の demand-zero と同源のセキュリティ規律です。

---

## 2. ELF のロード：program header で段を敷き、二本の安全線を守る

ELF ローダは標準フロー：ヘッダ検証、program header 走査、各 `PT_LOAD` 段を要求された仮想アドレスへマップ。だが教育的カーネルでは、**信頼できない ELF をロードする = 攻撃者が任意に構築できるバイナリを解析する**ので、検証と境界チェックこそ要点です。

検証は `ElfHdr` 自身のメンバ関数に収められた（[`dd6ccee`](https://github.com/leafvmaple/zonix-plus/commit/dd6ccee) で開放式の検証チェーンをメソッドに封装）：

```cpp
struct ElfHdr64 {
    // ...
    [[nodiscard]] bool is_valid() const {
        return e_magic == ELF_MAGIC && e_elf[0] == 2 /*64-bit*/ && e_version == 1
            && e_machine == EM_CURRENT;            // ★ コンパイル時に対象アーキで解決（下記）
    }
    [[nodiscard]] bool is_executable() const {
        return is_valid() && e_type == 2 && e_phoff != 0 && e_phnum != 0;
    }
};
```

`EM_CURRENT`（[`67608c2`](https://github.com/leafvmaple/zonix-plus/commit/67608c2)）は美しい小設計 —— コンパイル時に対象アーキに応じて対応する ELF マシン型に解決される：

```cpp
#if   defined(__x86_64__)  inline constexpr uint16_t EM_CURRENT = EM_X86_64;   // 0x3E
#elif defined(__aarch64__) inline constexpr uint16_t EM_CURRENT = EM_AARCH64;  // 0xB7
#elif defined(__riscv)     inline constexpr uint16_t EM_CURRENT = EM_RISCV;    // 0xF3
#endif
```

こうして x86 カーネルは自動で aarch64 の ELF を拒否し、逆もまた然り —— **「本アーキのバイナリのみ受ける」規則を実行時判定ではなくコンパイル時定数として書いた**。これは [#15 マルチアーキテクチャ抽象](https://github.com/leafvmaple/blog/issues/15) の発想が ELF 検証で再び現れたもの：アーキ差異が `constexpr` に押し込まれ、ローダのコードは一字もアーキ分岐しない。

ロードループには守るべき二本の安全線があります：

```cpp
for (各 PT_LOAD 段 ph) {
    // 安全線 1：段のファイル内範囲はファイル自身を越えてはならない（ファイル外のカーネルメモリ読みを防ぐ）
    if (ph->p_filesz > 0 && ph->p_offset + ph->p_filesz > size) return 0;

    // 安全線 2：段はカーネルアドレス空間へマップしてはならない（ユーザー ELF が「0xFFFFFFFF80000000 へロード」と称しカーネルを上書きするのを防ぐ）
    if (ph->p_va >= KERNEL_BASE) {
        cprintf("elf: segment maps to kernel space (va=0x%lx)\n", ph->p_va);
        return 0;
    }

    uint32_t perm = VM_USER | (ph->p_flags & ELF_PF_W ? VM_WRITE : 0);   // 段の W ビットで権限決定
    // ... ページ割り当て、ゼロ化（BSS と memsz > filesz の部分をカバー）、ファイルデータ複製 ...
}
```

二本目が特に重要：`p_va >= KERNEL_BASE` をチェックしなければ、悪意ある ELF は program header に「この段をカーネルアドレスへロード」と宣言するだけで、ローダは素直にカーネル空間へ書く —— カーネルコードを直接書き換える。この種の「ファイル内のアドレスフィールドを信じる」脆弱性は実際の CVE で繰り返し現れる。**ローダは ELF ファイル内のあらゆる数値を攻撃者が詰めたと仮定せねばならない。**

---

## 3. 特権境界を越える：#12 の `trapret` を再利用し、`iretq` に降格させる

アドレス空間も入口も整った、どう ring 3 へ「跳ぶ」か？ここに新機構は要りません —— **[#12](https://github.com/leafvmaple/blog/issues/12) で述べた fork + forkret/trapret のスタックフレーム偽造術を完全に再利用**し、TrapFrame のいくつかのフィールド値を替えるだけ：

```cpp
TrapFrame tf{};
arch_setup_user_tf(&tf, entry, user_rsp);   // ★ カーネルスレッドとの唯一の違いはこの関数

auto pid = sched::fork(0, user_rsp, &tf);    // [#12] の fork 経路を完全に再利用
```

`arch_setup_user_tf` とカーネルスレッド用 `arch_setup_kthread_tf` は同じ `arch_*()` 継ぎ目の二つの実装で、違いはセグメントレジスタだけ：

```cpp
void arch_setup_user_tf(TrapFrame* tf, uintptr_t entry, uintptr_t usp) {
    tf->cs = USER_CS;        // ★ ユーザーコードセグメント、RPL=3 —— iretq がこれを見て ring 3 へ降格
    tf->ss = USER_DS;        // ★ ユーザースタックセグメント
    tf->rflags = FL_IF;
    tf->rip = entry;         // ELF 入口
    tf->rsp = usp;           // ユーザースタックトップ
}
```

[#12 §3](https://github.com/leafvmaple/blog/issues/12) を思い出すと：fork されたプロセスは初めてスケジュールされるとき `forkret` に落ち → `trapret` へ fall-through → `iretq`。`iretq` は TrapFrame から `cs`/`rip`/`rflags`/`rsp`/`ss` を pop する —— そして**`iretq` が復元すべき `cs` の RPL が 3（ユーザー特権レベル）だと気付くと、自動で CPU を ring 3 へ降格**し、`ss:rsp` 指定のユーザースタックへ切り替える。降格動作全体が `iretq` 一命令で完了し、カーネルに特別なコードは要らない。

これが [#12](https://github.com/leafvmaple/blog/issues/12) の「全プロセスの入口を割り込みからの復帰に統一する」の見返りです：カーネルスレッドとユーザープロセスは**同じ `trapret` 経路・同じ fork 機構**を通り、唯一の差異は TrapFrame の `cs`/`ss` の値。当初カーネルスレッドのために設計した継ぎ目が、ユーザーモード追加時に一行も変わらなかった —— 「継ぎ目は初日に引く」の最も直接的な実現です。

---

## 4. システムコール ABI：全員が認める唯一の真実源

ユーザープロセスが ring 3 へ降格した後、それが合法的にカーネルへ戻る唯一の方法は**システムコール**です。Zonix はシステムコール番号を独立した純粋 C マクロのヘッダに抽出した（[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）：

```c
/* include/abi/syscall.h — カーネルとユーザーツールチェーンが共有する唯一の真実源 */
/* ルール：純粋 C プリプロセッサマクロ、.S アセンブリから #include 可能でなければならない */
#define NR_EXIT   1
#define NR_READ   3
#define NR_WRITE  4
#define NR_OPEN   5
#define NR_CLOSE  6
#define NR_PAUSE  29
```

なぜ独立した一つ、しかも「純粋 C マクロ、アセンブリから include 可能」と限定するか？システムコール番号は**三者を跨ぐ契約**だからです：カーネルのディスパッチャ、ユーザープログラムの libc 風ラッパー、zcc ランタイムのアセンブリスタブ、三者は「4 番は write」に完全に一致せねばならない。どれか一方が番号を間違えれば、wrong syscall が静黙に誤った分岐へ走る。それを純粋 C マクロの単一ヘッダにし、C++ カーネル・C ユーザープログラム・`.S` アセンブリが**物理的に同一ファイルを include** することで、三者が各自定数を持ち徐々にずれる可能性を根本から消す。これは [#14](https://github.com/leafvmaple/blog/issues/14) の `BootInfo` が bootloader とカーネルの共有契約であるのと同じ発想 —— **インターフェース契約は唯一の物理的出所を持て**。

陥入命令自体はアーキ依存なので、またも `arch_*()` 継ぎ目（ユーザー側 `unistd.h` のラッパー）：

```cpp
template<typename T> inline T syscall0(long nr) {
#if defined(__x86_64__)
    __asm__ volatile("int %1" : "=a"(res) : "i"(T_SYSCALL), "0"(nr));   // x86: int $0x80
#elif defined(__aarch64__)
    __asm__ volatile("svc #0" : "=r"(x0) : "r"(x8) : "memory");          // aarch64: svc #0
#endif
    // riscv64: ecall
}
```

カーネル側、システムコールは最終的に**統一トラップディスパッチャ** `trap_dispatch` に合流する —— それは「IRQ か / ページフォルトか / システムコールか」の判定も `arch_*()` の背後に隠す：

```cpp
extern "C" void trap_dispatch(TrapFrame* tf) {
    if (trap::arch_try_handle_irq(tf))        { ... }            // ハードウェア割り込み
    else if (trap::arch_is_page_fault(tf))    { handle_page_fault(...); }  // ページフォルト（#13 参照）
    else if (trap::arch_is_syscall(tf)) {                        // システムコール
        trap::arch_on_syscall_entry(tf);
        if (!trap::handle_syscall(tf)) { tf->set_return(-1); }   // 未知の番号 → -1 を返す
    }
}

bool handle_syscall(TrapFrame* tf) {
    switch (tf->syscall_nr()) {          // syscall_nr() / syscall_arg(n) / set_return() はすべてアーキ抽象のアクセサ
        case NR_WRITE: { ... tf->set_return(sys_write(...)); return true; }
        case NR_EXIT:  { sched::exit(tf->syscall_arg(0)); ... }
        // ...
    }
}
```

`tf->syscall_nr()` / `syscall_arg(n)` / `set_return(v)` は「システムコール番号と引数がどのレジスタにあるか」（x86 は `rax`/`rdi`…、aarch64 は `x8`/`x0`…）という**純粋に ABI 依存**の事柄を TrapFrame のアクセサに閉じ込め、`handle_syscall` のディスパッチロジックは完全にアーキ非依存。これは [#15](https://github.com/leafvmaple/blog/issues/15) の継ぎ目のシステムコール層での再利用です。

---

## 5. 信頼境界：ユーザーが渡すあらゆるポインタは攻撃かもしれない

システムコールはユーザーがカーネルへ入れる唯一の窓口、よって**カーネル全体で信頼境界が最も鋭い場所**です。`sys_write(fd, buf, count)` の `buf` はユーザーモードポインタ —— ユーザーは**カーネルアドレス**を指すポインタを渡し、カーネルに「このメモリをファイルへ書いて」と騙してカーネルメモリを読み出せるし、カーネルへのポインタを渡してカーネルに `read` で書き込ませカーネル状態を改竄できる。これが古典的な confused deputy です。

Zonix の防衛線は二つの小関数だが、それらがユーザー/カーネル境界全体を守ります：

```cpp
// ユーザーが渡す (アドレス, 長さ) はすべて先に検証：完全にユーザー空間内に収まらねばならない
bool user_range_valid(uintptr_t addr, size_t size) {
    if (addr >= USER_SPACE_TOP) return false;            // アドレス自体が越境
    if (size > USER_SPACE_TOP - addr) return false;      // アドレス + 長さ がカーネル領域へ溢れる（整数オーバーフロー防止の書き方に注意）
    return true;
}

// ユーザーが文字列を渡すとき（例：open のパス）、直接デリファレンスできない —— 逐バイトでカーネルバッファへ複製、複製しながら境界チェック
int copy_user_cstr(const char* user, char* out, size_t out_size) {
    if (!user || base >= USER_SPACE_TOP) return -1;
    for (size_t i = 0; i < out_size; i++) {
        if (base + i >= USER_SPACE_TOP) return -1;       // 文字列がカーネル領域へ跨ぐ → 拒否
        out[i] = user[i];
        if (out[i] == '\0') return 0;                    // 正常終端
    }
    return -1;                                            // 超長（終端なし）→ 拒否
}
```

二つの細部を述べます：

- `user_range_valid` の `size > USER_SPACE_TOP - addr` という書き方、`addr + size > USER_SPACE_TOP` ではなく —— **整数オーバーフロー防止**のため。ユーザーが巨大な `size` を渡すと `addr + size` が回り込んで小さな値になりチェックをすり抜ける；引き算にすればオーバーフローしない。境界チェックで繰り返し見落とされ、繰り返し悪用される細部です。
- `copy_user_cstr` はユーザー文字列に終端符があると信じず、**自分で長さを制限**（`out_size`）し逐バイトで境界チェック。ユーザーポインタへ直接 `strlen` を呼ぶのは古典的脆弱性：ユーザーが `\0` 無しでユーザー空間末尾にぴったり貼り付いた文字列を渡すと、`strlen` がカーネルへ越境読みする。

ユーザーモードを導入したその瞬間、カーネルにまったく新しい、最も危険な入力の類が増える：信頼できないプロセスからシステムコール境界を通って渡されるデータ。それ以前 Zonix の全入力はカーネル自身のコードから来た；`exec` で最初のユーザープログラムを動かす瞬間から、「ユーザーポインタを決して信じない」が常に張り詰めていなければならない規律になる。教育的カーネルがこの線を明確に引くことは、システムコールをいくつか多く実装するよりずっと重要だ。

---

## 6. ユーザープログラムはどこから来るか：自作コンパイラ zcc

最後のピース：`exec` がロードする ELF は誰がコンパイルしたのか？ Zonix が使うのは**自作の C コンパイラ zcc**（[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) でサブモジュールとしてビルドパイプラインへ統合、リポジトリは [leafvmaple/zcc](https://github.com/leafvmaple/zcc)）。`user/Makefile` は zcc でユーザープログラムをコンパイルし、FAT32 8.3 短ファイル名互換の ELF を生成（`Z` プレフィックス付き）、userdata ディスクイメージへ詰める；カーネル起動後このディスクを `/mnt` へマウントし、`exec("/mnt/ZHELLO.ELF")` でそれを走らせる。

zcc 自体は別の大きな話題で単独記事に値する（このカーネルと共に「自作コンパイラが自作カーネル上で走るプログラムをコンパイルする」完全なブートストラップ鎖を構成する）、ここでは exec 経路でのその位置を指摘するだけ。特筆すべきは exec 経路がエラークリーンアップ保証に RAII を多用すること —— `KernelBuf`（自動 `kfree`）、`OpenFile`（自動 `vfs::close`）、どの段階で失敗してもデストラクタが申請済みリソースをきれいに回収する。これこそ [#17](https://github.com/leafvmaple/blog/issues/17) で述べた「freestanding カーネルでも RAII でリソースを締める」の新経路での応用です。

---

## 7. 更新履歴

<!-- exec / syscall / ユーザーモードの今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-05-22：[`551394f`](https://github.com/leafvmaple/zonix-plus/commit/551394f) exec エンドツーエンドテストが単一ディスクの目標（aarch64/riscv64 の SDHCI）で優雅にスキップし、x86 BIOS/UEFI カバレッジを保つ；[`0b7e929`](https://github.com/leafvmaple/zonix-plus/commit/0b7e929) `GptHeader` を完全な 512 バイトセクタに揃え、`find_partition_start` が直接構造体へ読み込む（[#14](https://github.com/leafvmaple/blog/issues/14) の GPT/パーティションテーブルに関連）；[`dd6ccee`](https://github.com/leafvmaple/zonix-plus/commit/dd6ccee) ELF 検証を `ElfHdr` メンバ関数へ封装。
- 2026-04-08：本サブシステム初登場。[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) exec/FAT を `ENSURE`/`TRY` でエラー処理を簡素化（[#17](https://github.com/leafvmaple/blog/issues/17) 参照）；[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) syscall ABI ヘッダを抽出（§4 参照）；[`67608c2`](https://github.com/leafvmaple/zonix-plus/commit/67608c2) `EM_CURRENT` アーキ別 ELF マシン型を追加（§2 参照）；[`9a321a9`](https://github.com/leafvmaple/zonix-plus/commit/9a321a9) zcc コンパイラサブモジュール + userdata イメージをビルドパイプラインへ統合（§6 参照）；[`dd98ccd`](https://github.com/leafvmaple/zonix-plus/commit/dd98ccd) exec 統合テストを追加し、fork/load/run 全経路を検証。

---

*リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本記事は [Zonix OS シリーズ](https://github.com/leafvmaple/blog/issues/11) の一篇。*
