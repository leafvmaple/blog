# `leave;ret` が 6 週間隠した RSP off-by-8、Clang に切り替えた瞬間 triple fault

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`switch.S` / `sched/` / `TaskStruct` / `Context` / `TrapFrame`

2026-03-12 に zonix-plus のツールチェーンを GCC/GNU ld から Clang/LLD/LLVM へ全面移行（[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c)）したとき、最初の `make qemu` がいきなり triple fault した。コンソールには panic 一行すら出ない。`git bisect` でこの 1 コミットへ絞ると、800 行ほどの Makefile / `cxxrt.cpp` の変更と並んで、8 バイト差のアセンブリ修正が紛れていた：

```diff
@@ arch/x86/kernel/switch.S
-    movq %rsp, 8(%rdi)          # context->rsp
+    leaq 8(%rsp), %rax          # compute caller's RSP (before callq pushed ret addr)
+    movq %rax, 8(%rdi)          # context->rsp = caller's RSP
```

このバグは 2026-01-28（[`62fda85`](https://github.com/leafvmaple/zonix-plus/commit/62fda85)、プロジェクトの最初のコミット）から `switch.S` に居続け、GCC では 6 週間静かに動いていた。GCC が `switch_to` の**呼び出し側** `TaskStruct::run` に生成する epilogue がたまたまそれを迂回していたからだ。Clang の epilogue は形が違い、1 拍目で崩れた。

この記事はそのバグの解剖：§1 で `switch_to` の 20 行アセンブリが何を運んでいるかを見て、§2 で二つのコンパイラの epilogue を机上に並べて比較し、§3-5 はそのスタック魔術がついでに生み出した fork/trapret、スケジューラのカーソル、`current` 更新タイミングの数件。

---

## 1. `switch_to` が運ぶのは「二つのレジスタ集合の差」

プロセス切替の本質：CPU の現プロセスの callee-saved レジスタ + RSP + RIP を保存し、目標プロセスの同じ集合を戻す。x86_64 System V ABI v1.0 §3.2.1（"Registers and the Stack Frame"）は callee-saved レジスタを `rbx / rbp / r12 / r13 / r14 / r15` と定め、加えて `rsp`、制御/状態フィールドを保護対象とする。caller-saved レジスタ（`rax / rcx / rdx / rsi / rdi / r8-r11`）は保存不要 —— `switch_to` は通常の C 関数呼び出しなので、呼び出し側はそれらが壊れる前提だ。

Zonix の `Context` はこの 8 スロット（`rip` / `rsp` / `rbx` / `rbp` / `r12` / `r13` / `r14` / `r15`、各 8 バイト、計 64 バイト）：

```cpp
// Context layout: rip, rsp, rbx, rbp, r12, r13, r14, r15  (各 8 バイト)
```

`switch_to(from, to)` のアセンブリ（`rdi=from`, `rsi=to`）：

```asm
switch_to:
    movq (%rsp), %rax           # スタックトップ = callq が積んだ戻りアドレス = 戻り時に実行すべき rip
    movq %rax, 0(%rdi)          # from->rip = 戻りアドレス
    leaq 8(%rsp), %rax          # ★ 肝：caller の RSP = 現 RSP + 8（戻りアドレスをスキップ）
    movq %rax, 8(%rdi)          # from->rsp = caller's RSP
    movq %rbx, 16(%rdi)         # callee-saved を保存 ...
    movq %rbp, 24(%rdi)
    movq %r12, 32(%rdi)
    movq %r13, 40(%rdi)
    movq %r14, 48(%rdi)
    movq %r15, 56(%rdi)

    movq 56(%rsi), %r15         # 目標プロセスの callee-saved を復元 ...
    movq 48(%rsi), %r14
    movq 40(%rsi), %r13
    movq 32(%rsi), %r12
    movq 24(%rsi), %rbp
    movq 16(%rsi), %rbx
    movq 8(%rsi), %rsp          # ★ スタック切替：今や目標プロセスのカーネルスタック上にいる
    pushq 0(%rsi)               # 目標プロセスの rip を新スタックトップへ積む
    ret                         # 目標プロセスの rip へ「return」する
```

このアセンブリを読む鍵は一つ：**`ret` 命令は常に「現在の RSP が指す場所」から戻りアドレスを取る**。だから最後の 3 行のトリックは —— まず RSP を目標プロセスのスタックに替え、その `rip` を `pushq` し、`ret` で目標プロセスが前回 `switch_to` を離れた場所へ飛ぶ。一つの関数が、入るときはプロセス A、出るときはプロセス B —— **途中で RSP を替えたから**です。

---

## 2. その off-by-8：GCC の `leave;ret` と Clang の RSP-relative epilogue ([`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c))

§1 の ★ の 2 行に注意：

```asm
    leaq 8(%rsp), %rax          # caller's RSP = RSP + 8
    movq %rax, 8(%rdi)          # from->rsp = caller's RSP
```

最初に書いたのは**直接 `%rsp` を保存する**版だった：

```asm
    movq %rsp, 8(%rdi)          # ← バグ版：戻りアドレスを含む RSP を保存してしまった
```

差はたった 8 バイト。`switch_to` に入る時点で `callq` が戻りアドレスを積んだ直後なので、この瞬間の `%rsp` は「呼び出し側が呼ぶ前の RSP」より 8 バイト低い。保存すべきは**呼び出し前の RSP**（つまり `rip` は `context->rip` に別途保存済みで、スタック上のその戻りアドレスが「消費された」後の RSP）だが、バグ版は戻りアドレスをまだ指している RSP をそのまま保存していた。

**なぜ GCC では 6 週間問題なく動いたのか？**

復元時の対称性が、`switch_to` の**呼び出し側** —— `kernel/sched/sched.cpp` の `TaskStruct::run` —— の関数 epilogue にちょうど隠されていたからだ。プロジェクト元の `CXXFLAGS`（`-O0 -ffreestanding -fno-pic -fno-stack-protector -fno-exceptions -fno-rtti -mno-red-zone -mcmodel=kernel`）で `sched.cpp` を GCC 13.3 に食わせる：

```
$ g++ <CXXFLAGS> -c kernel/sched/sched.cpp -o /tmp/sched_gcc.o
$ objdump -d --disassemble=_ZN10TaskStruct3runEv /tmp/sched_gcc.o
...
  44a:   48 8d 45 dc           lea    -0x24(%rbp),%rax
  44e:   48 89 c7              mov    %rax,%rdi
  451:   e8 00 00 00 00        call   456 <_ZN10TaskStruct3runEv+0xc6>
  456:   90                    nop
  457:   c9                    leave        # ★ mov %rbp,%rsp ; pop %rbp —— RBP-relative
  458:   c3                    ret
```

`leave` は `mov %rbp, %rsp; pop %rbp` と等価。RSP を RBP から計算し直すので、**`switch_to` から戻ったときスタック上の RSP 値には一切依存しない**。間違えて保存した 8 バイトは、GCC の復元経路では読まれない —— バグはずっとあったが、誰もその地雷を踏まなかった。

Clang 18 / LLD に切り替えた後、同じ `TaskStruct::run`：

```
$ llvm-objdump -d --disassemble-symbols=_ZN10TaskStruct3runEv obj/x86/kernel/sched/sched.o
...
  ab: 48 8d 7d ec           leaq    -0x14(%rbp), %rdi
  af: e8 00 00 00 00        callq   0xb4 <_ZN10TaskStruct3runEv+0xb4>
  b4: 48 83 c4 40           addq    $0x40, %rsp    # ★ RSP-relative：RSP に直接定数加算
  b8: 5d                    popq    %rbp
  b9: c3                    retq
```

`ret` は `[rsp]` から戻りアドレスを取る —— これで保存して復元した RSP に実際に依存することになった。off-by-8 が即座に顕在化：`ret` は本来の戻りアドレスではなく、スタック上**8 バイトずれた位置の値**へ飛ぶ —— それはちょうど保存されたフレームポインタ、つまりスタックアドレス。CPU はスタックアドレスをコードとして実行し、次の瞬間 page fault → double fault → triple fault → QEMU 再起動。コンソールには panic 一行すら出る暇がない。

特定の過程は教科書的な「二分探索 + 逆アセンブル」だった：`git bisect` で `9fae90c` へ絞り；プロジェクトの Makefile の `make ARCH=x86 disasm` を一回流すと `kernel`、`mbr`、`vbr`、`bootloader` の全逆アセンブル（`llvm-objdump -D` の出力が `obj/x86/*.asm` に落ちる）が出るので、修正前と `TaskStruct::run` の尾を対照する —— `leave;ret` が `addq $0x40, %rsp; popq %rbp; retq` に変わっているのを見て瞬時に判明。修正は冒頭の 2 行：`leaq 8(%rsp), %rax` で戻りアドレスの 8 バイトを「差し引いて」保存。

GCC の `leave;ret` も Clang の `addq/popq/retq` も、SysV AMD64 ABI の合法範囲内の挙動だ —— コンパイラは `%rbp` をフレームポインタとして残すか、`leave` で RSP を再構築するかを選ぶ権利を持ち、選択基準は最適化方針や `-fomit-frame-pointer` 等のスイッチ。合法だが挙動の異なる別のコンパイラ後端に切り替えると、「たまたま成立していた」暗黙の ABI 依存がすべて炙り出される：今回の GCC→Clang 移行は `switch_to` を暴いたほか、未実装の `__cxa_pure_virtual` / `atexit` / `operator new` スタブ、UEFI loader の RWX セグメント違反、いくつかの `-Winline-new-delete` 警告も同時に照らし出した（[#17](https://github.com/leafvmaple/blog/issues/17) 参照）—— コンパイラを替えること = ほぼ無料の fuzzing。

---

## 3. fork されたプロセスは一度も走っていない、その「最初」は偽造

`switch_to` が機能する前提は、目標プロセスの `context` の `rip` が**実在する、以前 `switch_to` を離れた位置**を指していること。しかし `fork` で作られたばかりのプロセスは `switch_to` に入ったことがなく、`context` は空。初めてスケジュールされるとき、`ret` はどこへ飛ぶべきか？

答え：**「割り込みから戻ったばかり」に見えるスタックを手で偽造**し、新プロセスの最初の命令を `forkret` に落とす。

`copy_thread` は新プロセスのカーネルスタックトップに `TrapFrame` を置き、`context` を「入口は `forkret`、スタックトップはこの TrapFrame」に設定します。

```cpp
void TaskStruct::copy_thread(uintptr_t esp, TrapFrame* src_tf) {
    trap_frame = reinterpret_cast<TrapFrame*>(kernel_stack_ + KSTACK_SIZE) - 1;
    *trap_frame = *src_tf;                 // 親（またはカーネルスレッドのテンプレート）のトラップフレームを複製
    arch_fixup_fork_tf(trap_frame, esp);   // 子の戻り値=0、rsp/ss/rflags を修正

    context_.set_entry(reinterpret_cast<uintptr_t>(forkret));    // context.rip = forkret
    context_.set_stack(reinterpret_cast<uintptr_t>(trap_frame)); // context.rsp = &trapframe
}
```

こうして初めて `switch_to` でこの新プロセスへ来たとき、`ret` は `forkret` へ飛ぶ。`forkret` の妙は**そのまま `trapret` へ fall-through する**点です。

```asm
forkret:
    # RSP は今、偽造した TrapFrame を指している —— そのまま trapret へ落ちる
trapret:
    popq %r15            # TrapFrame から全汎用レジスタを pop
    popq %r14
    ... (省略)
    popq %rax
    addq $16, %rsp       # trapno + errcode をスキップ
    iretq                # 「割り込み」から戻る：rip/cs/rflags/rsp/ss を pop
```

つまり**新プロセスの「誕生」は割り込みからの復帰に偽装される**。`iretq` は TrapFrame に丁寧に詰めた `rip`（カーネルスレッドの入口関数）、`cs`、`rflags`、`rsp`、`ss` を pop し、CPU は「割り込みを処理し終えた」と思い込んで、きれいにカーネルスレッド入口から走り出す。

この設計の優雅さは：**全プロセスの入口が「割り込みからの復帰」に統一される**こと。カーネルスレッド（`arch_setup_kthread_tf` が詰める TrapFrame）でも、ユーザーモードプロセス（`arch_setup_user_tf` が `cs=USER_CS` を詰める）でも、違いは TrapFrame 内のいくつかのセグメントレジスタ値だけで、同じ `trapret` 経路を再利用する —— だから `forkret` は自前のコードを一切持たず、fall-through 一つで足りる。

この機構は 2026-04-08 の `exec` サブシステム（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)）で実現された：本記事の初版を書いた時点ではユーザーモードはまだ「将来」だったが、今や `exec` はまさに `arch_setup_user_tf` で TrapFrame の `cs/ss` を `USER_CS/USER_DS` に詰め、ここの fork + `trapret` 経路を再利用し、`iretq` が復元時に RPL=3 を見て自動で ring 3 へ降格させる。**ユーザーモード追加時、本節の機構は一行も変わらなかった**。完全なユーザーモード実行経路は [#18](https://github.com/leafvmaple/blog/issues/18) を参照。

`arch_setup_kthread_tf` / `arch_fixup_fork_tf` / `arch_setup_user_tf` の一組の継ぎ目も「新プロセスの初期トラップフレームがどんな形か」という**純粋にアーキ依存**の事柄を `arch/` に閉じ込めている：`fork` 本体（`kernel/sched/sched.cpp`、完全にアーキ非依存）はそれらを呼ぶだけ。x86 では `rdi/rsi/rflags.IF/cs`、aarch64 では `x0/x1/SPSR/ELR` を詰める —— `fork` は一字も変えない。

---

## 4. スケジューリング：プリエンプション点、環状カーソル、優先度

### 4.1 プリエンプションはどう起きるか

タイマ割り込みは毎 tick で `TaskManager::tick()` を呼び、現プロセスのタイムスライスを 1 減らし、ゼロになれば `need_resched` を立てる。

```cpp
void SchedulerPolicy::tick(TaskStruct* current, TaskStruct* idle) const {
    if (!current || current == idle) return;   // idle はタイムスライスを消費しない
    if (current->time_slice > 0) current->time_slice--;
    if (current->time_slice <= 0) current->need_resched = 1;
}
```

`tick` 自体は**切替しない** —— 割り込みコンテキストでフラグを立てるだけ。実際の切替は安全点で起きる：割り込み復帰の直前、またはメインループ内。idle ループはまさに `arch_idle(); sched::schedule();` を繰り返し、`schedule()` で次に走るべきプロセスを選ぶ。「切ると決める」と「実際に切る」を分けるのは、**割り込みハンドラのスタック上でコンテキストスイッチをしない**ため、スタック意味論の混乱を避けるためです。

### 4.2 環状カーソル：飢餓を避ける最小実装

`pick_next` はプロセスリストで最高優先度の Runnable を探すが、毎回先頭からではなく**前回止まった位置**から走査します。

```cpp
TaskStruct* SchedulerPolicy::pick_next(ListNode& proc_list, TaskStruct* idle) {
    TaskStruct* next = idle;
    int best_prio = sched_prio::IDLE_PRIO + 1;

    if (!sched_cursor || sched_cursor == &proc_list)
        sched_cursor = proc_list.get_next();

    for (auto* node : proc_list.circular_from(sched_cursor)) {   // カーソルから環状に一周
        TaskStruct* p = TaskStruct::from_list_link(node);
        if (p->get_state() == ProcessState::Runnable && p != idle && p->priority < best_prio) {
            next = p;
            best_prio = p->priority;
        }
    }
    if (next != idle)
        sched_cursor = next->list_node.get_next();   // 次回は選ばれた者の次から
    return next;
}
```

`circular_from(cursor)` はリスト上の環状イテレータで、`cursor` から出発して一周し `cursor` に戻る。「選んだら一つ進める」と組み合わせると、**同優先度のプロセスが順番に選ばれる**（round-robin）、リスト順が固定でも前方のプロセスが後方を飢えさせない。優先度は `<` で割り込み —— priority 値が小さいほど高い。Runnable が一つも無ければ `next` は idle のまま。

タイムスライス長自体も優先度に連動します。

```cpp
int SchedulerPolicy::calc_time_slice(int priority) const {
    // 高優先度（値が小）は長いスライス、低優先度は短い
    int slice = BASE_TIMESLICE * (MIN_PRIO + 1 - priority) / (DEFAULT + 1);
    return slice < 1 ? 1 : slice;
}
```

この「優先度が**誰が先に走るか + どれだけ走るか**を決める」形は、プリエンプティブ優先度 round-robin の古典で、Linux O(1) スケジューラ初期の発想と同源、Zonix は最小可用集まで削っただけ。スケジューリング**ポリシー**（`SchedulerPolicy`：誰を選ぶか、スライス長）と**メカニズム**（`TaskManager`：切替、リスト、統計）は別クラス —— CFS 風の赤黒木やマルチレベルフィードバックキューに替えたければ `SchedulerPolicy` を差し替えるだけで、`TaskManager::schedule()` の `pick_next → run` 骨格は不変。これも mini-cocos シリーズで繰り返した「メカニズム/ポリシー分離」だ。

---

## 5. 間違えやすい細部：`current` ポインタの更新タイミング

`TaskStruct::run()` には、重要に見えないが間違えれば死ぬコードがあります。

```cpp
void TaskStruct::run() {
    if (this != current) {
        intr::Guard guard;                  // 切替全体で割り込み無効
        TaskManager::set_current(this);     // ★ current を先に更新、その後 switch_to
        mark_running();
        if (next_cr3 != prev_cr3) arch_load_cr3(next_cr3);   // アドレス空間切替
        arch_switch_rsp0(kernel_stack_ + KSTACK_SIZE);       // TSS.rsp0 切替（割り込み用カーネルスタック）
        switch_to(&prev->context_, &context_);
    }
}
```

`set_current(this)` は `switch_to` の**前**でなければならない。`switch_to` が実行された瞬間、制御フローはこの関数を離れる —— 「戻る」ときには新プロセスが走っており、新プロセスはここに戻って `set_current` を実行しない。CHANGELOG 0.3.0 の "Critical Scheduling Bug" はまさにこの順序を逆に書き（先 switch 後 set）、`current` が常に誤ったプロセスを指していた。さらに `arch_switch_rsp0` —— TSS の `rsp0` を更新し、**次に割り込みが起きたとき CPU が切り替わるのが新プロセス自身のカーネルスタック**であることを保証する（旧プロセスのではなく）。この二つの「切替前に整っていなければならない」状態が、コンテキストスイッチで最も踏みやすい暗黙のタイミングの罠です。

---

## 6. 更新履歴

<!-- スケジューリング / コンテキストスイッチの今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-04-08：本節が述べる fork + `trapret` 機構をユーザーモード実行が再利用 —— `exec` は `arch_setup_user_tf` で同じ経路を通りプロセスを ring 3 へ降格（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)）、§3 の継ぎ目は無変更。完全な経路は新規記事 [#18](https://github.com/leafvmaple/blog/issues/18) を参照。
- 2026-03-23：[`c0c8b1f`](https://github.com/leafvmaple/zonix-plus/commit/c0c8b1f) scheduler/リスト反復を現代化し、`circular_from` 環状カーソルを導入（§4.2 参照）、ドライバ命名も整合。
- 2026-03-13：[`17869d7`](https://github.com/leafvmaple/zonix-plus/commit/17869d7) 同期プリミティブ + プリエンプティブ優先度スケジューリングを追加。スケジューリングが協調的 yield からタイムスライス駆動の `need_resched` へ昇格（§4 参照）。
- 2026-03-12：[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c) GCC→Clang/LLD 移行が `switch_to` の RSP off-by-8 を暴き、修正した（§2 参照）。本記事の核となる物語。

---

*リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本記事は [Zonix OS シリーズ](https://github.com/leafvmaple/blog/issues/11) の一篇。*
