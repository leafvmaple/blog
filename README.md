# 叶枫影 的博客

基于 Vite + React + TypeScript 的极简博客，用 GitHub Issues 当 CMS，部署到 GitHub Pages。

**访问地址**：[leafvmaple.com](https://leafvmaple.com)

## 怎么写一篇文章

1. 在本仓库新开一个 Issue：标题即文章标题，正文即正文，支持完整 Markdown（代码块、表格、HTML 锚点都可用）。
2. 打上 label —— 文章页那些彩色 tag 就是 Issue label，在 repo 的 Labels 页统一管理颜色和描述。
3. 等几分钟 `deploy` workflow 跑完，文章就出现在首页。

> 只有仓库 owner 创建的 Issue 会被收录为文章。评论区直接挂在原 Issue 上，访客登录 GitHub 即可参与。

## 本地开发

```bash
npm install
npm run dev      # vite 开发服务器
npm run build    # tsc -b && vite build
```

`npm run fetch:posts` 会本地预拉取一次 Issue 快照，方便离线调试列表页。

## 构建时数据快照

`scripts/fetch-posts.mjs` 在 CI 里用 `GITHUB_TOKEN` 拉全部 Issue，写到 `public/data/posts.json`，首屏直接读静态 JSON，绕开 GitHub API 匿名 60 次/小时的速率限制。文章详情和评论仍然走运行时 API，用的是访客自己的 5000 次/小时配额。

## 部署

`.github/workflows/deploy.yml` 在以下时机重建站点：

- push 到 `main`
- 手动 `workflow_dispatch`（写完文章 / 改完 label 后跑一下即可上线）

产物经 [`peaceiris/actions-gh-pages`](https://github.com/peaceiris/actions-gh-pages) 推到 `gh-pages` 分支，由 GitHub Pages 托管。自定义域名通过 `public/CNAME` 配置。

## 致谢

Fork 自 [luckyyyyy/blog](https://github.com/luckyyyyy/blog)，感谢原作者的极简模板。
