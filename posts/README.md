# posts/

博文 markdown 源文件。

## 文件命名

`<issue-number>-<slug>.<lang>.md`

- `<issue-number>`：对应的 GitHub Issue 号。
- `<slug>`：URL 友好的短标识，跨语言保持一致。
- `<lang>`：语言代码，目前支持 `zh`（默认）和 `ja`。

每篇文章可以同时存在多个语言文件，例如：

```
posts/
  2-mini-cocos-design-recap.zh.md
  2-mini-cocos-design-recap.ja.md
```

## 多语言渲染原理

GitHub Issue 的 body 里用注释标记分隔每种语言，并在 body 顶部用 `<!--title:xx-->` 标记携带每个语言的标题：

```markdown
<!--title:zh-->中文标题<!--/title:zh-->
<!--title:ja-->日本語タイトル<!--/title:ja-->

<!--lang:zh-->
（中文正文）
<!--/lang:zh-->

<!--lang:ja-->
（日文正文）
<!--/lang:ja-->
```

构建时 `scripts/fetch-posts.mjs` 会：
- 把 `<!--title:xx-->` 抽成 `titles: { zh, ja }`，并从 body 里删掉这些标记；
- 把剩下的 body 按 `<!--lang:xx-->` 切成 `bodies: { zh, ja }`。

## 发布日期 override

GitHub 的 `issue.created_at` 是只读的——但博文的"发布日期"应该反映**作者真正动笔/想写这篇的时间**，不该被 Issue 占号那天绑死。在 `posts/N-slug.<lang>.md` 顶部加一行：

```
<!--pub:2026-03-15-->
```

`assemble-post.mjs` 会把它从 lang 正文里剥掉、提到 issue body 顶部（lang 包裹之外）；`fetch-posts.mjs` 把它解析成 ISO 时间并覆盖输出 JSON 里的 `created_at`。无 marker 时回落到真实的 `i.created_at`。

**约束**：日期不得早于该文所属项目的首次 commit 时间（mini-cocos / zonix-plus / zcc 各自 repo 的 `git log --reverse | head -1`）。重写代码不影响博文 created_at——按"作者动笔的时间"取数即可。

只需写在一个 lang 文件里（约定写在 `.zh.md`），多个 lang 都写时 assemble 取第一个匹配项。

前端根据用户语言挑选对应 title / body 渲染；缺失某语言时 fallback 到 Issue 的原始 title（即英文 canonical）和 LANGS 里的下一个语言。

> Issue title 本身请写**英文 canonical**（例：`Building mini cocos2d-x in 1500 lines of C++: design recap`）。它会出现在 GitHub 通知、Issue 列表、URL slug 中，也作为前端最终 fallback。本地化标题写在每个 `.md` 文件顶部的 `# H1`，由 `assemble-post.mjs` 自动抽取。

## 写新文章

1. 在 GitHub 新建 Issue，标题写**英文 canonical**（短句即可，例：`Building mini cocos2d-x in 1500 lines of C++: design recap`），随手写一行占位 body。记下 issue 号 `N`。
2. 本地新建语言文件，每个文件顶部必须有 `# 本地化标题`：
   ```
   posts/N-slug.zh.md   # 顶行: # 中文标题
   posts/N-slug.ja.md   # 顶行: # 日本語タイトル（可选；缺省时 ja 用户 fallback 到英文 Issue title）
   ```
3. 合并并推到 Issue（**务必走文件，不要用 PowerShell 管道**，否则 cp936 会把 UTF-8 中文/日文压成 `?????`）：
   ```powershell
   node scripts/assemble-post.mjs N tmp_body.md
   gh issue edit N --repo leafvmaple/blog --body-file tmp_body.md
   Remove-Item tmp_body.md
   gh issue edit N --repo leafvmaple/blog --add-label "label1,label2"
   gh workflow run deploy.yml --repo leafvmaple/blog
   ```
   > 验证 body 编码：`gh issue view N` 的输出在 Windows 控制台会显示成乱码（cp936 显示 bug），属于正常现象。要确认真实状态请用 `curl` 拉 `api.github.com/.../issues/N` 看 JSON。
4. `git add posts && git commit && git push` 让仓库与 Issue 保持一致。

## 修旧文章

改 `posts/N-slug.<lang>.md`（含顶部 `# H1`）→
```powershell
node scripts/assemble-post.mjs N tmp_body.md
gh issue edit N --repo leafvmaple/blog --body-file tmp_body.md
Remove-Item tmp_body.md
```
→ commit & push。Issue body 永远以 `posts/` 拼出来的为准。

## 标签

- Issue title：**英文 canonical**，单语言一份。各语言显示标题写在对应 `.md` 顶部的 `# H1`。
- Issue labels：英文 slug（如 `game-engine` / `rendering` / `recap`），前端 `LABEL_T` 字典负责翻译显示名。
- 文章 H1 在前端会被剥掉再渲染，避免和详情页大标题重复，每个语言文件可以各写各的母语。

## 系列连载与迭代约定

随项目（特别是引擎/内核类长期项目，如 [mini-cocos](https://github.com/leafvmaple/mini-cocos) 和 [zonix-plus](https://github.com/leafvmaple/zonix-plus)）持续演进，需要明确："**什么时候开新文，什么时候改旧文**"，以保证博客既能反映最新认知，又能记录思考的成长轨迹。下面这套约定从 mini-cocos 系列开始使用，已复用到 zonix-plus 系列（主索引帖 #11，子篇 #12–#18），未来其它长期项目可复用同一套规则。

> 当前两个系列的主索引帖：mini-cocos = #2，zonix-plus = #11。每个系列的子篇 commit 引用各自指向对应仓库（`mini-cocos` / `zonix-plus`）。

### Rule A — 主题锁定

一个 slug = 一个子系统 / 一个独立话题。**只要是该子系统的非破坏性演进**（功能扩展、修 bug、加 commit），都更新原文，不开新文。

### Rule B — 何时开新文

满足以下任一条件就开新 Issue：

1. **新增正交的子系统**：与已有任何文章主题都不同（如 mini-cocos 加粒子系统、Spine 骨架、物理、网络）。
2. **重大重写，推翻原有结论**：原文里某段话已经"不再对"。**不要在原文里覆盖**那段结论 —— 在原段落开头加 ⚠️ 标志 + 链接到新文章（"原方案见此说明，已被 #N 取代，理由如下"），新文章里写新结论。这样面试 / 复读时能看出"思路是如何成长的"。
3. **跨子系统的横切变更**：比如新增 Metal RHI，会同时影响渲染篇、资源管线篇、shader 处理。这种情况开一篇专门的"接入 Metal 复盘"，跨引子篇用一段话索引到新文章即可。
4. **任何已有文章超过 400-500 行**：超过这个阈值阅读体验骤降。把里面最独立的一块拆出去成为新文。

### Rule C — 何时只更新原文

满足以下条件，**只改原文，不开新文**：

1. **子系统内的功能扩展**：比如 EventDispatcher 加 bubble 阶段（追加新 section + 在"迭代记录"里加一行）。
2. **工程审美级别的小提交**：比如换 `std::erase_if`、删冗余构造函数。统一追加到**主帖 §3**（"一些'小'提交里的工程审美"）的子节里，不要散到子篇。
3. **bug fix / 性能优化 / 重构**：追加到对应文章末尾的"## 迭代记录"section，**按时间倒序**写一行，含 commit hash + 一两句说明。这是给"几个月后回来看为什么这样改"的自己看的。

### Rule D — Commit 引用方式

- 一律用**完整 GitHub 链接**：`[hash](https://github.com/leafvmaple/mini-cocos/commit/HASH)`（短 hash 显示，全 hash 在 URL 里）。
- 同一段落里 commit 引用不超过 3 个；超过就把段落拆开或合并相关 commit 引用为一个。
- zh / ja 必须引用同一批 hash，**不要在翻译中漏掉或替换 commit 链接**。

### Rule E — 主帖（如 #2）的角色

主帖永远是**索引帖 + 元经验帖**，不沉淀任何具体子系统的新结论。

- 新增子篇 → 主帖"系列文章"表里追加一行（一句话描述 + 链接）。
- 子篇结论与主帖某句话冲突 → **只改主帖那一句话**（用一两个字精确替换 + 链接到子篇），不做长篇重写。
- 跨子系统的元经验（如"接缝在第一天划"那种）可以追加到主帖 §4 复盘列表。

这套规则的隐含目标：**让"读者 / 未来的我"在任何时刻打开主帖，都能在三分钟内拿到当前最新的全景**，同时每篇子文又能独立深读。

