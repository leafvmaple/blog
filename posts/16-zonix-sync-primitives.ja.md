# 単一コアのカーネルでもなぜ spinlock が要るか：Zonix の同期プリミティブのスタック

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`lib/{spinlock,waitqueue,semaphore,mutex,lock_guard}.h` / `sync/*.cpp` / `drivers/intr.h`

Zonix は現在シングルコア（uniprocessor）カーネルですが、一揃いの同期プリミティブを持ちます：Spinlock、WaitQueue、Semaphore、Mutex、`LockGuard<T>`、`intr::Guard`（[`17869d7`](https://github.com/leafvmaple/zonix-plus/commit/17869d7) で一度に導入）。コードレビューの最初の質問はいつも「シングルコアで spinlock 何に使うの？ 取り合う 2 つ目の CPU が無いじゃないか」です。

この質問は核心を突いており、答えがこの記事の主線です：**シングルコアカーネルの並行性は「別の CPU」からではなく「割り込み」から来る。** そしてこのプリミティブ群はちょうどきれいな階層になっている —— 最下層の Spinlock が「割り込みハンドラとの排他」を解き、その上の層が「他プロセスと排他するとき空回りしない」を解く。

---

## 1. Spinlock：それが本当に排他する相手は割り込み、別のコアではない

まず実装。

```cpp
class Spinlock {
    volatile bool locked_{false};
    uint64_t      saved_flags_{};
public:
    void acquire();
    void release();
};

void Spinlock::acquire() {
    uint64_t flags = arch_irq_save();         // ① 現在の割り込み有効状態を保存
    arch_irq_disable();                       // ② 割り込み無効化
    while (__atomic_test_and_set(&locked_, __ATOMIC_ACQUIRE))   // ③ 原子 TAS スピン
        arch_spin_hint();                     //    スピン中 CPU に pause/yield ヒント
    saved_flags_ = flags;                     // ④ 「ロック前の割り込み状態」をロックに保存
}

void Spinlock::release() {
    __atomic_clear(&locked_, __ATOMIC_RELEASE);
    arch_irq_restore(saved_flags_);           // ロック前の割り込み状態へ復元
}
```

これは**二つのことをする**：割り込み無効化 + 原子置位。シングルコアでは第三段の TAS スピンはほぼ常に一発成功する（他コアがロックを持たない）—— よって**シングルコアでの Spinlock の実効作用は第①②段の「割り込み無効化」**です。

なぜ割り込み無効化がそれほど重要か？割り込みハンドラと通常プロセスが**同時にアクセス**するデータ構造、例えばキーボードの入力リングバッファを想像してください。プロセスが `cons` でバッファを読む最中、キーボード割り込みが入ってバッファへ書こうとする。読みかけで割り込みに奪われ、割り込みがバッファポインタを変え、戻ってくると —— データが壊れる。これがシングルコアに実在する並行性で、その根源は割り込みの非同期性であってマルチコアではない。Spinlock の acquire は割り込みを切り、この臨界区を割り込み不可の原子操作に変える。

`saved_flags_` の細部は語る価値があります：それは**ロック前**の割り込み状態を保存し、無脳に「release 時に割り込みを開く」のではない。なぜならロックはネストし得る —— 外側ロックの取得前に割り込みが元々切れていたなら、内側ロックの release で直接 `sti` すると、外側臨界区の中で**割り込みを早すぎるタイミングで開いて**しまい、外側の保護を壊す。「ロック前の状態」を保存しそのまま復元してこそ、ネストした lock/unlock が正しく対になる。これは [#12](https://github.com/leafvmaple/blog/issues/12) の `switch_to` が RSP を正確に保存/復元せねばならないのと同じ「保存-復元は対称に」という規律です。

> では TAS スピンの段はシングルコアで純粋な無駄か？ いいえ。それは**マルチコアのための正しさの継ぎ目**です：いつか SMP にしたとき、Spinlock の意味論は既に正しく（本コア割り込み無効化 + コア間排他）、使っている全箇所を書き直さなくてよい。これも mini-cocos シリーズの「継ぎ目は初日に引く」と同じ教訓 —— `arch_spin_hint()` は既に `pause`/`yield`、TAS は既に acquire/release メモリ順、すべて整い、二つ目のコアを待つだけ。

---

## 2. なぜ「全部 Spinlock」ではダメか：ブロックする操作は眠らねばならない

Spinlock には鉄則があります：**ロック保持中に眠ってはならない、臨界区は極短でなければならない。** 割り込みを切り、他コアを空回りさせ得るからです。しかしカーネルには大量の「長い待ち」がある —— ディスク I/O 待ち、セマフォ待ち、別プロセスのリソース解放待ち。これらを Spinlock で死に待ちはできない：割り込みを切って数ミリ秒空回りすれば、タイマ割り込みが入れず、スケジューラが停止し、システム全体がフリーズする。

よって第二のプリミティブが要る：**待てないなら自分をサスペンドし CPU を譲り、条件が満たされたら起こされる**。これが WaitQueue。

```cpp
void WaitQueue::sleep() {
    Entry entry;                       // ★ Entry は呼び出し側のスタックに直接置く、割り当てゼロ
    entry.task = sched::current();
    {
        LockGuard<Spinlock> guard(lock_);   // spinlock でキューのこの一瞬を保護
        head_.add_before(entry.node);       // 自分を待ちキューへ挂ける
        entry.task->sleep();                // 現プロセスを Sleeping に印付け
    }                                       // ← spinlock はここで解放（割り込み開く）
    sched::schedule();                      // CPU を譲る；起こされてからここへ戻る
    {
        LockGuard<Spinlock> guard(lock_);
        entry.node.unlink();                // 目覚めたらキューから自分を外す
    }
}

void WaitQueue::wakeup_one() {
    LockGuard<Spinlock> guard(lock_);
    if (head_.empty()) return;
    Entry* e = Entry::from_node(head_.get_next());
    e->node.unlink();
    e->task->wakeup();                      // 先頭プロセスを Runnable へ戻す
}
```

ここに二つの美点があります。

- **Entry はスタックに置く。** 待ちノード `Entry{task, node}` は `sleep()` のローカル変数で、**眠っているそのプロセスのカーネルスタック**に住む。睡眠中このスタックは回収されないのでノードは有効であり続け、目覚めて unlink するとスタックフレームと共に自然消滅する。**睡眠/起床経路全体がヒープ割り当てゼロ** —— これはカーネルで極めて重要、睡眠経路はしばしばまさに「メモリ逼迫だから待つ」経路であり、そこで `kmalloc` すると失敗、最悪は再帰的にページフォルトを誘発し得る。これも [#13](https://github.com/leafvmaple/blog/issues/13) で強調した「カーネルデータ構造は侵入型/スタック上ノードを使い、クリティカルパスで malloc しない」。
- **Spinlock はキュー操作の一瞬だけ保護し、`schedule()` を覆わない。** キューへ挂ける・Sleeping 印付けは spinlock（割り込み無効）内で行うが、実際に CPU を譲る `schedule()` はロック外。さもないと「spinlock 保持中に眠らない」鉄則を破る —— 割り込みを切った状態で別プロセスへ切り替えてはならない。

---

## 3. Semaphore / Mutex：二種のロックを組み合わせる

Spinlock（短臨界区を保護）と WaitQueue（長待ちサスペンド）があれば、セマフォと互斥ロックはこの二つの**組み合わせ** —— Spinlock で自分のカウント/保持状態を保護し、WaitQueue で実際のブロックを担う。

```cpp
void Semaphore::down() {
    while (true) {
        {
            LockGuard<Spinlock> guard(lock_);
            if (count_ > 0) { count_--; return; }   // 空きあり：一つ取って去る
        }                                            // ← 空き無し：先に spinlock を放す
        waitq_.sleep();                              // それから眠る（spinlock を持ったまま眠らない）
    }
}

void Semaphore::up() {
    { LockGuard<Spinlock> guard(lock_); count_++; }
    waitq_.wakeup_one();                             // 空きを足したら待機者を一人起こす
}
```

Mutex はほぼ同型、「カウント」を「保持フラグ + owner」に替え、unlock 時に保持者だけが解錠できると assert します。

```cpp
void Mutex::unlock() {
    {
        LockGuard<Spinlock> guard(spin_);
        assert(held_ && owner_ == sched::current());  // owner だけが解錠可、さもなくば論理バグ
        held_ = false; owner_ = nullptr;
    }
    waitq_.wakeup_one();
}
```

この `owner_` assert は Mutex が Semaphore より多く持つ意味論です：セマフォは「割当」（誰でも up でき、A が取った空きを B が返せる）、互斥ロックは「所有権」（A がロックしたものは A が解く）。この規則を注釈ではなく `assert` にすることで、「誤ったプロセスで unlock する」バグが開発期にその場で爆発し、こっそり状態を壊さない。

---

## 4. 正直に向き合うべき細部：lost wakeup

上の `Semaphore::down()` には、並行性で最も古典的な罠が潜んでいます。これを開いて語りたい —— それこそが「並行性を書けるか」の分水嶺だからです。

このタイミング窓を見てください。

```
プロセス A は down() 内：
  { lock_ 保持; count_ == 0 を発見; }   ← lock_ 解放
  ←──────── 窓：今 A はまだ waitq_.sleep() に入っていない ────────→
                                    プロセス/割り込み B が up() を呼ぶ:
                                      { lock_ 保持; count_++; }  count_ は 1 に
                                      waitq_.wakeup_one();     キューは空！何も起こされない
  waitq_.sleep();                   ← A は今眠った、だが count_ は明らかに > 0、しかも誰も起こさない
```

問題の根源：**「条件チェック」と「待ちキューへ挂ける」が同じロック・同じ原子区間ではない**。`count_` のチェックは Semaphore の `lock_` 下、キュー挂けは WaitQueue 自身の `lock_` 下、両者の間に隙間がある。起床信号がちょうど隙間に落ちると、失われる。

本番カーネルはこの隙間をどう閉じるか？古典的な答えは **condition variable 式の「原子的にロック解放 + 睡眠」**：条件を保護するロックを「待ちキューへ登録済み」になるまで持ち続け、それを睡眠の一部として原子的に解放する（Linux の `prepare_to_wait()` は先に入队してから条件をチェック、`wait_event()` マクロは「チェック—入队—睡眠」を起床漏れの無いループに包む；pthread の `cond_wait(cond, mutex)` は mutex を渡して原子解放させる）。核心はすべて**「最後の条件チェック」と「睡眠突入」の間に起床信号が通れる窓を存在させない**こと。

> この節を単独で取り上げたのは、Zonix のここがどれほど完璧だからではなく —— むしろ逆で、**現在の実装の `down()` はプリエンプティブスケジューリング下でこの窓を持つ**、動いているのは大部分シングルコア + 一部経路の割り込みタイミングの「運」に依存している。ありのまま書くのは：
>
> 1. **既知の並行性欠陥を認める方が、無いふりより専門的。** 面接では「ここに lost-wakeup 窓があり、正しい修正は条件チェックと入队を同一原子区間に収めること」と言いたい、無欠を装うより。
> 2. それは同期プリミティブ設計で**最も難しい 5%** を正確に指す：プリミティブは書きやすいが、「チェック—入队—睡眠」三段の原子性こそ真の難点。WaitQueue が `sleep()` を提供するだけでは足りず、呼び出し側が「条件チェック」を入队と睡眠の間に挟める接口（`prepare_to_wait` 相当）を提供せねばならない。これが Zonix 同期層の次に引く継ぎ目です。

既知の問題・その根因・業界標準解の三つを明確に語る方が、「バグが無さそうに見える」コードを出すより、真の工学能力に近い。

---

## 5. `LockGuard<T>` と `intr::Guard`：RAII で全「対操作」を締める

最後の層は「acquire/release は対でなければならない」をコンパイラに任せること。`LockGuard<T>` は一行テンプレートで、`acquire()`/`release()` を持つ任意の型に効きます。

```cpp
template<typename T>
class LockGuard {
    T& ref_;
public:
    explicit LockGuard(T& l) : ref_(l) { ref_.acquire(); }
    ~LockGuard() { ref_.release(); }                       // スコープ終了で自動解放、例外/早期 return 経路も含む
    LockGuard(const LockGuard&) = delete;                  // コピー不可、二重 release を防ぐ
};
```

Mutex も `LockGuard` に入れられるよう、わざわざ `acquire()`/`release()` を `lock()`/`unlock()` の別名として提供 —— 小さな適配で、「任意のロック」を同一 RAII テンプレートに統一する。これこそ [#17](https://github.com/leafvmaple/blog/issues/17) で語る「freestanding カーネルでもテンプレートと RAII は使える」の代表：`LockGuard<T>` は実行時コストゼロながら、「ある早期 return 経路で release を忘れる」バグ一群を消滅させる。

`intr::Guard` は同じパターンの特例 —— 守るのはロックではなく割り込み状態です。

```cpp
{
    intr::Guard guard;       // 構築：割り込みを保存して無効化
    // ... 割り込みに中断されたくない臨界区 ...
}                            // 破棄：入る前の割り込み状態へ復元
```

スケジューラの `TaskStruct::run()`、`fork()`、`exit()` はすべて `intr::Guard` でコンテキストスイッチ・リスト変更などの「割り込みに切られてはならない」断片を囲む（[#12 §5](https://github.com/leafvmaple/blog/issues/12) 参照）。**「対になる危険操作」—— lock/unlock、割り込み無効/有効、push/pop —— は Zonix ではほぼ一律 RAII で守る**、誤対の代償（デッドロック、割り込み状態リーク）が極めて追いにくく、RAII が「対にする」ことを「人が書き忘れない」から「コンパイラが保証」へ変えるからです。

---

## 6. スタック全体の依存関係

```
intr::Guard ─┐                          (「割り込み無効」区間の RAII ラッパー)
LockGuard<T> ─┴─► acquire/release を持つ任意の型
                                          ▲
Spinlock ──────► 割り込み無効 + 原子 TAS    │ 組み合わされる
   ▲                                      │
   │ 短臨界区を保護                         │
WaitQueue ─────► 侵入型キュー + sleep/schedule/wakeup
   ▲
   │ 長ブロックを担う
Semaphore / Mutex ─► count / owner + Spinlock + WaitQueue
```

この図の読み方：**Spinlock は唯一ビジーウェイトするプリミティブで、「ブロックする」もの全ては Spinlock（自身の状態を保護する短臨界区）+ WaitQueue（実際のサスペンド）の上に建つ。** この階層は見た目のためではなく —— 「割り込みとの排他」（Spinlock の職責）と「プロセスとの排他」（Semaphore/Mutex の職責）という本質的に異なる二つの並行性問題を、代償の異なる二つの機構で別々に解き、一つのロックで天下を取らない。

---

## 7. 更新履歴

<!-- 同期プリミティブの今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-02-12：[`17869d7`](https://github.com/leafvmaple/zonix-plus/commit/17869d7) 一揃いの同期プリミティブ（Spinlock / WaitQueue / Semaphore / Mutex / `LockGuard<T>`）+ プリエンプティブ優先度スケジューリングを一度に導入。本記事の階層構造はここで成立。
- **TODO**：WaitQueue に `prepare_to_wait` 風の接口を補い、§4 で述べた `Semaphore::down()` の lost-wakeup 窓を閉じる —— 「条件チェック + 入队」を同一原子区間に収める。これは同期層の既知の、次に引くべき継ぎ目。

---

*本記事は [Zonix OS 設計振り返り](https://github.com/leafvmaple/blog/issues/11) シリーズの詳細記事です。他の記事は振り返り本編末尾のインデックスから。*
