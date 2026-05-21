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

GitHub Issue 的 body 里用注释标记分隔每种语言：

```markdown
<!--lang:zh-->
（中文正文）
<!--/lang:zh-->

<!--lang:ja-->
（日文正文）
<!--/lang:ja-->
```

构建时 `scripts/fetch-posts.mjs` 会把 body 按 `<!--lang:xx-->` 标记切成 `bodies: { zh, ja }`，前端根据用户语言（`navigator.language`，默认 zh）选取对应段渲染。旧文章无标记时按 zh 处理。

## 写新文章

1. 在 GitHub 新建 Issue（标题统一写，例如 `中标题 / 日タイトル`），随手写一行占位 body。记下 issue 号 `N`。
2. 本地新建语言文件：
   ```
   posts/N-slug.zh.md
   posts/N-slug.ja.md   # 可选；缺省时 ja 用户会看到 zh 兜底
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

改 `posts/N-slug.<lang>.md` →
```powershell
node scripts/assemble-post.mjs N tmp_body.md
gh issue edit N --repo leafvmaple/blog --body-file tmp_body.md
Remove-Item tmp_body.md
```
→ commit & push。Issue body 永远以 `posts/` 拼出来的为准。

## 标签

`<!--lang:xx-->...<!--/lang:xx-->` 之外的标签：

- 标题（Issue title）只有一份，建议用 `中文 / 日本語` 双语形式。
- 文章 H1 由前端剥掉，写在每个语言文件最上面即可，可以各写各的母语。
