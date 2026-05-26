// Build-time GitHub Issues snapshot + markdown render + sitemap + RSS.
//
// Writes:
//   public/data/posts.json                  — full issue list (issues authored by OWNER, state=open)
//   public/data/posts/<number>.json         — { issue, comments } for each issue
//   public/sitemap.xml                      — sitemap of /, /blog, /post/N
//   public/rss.xml                          — RSS 2.0 feed (zh canonical)
//   public/rss.ja.xml                       — RSS 2.0 feed (ja)
//
// Markdown bodies (posts + comments) are rendered to HTML at build time with
// marked + shiki. Client gets ready-to-paint HTML and no longer ships marked.
//
// Auth: uses process.env.GITHUB_TOKEN if present (5000 req/hour); falls back to anonymous (60/hr).
// Run via `npm run fetch:posts` or as a CI step before `vite build`.

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import { createHighlighter } from 'shiki'

const OWNER = 'leafvmaple'
const REPO = 'blog'
const API = 'https://api.github.com'
const SITE_URL = 'https://leafvmaple.com'
const SITE_TITLE = {
  zh: 'Zohar Lee 事件簿',
  ja: 'Zohar Lee 事件簿',
}
const SITE_DESC = {
  zh: '资深游戏开发者 / AI Native 工程师，记录游戏引擎、渲染、操作系统内核与现代 C++ 的技术实践。',
  ja: 'シニアゲーム開発者 / AI Native エンジニア。ゲームエンジン、レンダリング、OS カーネル、モダン C++ の技術実践の記録。',
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, '..', 'public')
const OUT_DIR = resolve(PUBLIC_DIR, 'data')
const OUT_POSTS_DIR = resolve(OUT_DIR, 'posts')

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.warn('[fetch-posts] GITHUB_TOKEN not set — using anonymous quota (60/hr).')
}

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': `${OWNER}-blog-build`,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}

async function ghGet(path) {
  const url = path.startsWith('http') ? path : `${API}${path}`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}\n${body}`)
  }
  return res.json()
}

async function paginate(path) {
  const out = []
  let page = 1
  const perPage = 100
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const batch = await ghGet(`${path}${sep}per_page=${perPage}&page=${page}`)
    if (!Array.isArray(batch) || batch.length === 0) break
    out.push(...batch)
    if (batch.length < perPage) break
    page++
  }
  return out
}

function splitLangs(body) {
  const out = {}
  const re = /<!--\s*lang:([a-zA-Z-]+)\s*-->([\s\S]*?)<!--\s*\/lang:\1\s*-->/g
  let m
  while ((m = re.exec(body || ''))) {
    out[m[1].toLowerCase()] = m[2].trim()
  }
  // Legacy fallback: no markers -> single language (zh).
  if (Object.keys(out).length === 0) {
    out.zh = body || ''
  }
  return out
}

// Split an issue title on `||` into per-language variants (legacy fallback).
//   "中文标题 || 日本語タイトル"  -> { zh: '中文标题', ja: '日本語タイトル' }
//   "English only title"          -> {}  (caller should fall back to body markers)
// New posts put localized titles in `<!--title:xx-->` body markers instead and
// keep the Issue title itself as a single canonical English string.
const TITLE_LANG_ORDER = ['zh', 'ja']
function splitTitle(title) {
  const parts = (title || '').split('||').map(s => s.trim()).filter(Boolean)
  if (parts.length <= 1) return {}
  const out = {}
  for (let i = 0; i < parts.length && i < TITLE_LANG_ORDER.length; i++) {
    out[TITLE_LANG_ORDER[i]] = parts[i]
  }
  return out
}

// Extract <!--title:xx-->...<!--/title:xx--> markers from the issue body.
function splitBodyTitles(body) {
  const out = {}
  const re = /<!--\s*title:([a-zA-Z-]+)\s*-->([\s\S]*?)<!--\s*\/title:\1\s*-->/g
  let m
  while ((m = re.exec(body || ''))) {
    out[m[1].toLowerCase()] = m[2].trim()
  }
  return out
}

// Strip title markers so they don't leak into rendered bodies.
function stripTitleMarkers(body) {
  return (body || '').replace(/<!--\s*title:[a-zA-Z-]+\s*-->[\s\S]*?<!--\s*\/title:[a-zA-Z-]+\s*-->\s*/g, '')
}

// `<!--pub:YYYY-MM-DD-->` in the issue body overrides the GitHub Issue's
// created_at, since GH's API treats creation time as immutable but the author
// wants the displayed publish date to reflect actual writing cadence rather
// than the day all issues happened to be filled in. Source-of-truth lives in
// posts/N-slug.<lang>.md (assemble-post.mjs lifts it to the body).
function extractPub(body) {
  const m = (body || '').match(/<!--\s*pub:(\d{4}-\d{2}-\d{2})\s*-->/i)
  return m ? m[1] : null
}

function stripPubMarker(body) {
  return (body || '').replace(/<!--\s*pub:\d{4}-\d{2}-\d{2}\s*-->\s*\n?/g, '')
}

// ----- markdown → HTML pipeline ------------------------------------------------

const SHIKI_LANGS = [
  'c', 'cpp', 'asm', 'csharp', 'lua', 'python', 'rust', 'go',
  'ts', 'tsx', 'js', 'jsx', 'html', 'css', 'json', 'yaml', 'toml',
  'bash', 'shell', 'powershell', 'ini', 'diff', 'makefile', 'cmake',
  'dockerfile', 'markdown', 'llvm',
]
const SHIKI_THEMES = { light: 'github-light', dark: 'github-dark' }

const LANG_ALIASES = {
  'c++': 'cpp', 'h': 'cpp', 'hpp': 'cpp', 'cc': 'cpp',
  'sh': 'bash', 'zsh': 'bash',
  'objdump': 'asm', 's': 'asm', 'nasm': 'asm',
  'tsx': 'tsx', 'jsx': 'jsx', 'typescript': 'ts', 'javascript': 'js',
  'py': 'python',
  'rs': 'rust',
  'md': 'markdown',
}

const ISSUE_LINK = /^https:\/\/github\.com\/leafvmaple\/blog\/issues\/(\d+)(#.*)?$/

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plaintextCodeBlock(code) {
  return `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`
}

async function makeRenderer() {
  const highlighter = await createHighlighter({
    themes: Object.values(SHIKI_THEMES),
    langs: SHIKI_LANGS,
  })
  const loaded = new Set(highlighter.getLoadedLanguages())

  function highlight(code, langRaw) {
    const lang = LANG_ALIASES[langRaw?.toLowerCase()] || langRaw?.toLowerCase() || ''
    if (!lang || !loaded.has(lang)) return plaintextCodeBlock(code)
    try {
      return highlighter.codeToHtml(code, {
        lang,
        themes: SHIKI_THEMES,
        defaultColor: false,
      })
    } catch {
      return plaintextCodeBlock(code)
    }
  }

  // One Marked instance per build; configure extensions on it.
  const m = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        return highlight(text, lang || '')
      },
    },
    walkTokens(token) {
      // Rewrite cross-post GitHub Issue URLs so SPA navigation stays in-app.
      if (token.type === 'link' && typeof token.href === 'string') {
        const found = token.href.match(ISSUE_LINK)
        if (found) token.href = `/post/${found[1]}${found[2] || ''}`
      }
    },
  })

  return (src) => m.parse(src || '')
}

// Drop a single leading <h1>...</h1> from rendered HTML (matches the title
// already displayed in the post page header, so the body shouldn't repeat it).
function stripLeadingH1(html) {
  return html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '')
}

// Plain-text excerpt for SEO / RSS description: take a markdown body, strip
// the leading H1, code fences, link wrappers and inline markdown markers, and
// truncate to ~200 chars on a word boundary.
function excerpt(md, limit = 200) {
  if (!md) return ''
  let s = md
  s = s.replace(/^#\s+.*$/m, '')                       // first H1
  s = s.replace(/```[\s\S]*?```/g, ' ')                // fenced code
  s = s.replace(/`[^`]*`/g, ' ')                        // inline code
  s = s.replace(/!\[[^\]]*]\([^)]*\)/g, ' ')            // images
  s = s.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')           // links → text
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')                // html comments
  s = s.replace(/<[^>]+>/g, ' ')                        // remaining tags
  s = s.replace(/[*_>#~]/g, ' ')                        // md punctuation
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut) + '…'
}

// ----- per-issue / per-comment shaping ----------------------------------------

async function buildIssue(i, render) {
  const bodyTitles = splitBodyTitles(i.body)
  const legacyTitles = splitTitle(i.title)
  // Body markers win; legacy `||` titles fill any gaps; raw Issue title is the
  // canonical fallback when a locale has no localized title at all.
  const titles = { ...legacyTitles, ...bodyTitles }
  const pub = extractPub(i.body)
  const cleanBody = stripPubMarker(stripTitleMarkers(i.body))
  const bodies = splitLangs(cleanBody)

  const bodiesHtml = {}
  const descriptions = {}
  for (const [lang, md] of Object.entries(bodies)) {
    bodiesHtml[lang] = stripLeadingH1(await render(md))
    descriptions[lang] = excerpt(md)
  }

  return {
    id: i.id,
    number: i.number,
    title: i.title,
    titles,
    bodiesHtml,
    descriptions,
    html_url: i.html_url,
    created_at: pub ? `${pub}T00:00:00Z` : i.created_at,
    comments: i.comments,
    user: {
      login: i.user.login,
      avatar_url: i.user.avatar_url,
    },
    labels: (i.labels || []).map(l => ({ name: l.name, color: l.color })),
  }
}

async function buildComment(c, render) {
  return {
    id: c.id,
    bodyHtml: await render(c.body || ''),
    created_at: c.created_at,
    html_url: c.html_url,
    user: {
      login: c.user.login,
      avatar_url: c.user.avatar_url,
      html_url: c.user.html_url,
    },
  }
}

// ----- sitemap + rss ----------------------------------------------------------

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildSitemap(issues) {
  const lastmod = issues.length
    ? issues.map(i => i.created_at).sort().slice(-1)[0].slice(0, 10)
    : new Date().toISOString().slice(0, 10)
  const urls = [
    { loc: `${SITE_URL}/`, lastmod, changefreq: 'monthly', priority: '0.8' },
    { loc: `${SITE_URL}/blog`, lastmod, changefreq: 'weekly', priority: '1.0' },
    ...issues.map(i => ({
      loc: `${SITE_URL}/post/${i.number}`,
      lastmod: i.created_at.slice(0, 10),
      changefreq: 'monthly',
      priority: '0.7',
    })),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u =>
      `  <url>\n` +
      `    <loc>${xmlEscape(u.loc)}</loc>\n` +
      `    <lastmod>${u.lastmod}</lastmod>\n` +
      `    <changefreq>${u.changefreq}</changefreq>\n` +
      `    <priority>${u.priority}</priority>\n` +
      `  </url>`
    ).join('\n') +
    `\n</urlset>\n`
}

function buildRss(issues, lang) {
  const fallback = lang === 'zh' ? 'zh' : (lang === 'ja' ? 'ja' : 'zh')
  const items = issues.map(i => {
    const title = i.titles[lang] || i.titles[fallback] || i.titles.zh || i.title
    const desc = i.descriptions[lang] || i.descriptions[fallback] || i.descriptions.zh || ''
    const link = `${SITE_URL}/post/${i.number}`
    return (
      `    <item>\n` +
      `      <title>${xmlEscape(title)}</title>\n` +
      `      <link>${xmlEscape(link)}</link>\n` +
      `      <guid isPermaLink="true">${xmlEscape(link)}</guid>\n` +
      `      <pubDate>${new Date(i.created_at).toUTCString()}</pubDate>\n` +
      `      <description>${xmlEscape(desc)}</description>\n` +
      `    </item>`
    )
  }).join('\n')
  const feedLang = lang === 'ja' ? 'ja' : 'zh-CN'
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `  <channel>\n` +
    `    <title>${xmlEscape(SITE_TITLE[lang])}</title>\n` +
    `    <link>${SITE_URL}/</link>\n` +
    `    <atom:link href="${SITE_URL}/${lang === 'zh' ? 'rss.xml' : `rss.${lang}.xml`}" rel="self" type="application/rss+xml"/>\n` +
    `    <description>${xmlEscape(SITE_DESC[lang])}</description>\n` +
    `    <language>${feedLang}</language>\n` +
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n` +
    items + '\n' +
    `  </channel>\n` +
    `</rss>\n`
}

// ----- main -------------------------------------------------------------------

async function main() {
  console.log(`[fetch-posts] fetching issues for ${OWNER}/${REPO}…`)
  const raw = await paginate(`/repos/${OWNER}/${REPO}/issues?state=open&creator=${OWNER}`)
  const rawIssues = raw.filter(i => !i.pull_request)
  console.log(`[fetch-posts] ${rawIssues.length} issue(s).`)

  console.log('[fetch-posts] booting shiki…')
  const render = await makeRenderer()

  const issues = []
  for (const i of rawIssues) {
    issues.push(await buildIssue(i, render))
  }
  issues.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_POSTS_DIR, { recursive: true })

  await writeFile(
    resolve(OUT_DIR, 'posts.json'),
    JSON.stringify(issues, null, 2) + '\n',
    'utf8',
  )

  for (const issue of issues) {
    let comments = []
    if (issue.comments > 0) {
      const raw = await paginate(`/repos/${OWNER}/${REPO}/issues/${issue.number}/comments`)
      comments = []
      for (const c of raw) comments.push(await buildComment(c, render))
    }
    await writeFile(
      resolve(OUT_POSTS_DIR, `${issue.number}.json`),
      JSON.stringify({ issue, comments }, null, 2) + '\n',
      'utf8',
    )
  }

  await writeFile(resolve(PUBLIC_DIR, 'sitemap.xml'), buildSitemap(issues), 'utf8')
  await writeFile(resolve(PUBLIC_DIR, 'rss.xml'), buildRss(issues, 'zh'), 'utf8')
  await writeFile(resolve(PUBLIC_DIR, 'rss.ja.xml'), buildRss(issues, 'ja'), 'utf8')

  console.log(`[fetch-posts] wrote ${OUT_DIR}, sitemap.xml, rss.xml, rss.ja.xml`)
}

main().catch(err => {
  console.error('[fetch-posts] failed:', err)
  process.exit(1)
})
