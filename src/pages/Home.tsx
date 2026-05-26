import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getIssues, isPinned, type Issue } from '../api'
import Post from '../components/Post'
import { useT } from '../i18n'
import { useDocumentMeta } from '../useDocumentMeta'
import './Home.css'

const PER_PAGE = 20

export default function Home() {
  const t = useT()
  useDocumentMeta({ title: t.home_title, description: t.site_description })
  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const loadPage = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const data = await getIssues(p, PER_PAGE)
      setIssues(prev => p === 1 ? data : [...prev, ...data])
      if (data.length < PER_PAGE) setHasMore(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadPage(1) }, [loadPage])

  useEffect(() => {
    if (!hasMore || loading) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        setPage(p => p + 1)
      }
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading])

  useEffect(() => {
    if (page > 1) loadPage(page)
  }, [page, loadPage])

  // Pinned posts sit in their own group at the top; the rest are grouped by year.
  const pinnedIssues = issues.filter(isPinned)
  const datedIssues = issues.filter(i => !isPinned(i))

  const rows: Array<
    | { type: 'pinned-header' }
    | { type: 'year'; year: number }
    | { type: 'post'; issue: Issue; pinned?: boolean }
  > = []
  if (pinnedIssues.length > 0) {
    rows.push({ type: 'pinned-header' })
    for (const issue of pinnedIssues) rows.push({ type: 'post', issue, pinned: true })
  }
  let lastYear: number | null = null
  for (const issue of datedIssues) {
    const year = new Date(issue.created_at).getFullYear()
    if (year !== lastYear) {
      rows.push({ type: 'year', year })
      lastYear = year
    }
    rows.push({ type: 'post', issue })
  }

  return (
    <div className="home">
      <h2 className="home-section-title">{t.home_title}</h2>
      {error && <div className="home-error">{t.load_failed}</div>}
      <div className="post-list">
        {rows.map(row => {
          if (row.type === 'pinned-header') {
            return (
              <div key="pinned-header" className="post-year-divider post-pinned-divider">
                <span>📌 {t.home_pinned}</span>
              </div>
            )
          }
          if (row.type === 'year') {
            return (
              <div key={`year-${row.year}`} className="post-year-divider">
                <span>{row.year}</span>
              </div>
            )
          }
          return <Post key={`${row.pinned ? 'pin-' : ''}${row.issue.id}`} issue={row.issue} />
        })}
      </div>
      {loading && <div className="home-loading">{t.loading}</div>}
      {!hasMore && issues.length > 0 && (
        <div className="home-end">
          <span className="home-end-sentinel">{t.all_posts_loaded}</span>
          <Link to="/archive" className="home-archive-link">{t.archive_link}</Link>
        </div>
      )}
      <div ref={sentinelRef} />
    </div>
  )
}
