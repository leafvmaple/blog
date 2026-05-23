# EventDispatcher 3 度の書き直し：二優先度チェーン + pending queue + ネスト dispatch カウンタ

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`EventDispatcher` / `EventListener` / `Touch` 派遣

`src/base/ZCEventDispatcher.cpp` は mini-cocos で最も書き直されたサブシステム —— `git log --oneline src/base/ZCEventDispatcher.*` は 9 コミットを列挙し、そのうち 3 つが構造的な書き直し：

```
fb4300f  feat(base): add Event and EventDispatcher with per-frame polling   ← v1
b3cc36c  feat(base): factor EventListener abstraction and add Application entry
db6b6dd  refactor(events): adopt cocos2d-x fixed / scene-graph priority lists ← v2
bf4b46a  refactor(events): use std::erase_if for listener cleanup
6c1d2b3  refactor(events): split keyboard and mouse listeners into separate files
90acab7  refactor(events): deduplicate dispatch paths in EventDispatcher    ← v3
bacb0f9  feat(ui): respect scene-graph occlusion in widget hit-testing
67633ba  refactor: simplify ActionInterval and tidy EventDispatcher
be88a31  feat(stl): route data-structure/algorithm STL through mstd alias
```

v1（`fb4300f`）：グローバルコールバック表、1 週間で 3 つの独立問題に陥落。v2（`db6b6dd`）：二優先度チェーン + `EventListener` オブジェクト、動くがネスト dispatch で listener 集合を mutate するとイテレータ無効化。v3（`90acab7`）：[`_inDispatch` カウンタ + ソフト削除 + pending queue](https://github.com/leafvmaple/blog/issues/4) を載せ、構造はそのまま現在まで安定。本稿は時系列で 3 度の反復を振り返り、**「正しそう」な v1 がほぼ確実に作り直しになる理由**を明確にする。

## 1. 第 1 版：グローバルコールバック表

最も素朴な書き方。各イベント型に対し 1 個のコールバック vector：

```cpp
std::unordered_map<EventType, std::vector<std::function<void(Event*)>>> _callbacks;

void dispatch(Event* e) {
    for (auto& cb : _callbacks[e->type]) cb(e);
}
```

1 週間ほどで崩壊。致命的問題が 3 つ：

### 1.1 「イベントを呑む」を表現できない

UI ボタン押下時、この touch イベントを **背後のシーンへ伝搬させたくない**。`std::function<void(Event*)>` には戻り値チャネルが無い。`std::function<bool(Event*)>` に変えて false 時に break —— しかし次の問題が来る：**優先度**。

### 1.2 優先度が無く、UI が永遠にイベントを取れない

ボタンと背景が同時に touch listener を登録。先登録が先に呼ばれる、つまり先登録の UI フレームワーク側コードが先にイベントを取る、**しかしシーンが動的生成だと** UI がシーンの後に登録されるかも —— 即破綻。

素朴に `int priority` を足すだけでは不足。UI の優先度は **論理的にシーングラフ内の位置で決まる** から —— 上層ノードが下層より先に touch を取るべき。エンジンが priority 数値をハードコードすると、全 UI コードが数値を書く羽目になり、マジックナンバーの海。

### 1.3 unregister 不能（lambda は比較できない）

`std::function` は `==` 不能、よって unregister はハンドルを返す必要あり。第 1 版は `int id` カウンタを使ったが、id 衝突しやすく、シーン横断の lifecycle 管理も手書きで補う必要あり。

## 2. 第 2 版：二優先度チェーン + EventListener オブジェクト

第 2 版で完全書き換え。`EventListener` を命名可・比較可なオブジェクトとして導入し、優先度を **2 系統の独立チェーン** に分割：

```cpp
class EventListener : public Ref {
public:
    enum class Type { TOUCH_ONE_BY_ONE, TOUCH_ALL_AT_ONCE,
                      KEYBOARD, MOUSE, CUSTOM, /* ... */ };

    std::function<bool(Event*)> onEvent;     // true = 呑む
    Node* _associatedNode = nullptr;          // ノードと生死を共にする、optional
    int   _fixedPriority  = 0;                // 数値優先度、optional
    bool  _registered     = false;
    bool  _enabled        = true;
};
```

登録時、EventDispatcher はノードに紐付くか否かで listener を 2 つの vector に振り分けます：

```cpp
struct EventListenerVector {
    std::vector<EventListener*> _fixedListeners;    // _fixedPriority 昇順
    std::vector<EventListener*> _nodeListeners;     // ノードのシーングラフ順
};
std::unordered_map<EventType, EventListenerVector> _listenerMap;
```

派遣順：

```cpp
void dispatch(Event* e) {
    auto& v = _listenerMap[e->type];
    // 優先度 < 0 の fixed：UI フレームワーク級最高優先度
    for (auto* l : negative_fixed(v)) if (run(l, e)) return;
    // scene-graph：上層ノード優先
    for (auto* l : v._nodeListeners)  if (run(l, e)) return;
    // 優先度 >= 0 の fixed：デフォルト背景
    for (auto* l : positive_fixed(v)) if (run(l, e)) return;
}
```

この分段は cocos2d-x の古典設計、完全に踏襲。それが齎す意味論：

- **fixed priority < 0** = 「俺は何のノードより先」（debug overlay、modal dialog フレームワーク、IME）；
- **scene-graph** = 「シーングラフ自然順」（大半の UI / ゲームオブジェクト）；
- **fixed priority > 0** = 「フォールバック」（既定入力ハンドラ、analytics）。

`run(listener, event)` が true を返せば消費、派遣停止；EventListener の `_enabled` がさらに 1 段ショート。

### 2.1 ただし — ネスト dispatch で陥落

第 2 版は 90% のシナリオで動きます。残り 10% のクラッシュは **イベント listener 内部からまた別イベントを派遣** することから来る。

具体シナリオ：ボタン listener 内で `dispatcher->dispatch(CustomEvent("button_clicked"))`、CustomEvent の listener が listenerMap に対し add / remove。外側で走査中の `_nodeListeners` のイテレータが無効化される。

最初は単純な bool で凌ごうとした：

```cpp
bool _isDispatching = false;
void dispatch(Event* e) {
    _isDispatching = true;
    // ...
    _isDispatching = false;
    sweep();
}
```

ネスト dispatch から戻ると内側の `_isDispatching = false` が外側のフラグも消す、sweep が早期実行。同様にクラッシュ。

## 3. 第 3 版：bool をカウンタに + 三点セット

`_isDispatching` を `_inDispatch` カウンタに換え、EventListenerVector に [iterate-and-mutate 三点セット](https://github.com/leafvmaple/blog/issues/4) を被せる：

```cpp
struct EventListenerVector {
    std::vector<EventListener*> _fixedListeners;
    std::vector<EventListener*> _nodeListeners;
    std::vector<EventListener*> _toAdd;
    int   _inDispatch = 0;
    bool  _dirtyFixed = false;
};

void EventDispatcher::dispatch(Event* e) {
    auto& v = _listenerMap[e->type];
    if (v._dirtyFixed) { sortFixed(v); v._dirtyFixed = false; }

    ++v._inDispatch;
    walkAndCallback(v, e);
    --v._inDispatch;

    if (v._inDispatch == 0) {
        std::erase_if(v._fixedListeners, isDead);
        std::erase_if(v._nodeListeners,  isDead);
        flushPending(v);
    }
}
```

登録時 `_inDispatch > 0` なら `_toAdd` へ、解除時は `listener->_registered = false` を翻すだけ。ネストでは `_inDispatch == 0` の時のみ sweep + flush を許容、最外 dispatch が見るのが同じ vector 状態であることを保証。

この版以降、変更無し。

## 4. ヒットテスト：単点 touch がシーングラフを進む流れ

touch イベントがキーボードイベントより複雑なのは **ヒットテストを先に行ってから派遣順を決める** 必要があるから：

```
TouchBegan(x, y)
    ↓
TOUCH_ONE_BY_ONE 登録の全 listener を上記三段順で走査
    ↓
各 listener について、Node が紐付いていれば：
    (x,y) を当 Node のローカル座標に逆変換
    boundingBox に入るか判定
    NO → この listener をスキップ
    YES → listener.onTouchBegan(touch) を呼ぶ
        true 返却：
            この listener を「claimed listeners」集合に加える
            後続の onTouchMoved / onTouchEnded は claimed のみ通知
            イベントは下に伝搬しない
        false 返却：
            次の listener へ
```

見落とされがちな 2 点：

### 4.1 modal dialog が全 touch を呑む方法

modal は scene-graph 順に依存しない（dialog は z 順が低くても論理上全てを覆う）。実装：`_fixedPriority = INT_MIN` の全画面 listener を 1 つ登録、ヒットテストは常時 true、onTouchBegan は常時 true。これで第 1 段（negative fixed）で全 touch を遮断。

### 4.2 claimed listeners は touch 一対一の核心

ボタンが began 段階で touch を claim した後、プレイヤーの指が滑り出ても moved/ended はこのボタンに送る必要がある —— 毎 moved でヒットテストを再実行できない。「ボタン押下後に指が離れて初めて cancel」という操作の実装基礎です。`_claimedTouches: std::unordered_map<Touch*, std::vector<EventListener*>>` をメインループで管理、各 touch を began 時に登録、ended 時に消去。

## 5. 他のイベントシステムとの比較

書き終わって振り返ると、mini-cocos の EventDispatcher は下記システムとほぼ同族だと分かる：

| システム | 等価概念 |
|---|---|
| Slate（UE4 UI） | `FReply::Handled()` ↔ listener が true を返す；ヒットテストは widget tree を逆順走査 ↔ scene-graph 段 |
| Qt | `event->accept()` / `ignore()` ↔ return true/false；`installEventFilter` ↔ negative fixed priority |
| DOM | capture phase ↔ scene-graph 上から下；bubble phase は mini-cocos では未実装（2D エンジンでは出番少） |
| GTK | signal handler が `GDK_EVENT_STOP` / `PROPAGATE` を返す ↔ return true/false |

差分は主に 2 軸：
- **bubble の有無**：DOM/GTK は有り、cocos / Slate は無し。理由：2D ゲームでは「親ノードが touch を受ける」意味論が稀、ノードの z 順で上から下に 1 周走査して最初に当たった者が取るで充分。
- **優先度がツリー構造から独立しているか**：DOM はほぼ完全にツリー依存；mini-cocos には fixed priority というツリー回避専用の支があり、modal や debug overlay を実装しやすい。

将来複雑な UI フレームワークを追加する際、bubble 段階を補うのは EventDispatcher 主構造の改修を必要としません —— walkAndCallback の後に逆走査を 1 つ追加すれば済む。**予約ポイントが walk 段階にあり listener データ構造内ではない** のは意図的設計。

## 6. 経験

**優先度・ライフタイム・ネスト呼び出し安全 —— この 3 つは第 1 版で全て考えておかねばならない**。プロジェクトの拡大で自動的に湧き出るものではない；どれか 1 つでも欠けると、数週間以内にきっと「EventDispatcher を回避する専用の密貿易チャネル」を書くハメになる。密貿易が 3、4 本溜まったら全て作り直しになる。具体的に API 表面では：

- いかなる「コールバック」系も、第 1 引数はコールバックオブジェクト（listener）にする、直接 `std::function` を食わない —— 優先度、enable/disable、オブジェクト/ノード単位の一括 remove に掛けるフックがあるため。
- 派遣関数は常にネスト対応、bool ではなくカウンタ。
- ソフト削除 + pending add は常時デフォルトで走らせる —— 第 1 版で使わなくても、正解実装コストは極小、誤実装コストは極大。

## 7. イテレーション記録

<!-- 今後の EventDispatcher の進化をここに追記。bubble 段階、ジェスチャ識別合成、マルチ touch 最適化など。 -->

- 2026-05-22：[`67633ba`](https://github.com/leafvmaple/mini-cocos/commit/67633ba) EventDispatcher のちょっとした整理 —— dispatch パス中の重複する priority 比較 / `_inDispatch` チェックを一本化、外部公開不要の helper を private にもどした。振る舞い不変、純粋に構造整理。本稿§3 のコード骨格はちょうどこの整理後の姿。

---

*リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本記事は [mini-cocos シリーズ](https://github.com/leafvmaple/blog/issues/2) の一篇；三点セット汎用パターンは [#4](https://github.com/leafvmaple/blog/issues/4) を参照。*
