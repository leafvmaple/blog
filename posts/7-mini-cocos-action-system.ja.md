# `update(t∈[0,1])` は複合 Action を代数化する唯一の前提

> リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> シリーズ：[mini-cocos 設計復盤 #2](https://github.com/leafvmaple/blog/issues/2) のサブ記事
> 関連サブシステム：`Action` / `ActionInterval` / `Sequence` / `Spawn` / `EaseFunction`

mini-cocos の Action システムはほぼ cocos2d-x の設計を直移植したもの。`src/base/ZCAction*.cpp/h` は計 1,082 行で `Sequence` / `Spawn` / `Ease` / `Repeat` / `RepeatForever` と一連の具体 tween（`MoveTo` / `MoveBy` / `RotateTo` / …）を実装し、すべて 1 本の API 契約に立脚する：

```cpp
// src/base/ZCActionInterval.h
class ActionInterval : public FiniteTimeAction {
public:
    virtual void update(float t) = 0;   // ★ t は常に [0, 1] の正規化時刻
};
```

この設計の**本当に賢い点は `Sequence` でも `Spawn` でもなく、`update(float t)` の契約そのもの**：`t` は常に ∈ [0, 1]。この 1 条の制約こそ 1,082 行が純関数的に任意ネスト合成できる根本理由 —— `Ease(action, easeFn)` は `update(easeFn(t))` に退化、`Sequence(A, B)` は `t` がどの段に落ちるかに応じて `A.update(t/k)` または `B.update((t-k)/(1-k))` に退化する。以下、この結論を素朴な書き方から逆算する。

## 1. 素朴な書き方の問題

最も直接的な tween：

```cpp
class MoveTo {
    Vec2  start, end;
    float duration;
    float elapsed = 0;

    void update(float dt) {
        elapsed += dt;
        float t = elapsed / duration;
        target->setPosition(lerp(start, end, t));
        if (elapsed >= duration) done = true;
    }
};
```

1 つ書いて動くが、**合成すると崩れる**。「MoveTo の後 FadeIn」を作りたい：

```cpp
class Sequence {
    std::vector<Action*> actions;
    size_t current = 0;
    void update(float dt) {
        actions[current]->update(dt);
        if (actions[current]->done) ++current;
    }
};
```

`Sequence` 自身も dt を食う、各 child も dt を食う —— **dt の意味論が「絶対秒」になる**。問題：

- Sequence 全体を 2x 加速したい、全 child の duration を回って変更する必要あり。
- Sequence に EaseInOut を被せたい、できない —— ease 関数は `t → t'`（正規化時刻）の対応だが、dt は絶対時刻、変えられる「位置パラメータ」が無い。
- `Repeat(action, 3)` をしたい、各 child の done を検出し、リセット時に elapsed から duration を引く、境界条件まみれ。

## 2. 鍵となる転換：`update(float t)`, t ∈ [0, 1]

cocos2d-x の設計：

```cpp
class ActionInterval : public Action {
public:
    float duration;        // 自分の長さ
    float elapsed = 0;

    // エンジンメインループが dt を食わせる
    void step(float dt) {
        elapsed += dt;
        float t = std::clamp(elapsed / duration, 0.0f, 1.0f);
        update(t);                                        // 鍵：t は [0,1]
        if (elapsed >= duration) done = true;
    }

    virtual void update(float t) = 0;                     // サブクラスが override
};
```

具体的 action：

```cpp
class MoveTo : public ActionInterval {
    Vec2 start, end;
    void update(float t) override {
        target->setPosition(lerp(start, end, t));
    }
};

class FadeIn : public ActionInterval {
    void update(float t) override {
        target->setOpacity(static_cast<uint8_t>(255 * t));
    }
};
```

`update(t)` は「今進捗が何 %」だけを気にする、**総時長は知らなくて良い**。この単純な契約変更で、全 combinator が自然になる。

## 3. 3 つの combinator の実装

### 3.1 Sequence

```cpp
class Sequence : public ActionInterval {
    std::vector<ActionInterval*> children;
    std::vector<float> cumulative;   // 累積正規化時刻分段
public:
    Sequence(std::vector<ActionInterval*> cs) : children(std::move(cs)) {
        duration = 0;
        for (auto* c : children) duration += c->duration;
        float acc = 0;
        for (auto* c : children) {
            acc += c->duration / duration;
            cumulative.push_back(acc);      // 例：[0.3, 0.6, 1.0]
        }
    }

    void update(float t) override {
        // t がどの child 区間に落ちるか探す
        size_t i = 0;
        while (i + 1 < cumulative.size() && t > cumulative[i]) ++i;
        float prev = (i == 0) ? 0 : cumulative[i - 1];
        float localT = (t - prev) / (cumulative[i] - prev);
        children[i]->update(std::clamp(localT, 0.0f, 1.0f));
    }
};
```

`Sequence` 自身も `ActionInterval`、duration は各 child duration の和。`update(t)` 時にグローバル t を現 child のローカル t に逆算。注意：**直接 dt を食わない**、その dt の流れは親級（最終的に ActionManager）が step 関数経由で食わせる。

### 3.2 Spawn

```cpp
class Spawn : public ActionInterval {
    std::vector<ActionInterval*> children;
    void update(float t) override {
        for (auto* c : children) {
            float localT = std::min(1.0f, t * (duration / c->duration));
            c->update(localT);
        }
    }
public:
    Spawn(std::vector<ActionInterval*> cs) : children(std::move(cs)) {
        duration = 0;
        for (auto* c : cs) duration = std::max(duration, c->duration);
    }
};
```

`Spawn` は複数 child を並列実行、duration = max(children.duration)。各 child のローカル t は自身の duration で等比拡大。child が Spawn より短い場合、`t = duration_child / duration_spawn` で 1.0 に達し saturate。

### 3.3 EaseInOut（デコレータ）

```cpp
class EaseInOut : public ActionInterval {
    ActionInterval* inner;
    void update(float t) override {
        // t' = 3t² - 2t³（cubic Hermite）
        float et = t * t * (3 - 2 * t);
        inner->update(et);
    }
public:
    EaseInOut(ActionInterval* a) : inner(a) { duration = a->duration; }
};
```

ease 関数は正規化 t 上のマッピングのみ —— これは **`update(t)` 契約だからこそ可能**。dt を食う場合、ease は dt を非線形変換する必要があり、「dt 累加で elapsed」の幾何学的意味が壊れる。

### 3.4 Repeat / Reverse / DelayTime

よく使う数個を補う：

```cpp
class Repeat : public ActionInterval {
    ActionInterval* inner;
    int times;
    void update(float t) override {
        float scaled = t * times;
        float localT = scaled - std::floor(scaled);
        if (scaled >= times) localT = 1.0f;
        inner->update(localT);
    }
public:
    Repeat(ActionInterval* a, int n) : inner(a), times(n) {
        duration = a->duration * n;
    }
};

class DelayTime : public ActionInterval {
    void update(float) override {}    // 本当に何もしない
public:
    explicit DelayTime(float d) { duration = d; }
};

class Reverse : public ActionInterval {
    ActionInterval* inner;
    void update(float t) override { inner->update(1.0f - t); }
public:
    explicit Reverse(ActionInterval* a) : inner(a) { duration = a->duration; }
};
```

`DelayTime::update` は空、しかし duration を持つ —— `Sequence` の累積時刻計算で正しく時間を割り当てられる。これは「『何もしない』が鍵となる機能」の珍しい例。

## 4. タイムライン図示

少し複雑な複合 action を考える：

```cpp
auto move = MoveTo::create(2.0f, {100, 0});
auto fade = FadeIn::create(1.0f);
auto delay = DelayTime::create(0.5f);
auto rot  = RotateBy::create(1.0f, 90);

auto seq = Sequence::create({
    Spawn::create({move, fade}),     // 2.0s
    delay,                           // 0.5s
    rot                              // 1.0s
});
// 総時長 3.5s
```

タイムライン（横軸は秒、縦軸は t）：

```
0s        2s    2.5s    3.5s
|---------|-----|-------|
[ Spawn       ][delay][ rot ]
  |__ move (2s, t 直接進行)
  |__ fade (1s, t=0..0.5s 内で t 完了)
```

メインループが毎フレーム dt を ActionManager に食わせる → ActionManager が seq.step(dt) に食わせる → seq.step が elapsed/duration を進める → seq.update(t) → 現 child を計算 → child.update(localT)。全再帰が `update(t)` → `update(t')`、「dt が再帰で流れる」コードはどこにも無い。

## 5. ActionManager：上位スケジューラ

```cpp
class ActionManager {
    std::vector<std::pair<Node*, ActionInterval*>> _running;
    // 三点セット：pending、cancelled、dirty
    void update(float dt) {
        // ... iterate-and-mutate 三点セット（issue #4 参照）
        for (auto& [node, action] : _running) {
            action->step(dt);
            if (action->done) /* mark cancelled */;
        }
    }
};
```

ActionManager は Action ツリーに dt を食わせる唯一の入口。内部は [iterate-and-mutate 三点セット](https://github.com/leafvmaple/blog/issues/4)、なぜなら action の `update` 中で `node->runAction(another)` が完全に呼ばれ得るから —— 古典的「走査中変更」。

## 6. 設計哲学：正規化 t が「代数」を書けるようにする

振り返ると、システム全体が数行で書ける鍵は **全 action が同じ「形」`update(float t)` を共有する** こと。これにより合成可能になる：

- 直列（Sequence）= グローバル t を分段する。
- 並列（Spawn）= グローバル t を等比で各 child にマップする。
- デコレータ（Ease / Reverse / Repeat）= グローバル t を非線形変換してから child に渡す。

`update(t)` を `f: [0,1] → 副作用` と捉えるなら、Sequence/Spawn はこれらの関数の代数演算（分段結合、並列）。関数型コミュニティの「Tween は a → b の射、合成可能」と完全に同じことを、cocos2d-x はとっくに C++ で書いていた。

> このパターンは後に無関係な多くの場所で使い回した：
>
> - 自前のアニメーションタイムラインエディタを書く時、この構造を直接再利用した（エディタが保存するのは合成ツリー、エクスポートで JSON 直列化、ランタイムで逆直列化して同じ Action ツリーに復元）。
> - サーバ側で「報酬付与シーケンス」（データ取得 → 計算 → メール送信 → 通知）を書く時、step を `step(progress) -> next_step` として書いて合成方式を踏襲。
>
> **「あるプロセスを加速 / 減速 / 直列 / 並列 / 繰り返しできる」全問題は、この形** です。

## 7. 実装の小さな注意点 2 つ

### 7.1 t = 1 時に update を 1 回呼ぶ必要

```cpp
void step(float dt) {
    elapsed += dt;
    if (elapsed >= duration) {
        update(1.0f);          // 明示的に 1.0 を食わせる
        done = true;
    } else {
        update(elapsed / duration);
    }
}
```

1.0 を食わせないと、最後のフレームの t は 0.97 などになり、target が 97% の位置で永遠に停止。**目視ではほぼ見えない**（1 ピクセル差、不透明度数階差）が、視覚的に「アニメーションが収まらない」。done 時は必ず強制的に 1.0 を食わせる。

### 7.2 同一 Action を 2 つの Node に付けてはいけない

```cpp
auto a = MoveTo::create(...);
node1->runAction(a);
node2->runAction(a);    // ❌ elapsed と target を共有、両者干渉
```

Action は `target` と `elapsed` の状態を持ち、再入不可。2 つの Node に使うにはコピー（または runAction 内で clone）。cocos2d-x 原版は明示的 `clone()` 関数、mini-cocos は手抜きで runAction 内で retain + clone、share-by-value 意味論を提供。

## 8. イテレーション記録

<!-- 今後の Action システムの進化をここに追記。Tween path、Bezier、カスタム ease など。 -->

- 2026-05-22：[`67633ba`](https://github.com/leafvmaple/mini-cocos/commit/67633ba) `ActionInterval` から約 80 行の重複コードを削除 —— 元の版では `step()` / `update()` / 境界処理が MoveTo / FadeIn / Sequence それぞれに重複実装されていた。今回基底クラスの step テンプレートに集約、サブクラスは `update(t)` だけを override。本稿§2 で示した「骨格」はちょうどこの清理後の姿。実際、本稿を書き上げてからコードを見て重複に気づき、その場で清めた——ブログを書くとコードを逆に推し進める。

---

*リポジトリ：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本記事は [mini-cocos シリーズ](https://github.com/leafvmaple/blog/issues/2) の一篇。*
