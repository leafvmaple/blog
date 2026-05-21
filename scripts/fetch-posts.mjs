// Build-time GitHub Issues snapshot.
// Writes:
//   public/data/posts.json                  — full issue list (issues authored by OWNER, state=open)
//   public/data/posts/<number>.json         — { issue, comments } for each issue
//
// Auth: uses process.env.GITHUB_TOKEN if present (5000 req/hour); falls back to anonymous (60/hr).
// Run via `npm run fetch:posts` or as a CI step before `vite build`.

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = 'leafvmaple'
const REPO = 'blog'
const API = 'https://api.github.com'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'public', 'data')
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

// Split an issue title on `||` into per-language variants.
//   "中文标题 || 日本語タイトル"  -> { zh: '中文标题', ja: '日本語タイトル' }
//   "仅中文标题"                  -> { zh: '仅中文标题' }
// Order is fixed to LANG_ORDER so author just writes "zh || ja".
const TITLE_LANG_ORDER = ['zh', 'ja']
function splitTitle(title) {
  const parts = (title || '').split('||').map(s => s.trim()).filter(Boolean)
  const out = {}
  if (parts.length <= 1) {
    out.zh = (title || '').trim()
    return out
  }
  for (let i = 0; i < parts.length && i < TITLE_LANG_ORDER.length; i++) {
    out[TITLE_LANG_ORDER[i]] = parts[i]
  }
  return out
}

function pickIssue(i) {
  const titles = splitTitle(i.title)
  return {
    id: i.id,
    number: i.number,
    title: titles.zh || i.title,
    titles,
    body: i.body,
    bodies: splitLangs(i.body),
    html_url: i.html_url,
    created_at: i.created_at,
    comments: i.comments,
    user: {
      login: i.user.login,
      avatar_url: i.user.avatar_url,
    },
    labels: (i.labels || []).map(l => ({ name: l.name, color: l.color })),
  }
}

function pickComment(c) {
  return {
    id: c.id,
    body: c.body,
    created_at: c.created_at,
    html_url: c.html_url,
    user: {
      login: c.user.login,
      avatar_url: c.user.avatar_url,
      html_url: c.user.html_url,
    },
  }
}

async function main() {
  console.log(`[fetch-posts] fetching issues for ${OWNER}/${REPO}…`)
  // Filter out pull requests; GitHub returns PRs in the issues endpoint.
  const raw = await paginate(`/repos/${OWNER}/${REPO}/issues?state=open&creator=${OWNER}`)
  const issues = raw.filter(i => !i.pull_request).map(pickIssue)
  // Newest first to match the API default; keep deterministic order.
  issues.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  console.log(`[fetch-posts] ${issues.length} issue(s).`)

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
      comments = raw.map(pickComment)
    }
    await writeFile(
      resolve(OUT_POSTS_DIR, `${issue.number}.json`),
      JSON.stringify({ issue, comments }, null, 2) + '\n',
      'utf8',
    )
  }

  console.log(`[fetch-posts] wrote ${OUT_DIR}`)
}

main().catch(err => {
  console.error('[fetch-posts] failed:', err)
  process.exit(1)
})
