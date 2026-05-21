# posts/

博文 markdown 源文件。文件名约定：`<issue-number>-<slug>.md`，例如 `2-mini-cocos-design-recap.md` 对应 [Issue #2](https://github.com/leafvmaple/blog/issues/2)。

## 写新文章

1. 在 GitHub 新建 Issue（标题 = 文章标题），随手写一行正文占位。记下分配到的 issue 号 `N`。
2. 本地新建 `posts/N-slug.md`，写正文（支持完整 Markdown，HTML 锚点也可用）。
3. 推到 issue 并触发重建：

   ```powershell
   gh issue edit N --repo leafvmaple/blog --body-file posts/N-slug.md
   gh issue edit N --repo leafvmaple/blog --add-label "label1,label2"
   gh workflow run deploy.yml --repo leafvmaple/blog
   ```

4. commit & push 这个 .md 到 main，让 repo 和 issue body 保持一致。

## 修旧文章

直接改 `posts/N-slug.md` → `gh issue edit N --body-file posts/N-slug.md` → commit & push。Issue body 永远以 `posts/` 为准。
