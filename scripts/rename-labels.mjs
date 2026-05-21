// One-off script: rename Chinese-only labels in the blog repo to canonical
// English names so the i18n dictionary can translate every locale uniformly.
// Run once with GITHUB_TOKEN set (or via gh auth token).
//
//   $env:GITHUB_TOKEN = gh auth token
//   node scripts/rename-labels.mjs

const OWNER = 'leafvmaple'
const REPO = 'blog'

const RENAMES = [
  { from: '游戏引擎', to: 'game-engine' },
  { from: '渲染', to: 'rendering' },
  { from: '复盘', to: 'recap' },
]

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN not set. Try: $env:GITHUB_TOKEN = gh auth token')
  process.exit(1)
}

for (const { from, to } of RENAMES) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/labels/${encodeURIComponent(from)}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': `${OWNER}-blog-rename-labels`,
    },
    body: JSON.stringify({ new_name: to }),
  })
  if (!res.ok) {
    console.error(`[${from} -> ${to}] ${res.status} ${res.statusText}: ${await res.text()}`)
    continue
  }
  console.log(`[ok] ${from} -> ${to}`)
}
