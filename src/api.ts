// Same-origin data layer. Posts and comments are snapshotted at build time by
// scripts/fetch-posts.mjs and shipped under /data/. This avoids burning the
// anonymous GitHub API quota (60/hr per IP) on every visitor.

const DATA_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/data`

export interface Issue {
  id: number
  number: number
  title: string
  /**
   * Per-language titles, from `<!--title:xx-->` markers (or legacy `中文 || 日本語`).
   * Falls back to the raw Issue title when a locale has no localized title.
   */
  titles: Record<string, string>
  /**
   * Per-language pre-rendered HTML, from `<!--lang:xx-->...<!--/lang:xx-->` blocks
   * run through marked + shiki at build time. Leading <h1> is stripped (it's
   * already rendered in the post page header).
   */
  bodiesHtml: Record<string, string>
  /** Per-language plain-text excerpt (~200 chars) for meta description / RSS. */
  descriptions: Record<string, string>
  html_url: string
  created_at: string
  comments: number
  user: {
    login: string
    avatar_url: string
  }
  labels: Array<{
    name: string
    color: string
  }>
}

export interface Comment {
  id: number
  /** Pre-rendered HTML, marked + shiki at build time. */
  bodyHtml: string
  created_at: string
  html_url: string
  user: {
    login: string
    avatar_url: string
    html_url: string
  }
}

interface PostDetail {
  issue: Issue
  comments: Comment[]
}

let postsPromise: Promise<Issue[]> | null = null

// Tiny LRU on per-post detail responses. Map keeps insertion order, so
// touching a key = delete + re-set (moves to end), and eviction = drop the
// oldest key when over cap. The cap is small because real readers only ever
// view a handful of posts per session; the bound is to keep crawlers /
// long-lived tabs from growing memory unboundedly.
const DETAIL_CACHE_MAX = 10
const detailCache = new Map<number, Promise<PostDetail>>()

// Issues carrying this label (case-insensitive) float to the top of the home
// list, in the same relative order they had among themselves.
const PIN_LABEL = 'pinned'

// Functional-only labels: read by code (e.g. `pinned` controls home-page
// sort) but not shown as a badge on post cards or in post detail meta.
// Compared case-insensitively.
const HIDDEN_LABELS = new Set<string>([PIN_LABEL])

export function isPinned(issue: Issue): boolean {
  return issue.labels.some(l => l.name.toLowerCase() === PIN_LABEL)
}

export function isHiddenLabel(name: string): boolean {
  return HIDDEN_LABELS.has(name.toLowerCase())
}

function loadAllPosts(): Promise<Issue[]> {
  if (!postsPromise) {
    postsPromise = fetch(`${DATA_BASE}/posts.json`, { cache: 'no-cache' })
      .then(res => {
        if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status}`)
        return res.json() as Promise<Issue[]>
      })
      .then((arr: Issue[]) => {
        const pinned = arr.filter(isPinned)
        const rest = arr.filter(i => !isPinned(i))
        return [...pinned, ...rest]
      })
  }
  return postsPromise
}

function loadDetail(number: number): Promise<PostDetail> {
  const hit = detailCache.get(number)
  if (hit) {
    // Touch: re-insert to mark as most-recently used.
    detailCache.delete(number)
    detailCache.set(number, hit)
    return hit
  }
  const p = fetch(`${DATA_BASE}/posts/${number}.json`, { cache: 'no-cache' }).then(res => {
    if (!res.ok) throw new Error(`Failed to fetch post ${number}: ${res.status}`)
    return res.json() as Promise<PostDetail>
  })
  detailCache.set(number, p)
  if (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next().value
    if (oldest !== undefined) detailCache.delete(oldest)
  }
  return p
}

export async function getIssues(page = 1, perPage = 20): Promise<Issue[]> {
  const all = await loadAllPosts()
  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}

export async function getIssue(number: number): Promise<Issue> {
  const detail = await loadDetail(number)
  return detail.issue
}

export async function getIssueComments(number: number, page = 1, perPage = 30): Promise<Comment[]> {
  const detail = await loadDetail(number)
  const start = (page - 1) * perPage
  return detail.comments.slice(start, start + perPage)
}
