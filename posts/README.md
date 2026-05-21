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
