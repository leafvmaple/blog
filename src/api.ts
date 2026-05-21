// Same-origin data layer. Posts and comments are snapshotted at build time by
// scripts/fetch-posts.mjs and shipped under /data/. This avoids burning the
// anonymous GitHub API quota (60/hr per IP) on every visitor.

const DATA_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/data`

export interface Issue {
  id: number
  number: number
  title: string
  body: string
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
  body: string
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
const detailCache = new Map<number, Promise<PostDetail>>()

function loadAllPosts(): Promise<Issue[]> {
  if (!postsPromise) {
    postsPromise = fetch(`${DATA_BASE}/posts.json`, { cache: 'no-cache' }).then(res => {
      if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status}`)
      return res.json() as Promise<Issue[]>
    })
  }
  return postsPromise
}

function loadDetail(number: number): Promise<PostDetail> {
  let p = detailCache.get(number)
  if (!p) {
    p = fetch(`${DATA_BASE}/posts/${number}.json`, { cache: 'no-cache' }).then(res => {
      if (!res.ok) throw new Error(`Failed to fetch post ${number}: ${res.status}`)
      return res.json() as Promise<PostDetail>
    })
    detailCache.set(number, p)
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
