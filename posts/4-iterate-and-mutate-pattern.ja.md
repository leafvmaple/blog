# 走査中に自分を erase する：iterator 無効化のバグは週 1 回しか表に出ない

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`Scheduler` / `EventDispatcher`、および「走査中に変更され得る」全てのシステム

このパターンは mini-cocos の 3 つの独立サブシステムで同じ形で現れる：

```
$ wc -l src/base/ZCScheduler.cpp src/base/ZCActionManager.cpp src/base/ZCEventDispatcher.cpp
  232 src/base/ZCScheduler.cpp
  167 src/base/ZCActionManager.cpp
  394 src/base/ZCEventDispatcher.cpp
  793 total
$ grep -rE "_pending|_inDispatch|_dirty.*Priority" src/base/ZCScheduler.cpp \
                                                   src/base/ZCActionManager.cpp \
                                                   src/base/ZCEventDispatcher.* | wc -l
30+                         # 3 サブシステムで pending + tombstone + dirty フラグの同型実装
```

特徴は「言語／フレームワーク非依存・出現頻度高・誤りの症状が極めて隠蔽的」の 3 条件を全て満たすこと。本稿は `Scheduler` / `ActionManager` / `EventDispatcher` から抽出して、いつ使うか・どう実装するか・どんなアンチパターンがあるかを整理する。

## 1. 問題の本体：イテレータ無効化と「自噬」

最も典型的なバージョンは Scheduler：

```cpp
void Scheduler::update(float dt) {
    for (auto& e : _entries) {
        if (!e.cancelled) e.callback(dt);   // ユーザコールバック
    }
}
```

callback の中で `schedule(...)` や `unschedule(...)` を呼ぶのは完全に合法 —— ただし `_entries` に対する `push_back` か `erase` が走り、**現在実行中の for ループのイテレータが即座に無効化** されます。

- `push_back` で vector の reallocation → ループ中の `&e` 全てがダングリングポインタ。
- 現在指している entry に対する `erase` → UAF。
- キュー中段の entry を `erase` → 後続走査が 1 つスキップ。

この種のバグは **症状が不安定**：メモリ余裕時は reallocation 確率低、スキップは無関係 entry にちょうどヒットすることも。本番で週 1 回しか落ちないタイプ。

EventDispatcher は完全に同型、ただしトリガーパスがもう 1 層多い（listener が自身のイベントコールバック内で add/remove listener する）。

## 2. 三点セット解法

cocos2d-x はこの種のシステムを全て下記三点セットに収束させ、mini-cocos はそれをまるごと継承しました：

### 2.1 Pending queue：新規操作は次ターンに遅延

```cpp
struct Scheduler {
    std::vector<Entry> _entries;          // 走査中のメインキュー
    std::vector<Entry> _pendingAdds;      // 本ターン新規、次ターンで flush
    bool               _isUpdating = false;
};

void Scheduler::schedule(Entry e) {
    if (_isUpdating) {
        _pendingAdds.push_back(std::move(e));   // メインキューに触らない
    } else {
        _entries.push_back(std::move(e));
    }
}
```

`_pendingAdds` は毎フレーム update の **冒頭** または **末尾** で `_entries` に flush。これで update 期間中、メインキューのポインタ／イテレータは常に安定。

flush タイミングの 2 択：
- **冒頭 flush**：新規登録 entry がそのフレームで 1 回走る。「即時反映」意味論向き（フレーム N で onUpdate 登録）。
- **末尾 flush**：新規登録 entry は次フレームから。「登録時の副作用」回避向き。

mini-cocos は **末尾 flush** 採用。理由：「登録行為は同フレーム内で副作用を起こすべきでない」—— デバッグに優しい（callback 内で再 schedule しても副作用は最低 1 フレーム後にしか拡大しない）。

### 2.2 ソフト削除：cancelled フラグ

```cpp
void Scheduler::unschedule(Handle h) {
    if (auto* e = find(h)) e->cancelled = true;
}
```

注意：**`erase` 無し**、bool を 1 つ反転するだけ。実際の erase は update 後の sweep フェーズに残す：

```cpp
void Scheduler::update(float dt) {
    _isUpdating = true;
    for (auto& e : _entries) {
        if (!e.cancelled) e.callback(dt);
    }
    _isUpdating = false;

    std::erase_if(_entries, [](const Entry& e){ return e.cancelled; });
    if (!_pendingAdds.empty()) {
        std::move(_pendingAdds.begin(), _pendingAdds.end(), std::back_inserter(_entries));
        _pendingAdds.clear();
        _dirtyOrder = true;
    }
}
```

ソフト削除には隠れた利点が 2 つ：
- callback 内で自分を unschedule → bool 反転のみ、現走査に影響なし。
- callback 内で他者を unschedule → 他者の bool 反転、本フレームでその他者の callback は `if (!e.cancelled)` で弾かれ、**呼ばれない**、しかし走査も壊れない。

`std::erase_if` は erase-remove より錯誤の機会が 1 つ減る（`v.end()` 忘れない）。これは後の小コミット（主記事 §11.2）で置換した部分。

### 2.3 Dirty ソート：dirty flag、1 フレーム 1 回だけソート

```cpp
struct Scheduler {
    bool _dirtyOrder = false;
};

void Scheduler::schedule(Entry e) {
    // ...
    _dirtyOrder = true;
}

void Scheduler::update(float dt) {
    if (_dirtyOrder) {
        std::stable_sort(_entries.begin(), _entries.end(),
                         [](auto& a, auto& b){ return a.priority < b.priority; });
        _dirtyOrder = false;
    }
    // ... 然る後に走査
}
```

毎回 schedule / unschedule で bool 反転だけ、**実際のソートは次の update 冒頭で一括**。1 フレーム内の複数登録を 1 回のソートにマージし、登録ごとの O(n log n) を回避。

`stable_sort` は適当な選択ではない：同 priority entry は登録順を保つ必要がある。さもないと同 priority listener の呼び出し順がフレーム毎にブレ、下流バグが再現しなくなる。

## 3. EventDispatcher は同型問題、ただし 1 次元多い

EventDispatcher の複雑性は **独立した 2 本の優先度チェーン**（fixed priority + scene-graph priority）にありますが、各チェーン上の三点セットは全く同じ：

```cpp
struct EventListenerVector {
    std::vector<ListenerEntry> _fixedListeners;
    std::vector<ListenerEntry> _nodeListeners;
    std::vector<ListenerEntry> _toAdd;          // pending
    bool _dirtyFixed = false;
    bool _dirtyNode  = false;
    int  _inDispatch = 0;                       // ネスト dispatch カウンタ
};
```

`_inDispatch` が bool ではなくカウンタなのに注意 —— イベントは **ネスト派遣** され得るから（あるイベントの listener 内部から別イベントを dispatch）。全ネストが戻り、`_inDispatch == 0` になって初めて、ソフト削除項の sweep と pending の flush を許容する。

この意味論はそのまま移植してよく、再発明不要。EventDispatcher の詳細設計は本シリーズのイベント篇（issue #5）参照。

## 4. 適用範囲：エンジンに留まらない

抽出してみると、このパターンは非常に多くの場所で同型を発見できます：

| 領域 | 同型シナリオ |
|---|---|
| ECS | システム update 中の entity spawn/destroy；典型実装 `commands.queue()` 遅延実行（Bevy / EnTT 双方ある） |
| サーバ tick loop | 心拍走査中のプレイヤー切断／参加；全て pending join queue + pending leave set |
| UI フレームワーク | layout pass 中の invalidate；React reconciler は明示的に「update queue」を次 tick に遅延 |
| OS カーネル | RCU（read-copy-update）は本質的にソフト削除 + grace period 後の真削除 |
| GC | mark-sweep の mark 中は free できない、全 mark 完了後に |

「**走査中にコンテナを変更し得て、変更主体が callback 自身でもあり得る**」全システムが、この構造に進化します。汎用ツールとして身に付ければ、新規スケジューラ系を書くのはほぼ筋肉記憶。

## 5. よくあるアンチパターン

何度か書いた後、「正しそうに見えて実は誤り」の単純化を幾つかまとめられる：

### アンチパターン A：`std::list` で問題を消したフリ

「リスト erase は他のイテレータを無効化しないからループ内で erase OK」—— 半分正解。`list::erase` は他ノードに影響しないが：
- ループ内で現ノード erase は next を先に保存する必要があり、書き方が歪。
- ループ内 `push_back` は次のターン **走査する**、「登録直後に即 1 回走る」を引き起こす、しばしば予想外。
- list の cache miss は vector より顕著、毎フレーム O(n) 走査には不利。

ソフト削除 + pending queue を vector でやる方が安定で速い。

### アンチパターン B：コピーしてから走査

```cpp
auto snapshot = _entries;
for (auto& e : snapshot) e.callback(dt);
```

確かに安全ですが：
- 毎フレーム vector コピーが余計、数百 listener では不利。
- callback が見る `e` は snapshot の要素なので、entry の内部状態への変更が同期されない。これはイテレータ無効化より隠れがちなバグ。

### アンチパターン C：メインループの再帰呼び出し

EventDispatcher のネスト dispatch で `_inDispatch` カウンタを使わず、単純な bool `_isDispatching` で切り替える → ネスト dispatch が戻ると内側の `_isDispatching = false` が外側のフラグも消してしまう → sweep が早期実行 → 外側ループが走査中の entry が突然 erase される。**カウンタで bool を置換** が、この種のネスト場面に対する汎用解。

### アンチパターン D：sweep を unschedule に前倒し

「sweep するなら unschedule で即 erase すれば？」—— **unschedule が update 内部から呼ばれているか分からない** から。もし内部なら、最初のイテレータ無効化問題に逆戻り。各 mutator API で `if (_isUpdating)` 分岐するか、いっそ update 末尾に統一する。後者の方がコード量も少なく、誤りの面も小さい。

## 6. 実装テンプレート

下記の最小骨格は、その後「走査中変更され得る」新システムを書く時に毎回そのままコピペしています：

```cpp
template <class Entry>
class TickSystem {
public:
    using Handle = std::size_t;

    Handle add(Entry e) {
        e.id = _nextId++;
        if (_inUpdate > 0) _pending.push_back(std::move(e));
        else { _entries.push_back(std::move(e)); _dirty = true; }
        return _entries.back().id;
    }

    void remove(Handle h) {
        auto markCancelled = [&](auto& v) {
            for (auto& e : v) if (e.id == h) { e.cancelled = true; return true; }
            return false;
        };
        markCancelled(_entries) || markCancelled(_pending);
    }

    template <class F>
    void update(F&& fn) {
        if (_dirty) { sort(); _dirty = false; }

        ++_inUpdate;
        for (auto& e : _entries) {
            if (!e.cancelled) fn(e);
        }
        --_inUpdate;

        if (_inUpdate == 0) {
            std::erase_if(_entries, [](auto& e){ return e.cancelled; });
            if (!_pending.empty()) {
                std::move(_pending.begin(), _pending.end(), std::back_inserter(_entries));
                _pending.clear();
                _dirty = true;
            }
        }
    }

private:
    std::vector<Entry> _entries;
    std::vector<Entry> _pending;
    int  _inUpdate = 0;
    bool _dirty    = false;
    Handle _nextId = 0;

    void sort() {
        std::stable_sort(_entries.begin(), _entries.end(),
                         [](auto& a, auto& b){ return a.priority < b.priority; });
    }
};
```

90% の「走査中変更」問題はこのテンプレで片付きます。残り 10% の複雑ケース（ネスト優先度、entry 間通信、type bucket 別ヴァケット）も、この骨格の装飾。

## 7. イテレーション記録

<!-- 本パターンに関わる今後の進化を時系列逆順で追記。 -->

*まだ無し。*

---

*リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本記事は [mini-cocos シリーズ](https://github.com/leafvmaple/blog/issues/2) の一篇。*
