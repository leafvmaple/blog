# 侵入型リスト：カーネルではリストノードはほぼ単独で malloc されない

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`kernel/lib/list.h` / `Page` / `TaskStruct` / `MemoryDesc` / `WaitQueue`

```text
$ grep -rE 'ListNode [a-z_]+\{\}' kernel/ include/ | wc -l
10+                              # ListNode フィールドを埋め込んだ箇所（テスト除く）
$ wc -l kernel/lib/list.h
145                              # 侵入型リスト実装全体：145 行の C++17
$ grep -rEh 'unlink\(\)|add_before|add_after|circular_from|reversed\(\)' kernel/ | wc -l
96                               # リスト操作の呼び出し点
```

各 `Page`（PMM 空きページチェーン）、各 `TaskStruct`（プロセスチェーン / ハッシュチェーン / 親子チェーンの 3 本）、各 `MemoryDesc`（VMA チェーン + swap 候補キュー）、各 `WaitQueue::Entry` —— zonix で「あるチェーンに繋がれる必要のある」オブジェクトはすべて `ListNode` フィールドを自前で持つ。機構全体は 145 行で実装、96 箇所で呼ばれ、**そのいかなる `kmalloc` もリストノード自体のためではない**。

Linux 風カーネルを書いて侵入型リストを語らないのは、OS を語って페이지테이블を語らないようなものだ。本記事は四つを述べる：§1 カーネルでリストノードに malloc してはならない理由、§2 zonix の `ListNode` の姿（2 つのポインタ + 自己参照 sentinel + テンプレート `container<T>()`）、§3 現代 C++ がそれにもたらすいくつかのアップグレード（`constexpr` オフセット、テンプレートイテレータ、range-based for、circular ビュー）、§4 zonix での実落地、§5 これから進める方向。

---

## 1. カーネルでリストノードに malloc してはならない理由

教科書的な `std::list<T>` は `push_back` のたびに `__list_node` をヒープ確保する。ユーザー空間ではこれは ~100 ns の話で許容される。カーネルでは地雷だ：

- **ページフォルト経路で malloc できない**。`vmm::pg_fault`（[#13](https://github.com/leafvmaple/blog/issues/13) 参照）が発生した瞬間に `kmalloc` でリストノードを取りに行くと（例：victim ページをある FIFO に戻すため）、kmalloc 内部で kheap 拡張が必要になり → またフォルト → 無限再帰 → triple fault。Linux は `GFP_ATOMIC` + mempool で緩和；zonix は「繋ぐときに確保しない」を直接選ぶ：swap FIFO に繋ぐのは `Page::list_node`、物理ページ自体は既に存在しているので確保ゼロ。
- **割り込みコンテキストで malloc できない**。割り込みハンドラのスタックは浅く、`kmalloc` 内部にはロックがあり、sleep し得る。WaitQueue の sleep 経路（§4 参照）はスタック上の `Entry` を使い、確保しない。
- **起動早期に malloc できない**。PMM がまだ整っていない時期から空きページチェーンは既に動いている。free list ノードは `Page` 構造体自身に居なければならない。

侵入型（intrusive）の本質：**リストノード = 繋がれるオブジェクト自身のフィールド、繋ぎ・外しに一切の確保が絡まない**。代償はオブジェクトが同時に固定数のチェーンにしか入れないこと —— チェーン 1 本につき `ListNode` フィールドを 1 つ埋め込む必要がある。`TaskStruct` は同時に process list、PID ハッシュバケット、親の child list に繋がる必要があるので、`ListNode` を 3 つ埋め込んでいる。「参加する各チェーンに専用のフィールドを用意する」書き方は Linux で常識 —— `task_struct` に十数個の `list_head` があるのは冗長ではなく設計スタイルだ。

---

## 2. zonix の `ListNode`：2 つのポインタ + テンプレート `container<T>()`

`kernel/lib/list.h` 145 行の核：

```cpp
struct ListNode {
    ListNode* prev{};
    ListNode* next{};

    ListNode() { prev = next = this; }   // 自己参照 sentinel：empty list のマーク

    inline void add_before(ListNode& elm) {
        elm.prev = prev;
        elm.next = this;
        prev->next = &elm;
        prev = &elm;
    }

    inline void add_after(ListNode& elm) { /* 対称 */ }
    inline void unlink() const { prev->next = next; next->prev = prev; }
    [[nodiscard]] inline bool empty() const { return next == this; }

    template<typename T>
    [[nodiscard]] inline T* container() const {
        return reinterpret_cast<T*>(reinterpret_cast<uintptr_t>(this) - T::node_offset());
    }
};
```

設計上の重要点が 2 つ：

- **自己参照 sentinel**：デフォルトコンストラクタが `prev = next = this` にし、`empty()` は `next == this` だけで済む。これで nullptr チェックが至る所に散らばらず、`add` / `unlink` 経路上のポインタ参照は常に well-defined。Linux の `LIST_HEAD_INIT` も同じ設計。
- **テンプレート化された `container<T>()`**：ノードポインタから宿主オブジェクトポインタを逆算。Linux の対応物は有名な `container_of` マクロで、`offsetof(struct, member)` に依存。zonix はテンプレート + `T::node_offset()` でこれを本物の C++ メソッドとして書く —— マクロではなく、オーバーロード解決に参加し、型推論を支持し、IDE でジャンプできる。

`T::node_offset()` はどう計算するか？`Page` を見る：

```cpp
// kernel/mm/pmm.h
struct Page {
    int ref{};
    uint32_t flags{};
    unsigned int property{};
    ListNode list_node{};

    [[nodiscard]] ListNode& node() { return list_node; }
    static constexpr size_t node_offset() { return offset_of(&Page::list_node); }
};
```

`offset_of` は `include/base/types.h`：

```cpp
template<typename T, typename M>
constexpr size_t offset_of(M T::* member) {
    return reinterpret_cast<size_t>(&(static_cast<T*>(nullptr)->*member));
}
```

メンバポインタ + `nullptr` 上でのオフセット計算。`constexpr` がコンパイル時解決を保証 —— **`Page::node_offset()` は最終 `.o` の中で即値であり、ランタイム関数呼び出しではない**。だから `node->container<Page>()` は展開後 `(Page*)((uintptr_t)node - 16)` のような即値減算と等価。

これが Linux の `container_of` マクロより現代 C++ が勝る第一点：**型安全 + コンパイル時定数保証、しかもプリプロセッサ名前空間を汚染しない**。

---

## 3. 現代 C++ が侵入型リストにもたらすいくつかのアップグレード

145 行のうち 30+ 行はイテレータ専用。Linux のリストは `list_for_each_entry(pos, head, member)` マクロで、C 風味が強い；zonix は直接標準 C++ イテレータプロトコルを行く：

```cpp
template<typename NodePtr, bool Reverse = false>
struct Iterator {
    NodePtr cur{};
    NodePtr operator*() const { return cur; }
    Iterator& operator++() {
        if constexpr (Reverse) cur = cur->prev;
        else                   cur = cur->next;
        return *this;
    }
    bool operator==(const Iterator& other) const { return cur == other.cur; }
    bool operator!=(const Iterator& other) const { return cur != other.cur; }
};
```

`if constexpr` で正方向 / 逆方向イテレータが同じテンプレートを共有し、**コンパイル時分岐**が消える —— 逆方向イテレータは最終コードで実行時判定が一切なく、純粋に `cur = cur->prev`。これは C++17 `if constexpr` のカーネルでの稀少な好例：コンパイル時多態がコード重複を置き換える。

`ListNode` 自身が `begin()` / `end()` を持つので、range-based for が直接走る：

```cpp
for (auto* node : proc_list) {                          // 正方向走査
    TaskStruct* p = TaskStruct::from_list_link(node);
    ...
}

for (auto* node : proc_list.reversed()) {               // 逆方向：reverse_view を返す
    ...
}

for (auto* node : proc_list.circular_from(cursor)) {    // スケジューラのカーソル：cursor から一周
    ...
}
```

`circular_from(cursor)` は zonix スケジューラ（[#12 §4.2](https://github.com/leafvmaple/blog/issues/12) 参照）の核：カーソル位置から出発して一周し起点に戻る、「選んだら一つ進める」と組み合わせて同優先度 round-robin を実現し、前方プロセスが後方を飢えさせない。Linux で類似概念は `for_each_process_thread` 等いくつかのマクロに散在；zonix はそれをイテレータという 1 つの抽象点に収め、呼び出し側は通常コンテナの走査と区別しなくて済む。

`[[nodiscard]]` はもう 1 つの小さいが重要なアップグレード：

```cpp
[[nodiscard]] inline bool empty() const { return next == this; }
[[nodiscard]] reverse_view reversed() { return reverse_view{this}; }
[[nodiscard]] circular_view circular_from(ListNode* start) { ... }
```

`head_.empty();` と書いて戻り値を捨てる —— コンパイル時警告。裸の C カーネルではコメントでしか表現できないことが、C++17 以降コンパイル時チェックになる。WaitQueue の `wakeup_one` の 1 行目は `if (head_.empty()) return;` —— この戻り値のチェックを忘れた瞬間にレースになる。

---

## 4. zonix での `ListNode` の実落地

| サブシステム | 埋め込みフィールド | チェーンヘッド | 備考 |
|---|---|---|---|
| PMM first-fit | `Page::list_node` | `FreeArea::free_list` | 物理ページ空きリスト；「ブロックサイズ」は `Page::property` に |
| スケジューラ | `TaskStruct::list_node` | `TaskStruct::s_proc_list`（static） | グローバルプロセスリスト + スケジュールカーソル |
| プロセス親子木 | `TaskStruct::child_node` | `TaskStruct::child_list`（親ごとに 1 つ） | fork 関係 |
| プロセスハッシュ | `TaskStruct::hash_node` | PID ハッシュバケット | O(1) の `find_by_pid` |
| VMM | `MemoryDesc::mmap_list` | 同名 head | VMA を開始アドレス順にチェーン |
| swap FIFO | `Page::list_node`（再利用） | `MemoryDesc::swap_list` | 下で詳述 |
| WaitQueue | スタック上 `Entry::node` | `WaitQueue::head_` | 鍵：Entry は `sleep()` のスタックフレーム上のローカル変数 |

**WaitQueue のスタック上 Entry パターン**は特筆に値する：

```cpp
// kernel/sync/waitqueue.cpp
void WaitQueue::sleep() {
    Entry entry;                                    // スタック確保
    entry.task = sched::current();
    {
        LockGuard<Spinlock> guard(lock_);
        head_.add_before(entry.node);               // 繋ぐ
        entry.task->sleep();
    }
    sched::schedule();                              // ブロック、切り出される
    {
        LockGuard<Spinlock> guard(lock_);
        entry.node.unlink();                        // 目覚めたらチェーンから外す
    }
}
```

`Entry` は完全に `sleep()` のスタックフレーム内 —— プロセスが切り出されるとき、スタックはレジスタと共に `switch_to`（[#12](https://github.com/leafvmaple/blog/issues/12) 参照）に保存され、目覚めたらスタックが完全復元、`entry.node` は同じメモリを指したまま。**待機プリミティブ全体でヒープ確保ゼロ**。この書き方はユーザー空間で `std::condition_variable` を使っても不可能だ（ユーザースレッド切り替えは任意サイズのスタックフレームを保持しない + アドレスを精密に保持しない）。

**`Page::list_node` が PMM free list と swap FIFO で再利用される**ことも語る価値がある：物理ページは同時に 1 つの状態にしかいられない（空きプール / 確保済み swappable / 確保済み pinned）、2 本のチェーンに同時に繋がれることはない。これはカーネルレベルの discriminated union で、`ListNode` フィールドを 1 つ節約する（16 バイト × システム総ページ数、数 MB の物理メモリでも数十 KB の累積節約）。Linux も同じ手法 —— `struct page` の `lru` メンバが page cache LRU / SLUB freelist / migration list に同時に再利用される。

---

## 5. これから進める方向

この実装は zonix の現用法をすべて支えられるが、modern C++ がさらに推進できる方向がいくつかある：

**1. C++20 `concepts` で `container<T>()` の T を制約する**。現在の `container<T>()` は T に制約が無く、`T::node_offset()` を持たない型を渡すとテンプレート展開で大量のエラーが出る。C++20 では：

```cpp
template<typename T>
concept HasNodeOffset = requires { { T::node_offset() } -> std::convertible_to<size_t>; };

template<HasNodeOffset T>
[[nodiscard]] inline T* container() const { ... }
```

エラーメッセージが直接「T が HasNodeOffset を満たさない」となり、300 行のテンプレート展開ではなくなる。

**2. Hash list（`hlist`）を独立に抽出**。`TaskStruct` は同時に `list_node`（双方向）と `hash_node` を持つ。ハッシュバケットは head 端で単方向リスト + entry 端で prev ポインタ（O(1) 削除を保つ）だけが必要で、Linux はそのために `hlist_head` / `hlist_node` を定義し head 端を 8 バイト（16 ではなく）にしている。zonix は今ハッシュバケットの head も完全な `ListNode`（16 バイト）、N 個のバケットで 8N バイト余計に使う。大きくはないが、`hlist` を抽出すればハッシュテーブルのキャッシュライン利用率が改善する。

**3. 型安全 `ListHead<T>`**。`ListNode head_{};` + `T::from_list_link()` で宿主を逆算 —— 型情報が失われる。次のように包める：

```cpp
template<typename T, ListNode T::* member>
class List {
public:
    void push_back(T& obj) { head_.add_before(obj.*member); }
    TypedIter<T> begin() { ... }   // 直接 T* を返す
    [[nodiscard]] bool empty() const { return head_.empty(); }
private:
    ListNode head_{};
};

// 使い方：
List<TaskStruct, &TaskStruct::list_node> proc_list;
for (TaskStruct* t : proc_list) { ... }   // 手動 from_list_link が不要
```

呼び出し側はもはや `ListNode* node` を書けず、常に正しい型の `T*` を得る。代償はテンプレート引数がやや重いこと；得るのは IDE が `T*` を直接表示すること、誤用がより早くコンパイル時に捕まること。

**4. C++23 `deducing this` でイテレータを簡素化**。C++23 の explicit `this` で const / non-const イテレータがコードを共有できる：

```cpp
template<typename Self>
auto&& operator*(this Self&& self) { return *self.cur; }
```

現在の `Iterator` テンプレートは既に十分綺麗だが、view 型（`ReverseView` / `CircularView`）の const-correctness をさらに簡素化できる。

**5. Lock-free intrusive list（atomic CAS）**。zonix が本当に SMP に上がるとき、PMM free list のように複数 CPU で高頻度に争われるチェーン構造は lock-free 版が必要になる。`std::atomic<ListNode*>` + CAS 双方向リストは有名な ABA 問題を持つ；Linux の RCU list / `llist`（単方向 lock-free）から借用できる。これは SMP ロードマップ上のことで、ヒントとしてここに記す。

**6. デバッガ親和性**。裸の `ListNode* prev; ListNode* next;` は GDB でジェネリック情報を持たず、手動で `(TaskStruct*)((char*)node - offsetof(...))` する必要がある。GDB python pretty-printer を追加して `p proc_list` を直接 `TaskStruct*` リストへ展開できる。これは工程ツールでありコード変更ではないが、スタックリーディングのコストを著しく下げる。

---

侵入型リストはカーネルデータ構造の「漢字」だ —— 書けなければ実用カーネルはまず書けない。`std::list` / `std::vector` はユーザー空間で輝いても、ページフォルトハンドラ / 割り込み処理 / 起動早期に来れば死の罠だ。`container_of` マクロは C カーネルで 30+ 年走ってきた；現代 C++ がそれにもたらすアップグレード（`constexpr` オフセット、テンプレートイテレータ、`[[nodiscard]]`、C++20 concepts）は抽象能力を見せびらかすためではなく、「人が覚えている」ことを「コンパイラが保証する」ことに変えるためだ。

---

## 6. 更新履歴

<!-- list / データ構造層の今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-03-23：[`c0c8b1f`](https://github.com/leafvmaple/zonix-plus/commit/c0c8b1f) list イテレータを現代化し、`Iterator` / `ReverseView` / `CircularIterator` を導入、スケジューラのカーソルを `circular_from` に切り替え（§3、§4 参照）。
- 2026-03-04：[`7138771`](https://github.com/leafvmaple/zonix-plus/commit/7138771) カーネル基礎ライブラリを `lib/` に整理、`list.h` が現在のパスに入る。

---

*リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本記事は [Zonix OS シリーズ](https://github.com/leafvmaple/blog/issues/11) の一篇。*
