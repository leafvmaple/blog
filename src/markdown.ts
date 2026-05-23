import { marked } from 'marked'

// Rewrite cross-post GitHub Issue URLs to in-app routes so links between
// posts stay inside the SPA instead of bouncing out to github.com. The
// source markdown keeps the canonical github.com URL — works there too.
const ISSUE_LINK = /^https:\/\/github\.com\/leafvmaple\/blog\/issues\/(\d+)(#.*)?$/

marked.use({
  walkTokens(token) {
    if (token.type === 'link' && typeof token.href === 'string') {
      const m = token.href.match(ISSUE_LINK)
      if (m) {
        token.href = `/post/${m[1]}${m[2] || ''}`
      }
    }
  },
})

export function parseMarkdown(src: string): string {
  return marked.parse(src) as string
}
