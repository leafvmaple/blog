import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getAllIssues, type Issue } from '../api'
import { useLang, useT, localeOf, pickLocalized } from '../i18n'
import { useDocumentMeta } from '../useDocumentMeta'
import './Archive.css'

type Row =
  | { type: 'year'; year: number; count: number }
  | { type: 'post'; issue: Issue }

function group(issues: Issue[]): Row[] {
  const rows: Row[] = []
  let lastYear: number | null = null
  let yearCount = 0
  let yearIdx = -1
  for (const issue of issues) {
    const year = new Date(issue.created_at).getFullYear()
    if (year !== lastYear) {
      if (yearIdx >= 0) (rows[yearIdx] as { type: 'year'; year: number; count: number }).count = yearCount
      rows.push({ type: 'year', year, count: 0 })
      yearIdx = rows.length - 1
      yearCount = 0
      lastYear = year
    }
    rows.push({ type: 'post', issue })
    yearCount++
  }
  if (yearIdx >= 0) (rows[yearIdx] as { type: 'year'; year: number; count: number }).count = yearCount
  return rows
}

export default function Archive() {
  const { lang } = useLang()
  const t = useT()
  useDocumentMeta({ title: t.archive_title, description: t.archive_description })

  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAllIssues()
      .then(setIssues)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="archive-state">{t.loading}</div>
  if (error) return <div className="archive-state">{t.load_failed}</div>

  const rows = group(issues)
  const dateFmt = new Intl.DateTimeFormat(localeOf(lang), { month: '2-digit', day: '2-digit' })

  return (
    <div className="archive">
      <header className="archive-header">
        <h1 className="archive-title">{t.archive_title}</h1>
        <p className="archive-subtitle">
          {t.archive_count_prefix}{issues.length}{t.archive_count_suffix}
        </p>
      </header>
      <div className="archive-list">
        {rows.map(row => {
          if (row.type === 'year') {
            return (
              <div key={`y-${row.year}`} className="archive-year">
                <span className="archive-year-num">{row.year}</span>
                <span className="archive-year-count">{row.count}</span>
              </div>
            )
          }
          const issue = row.issue
          return (
            <Link key={issue.id} className="archive-row" to={`/post/${issue.number}`}>
              <time className="archive-row-date" dateTime={issue.created_at}>
                {dateFmt.format(new Date(issue.created_at))}
              </time>
              <span className="archive-row-num">#{issue.number}</span>
              <span className="archive-row-title">{pickLocalized(issue.titles, lang, issue.title)}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
