import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getAllIssues, type Issue } from '../api'
import Post from '../components/Post'
import { useT, useLang, pickLocalized } from '../i18n'
import { getSeries } from '../series'
import { useDocumentMeta } from '../useDocumentMeta'
import './Series.css'

export default function Series() {
  const { slug } = useParams<{ slug: string }>()
  const { lang } = useLang()
  const t = useT()
  const def = slug ? getSeries(slug) : undefined

  const title = def ? pickLocalized(def.titles, lang, def.slug) : t.series_not_found
  const blurb = def ? pickLocalized(def.blurbs, lang, '') : ''
  useDocumentMeta({ title, description: blurb })

  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!def) {
      setLoading(false)
      return
    }
    getAllIssues()
      .then(setIssues)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [def])

  // Preserve series-config issue order (= reading order). Filter out posts
  // that haven't been published yet so a config entry referencing a future
  // issue doesn't render an empty card.
  const ordered = useMemo(() => {
    if (!def) return []
    const byNumber = new Map(issues.map(i => [i.number, i]))
    return def.issues
      .map(n => byNumber.get(n))
      .filter((x): x is Issue => x !== undefined)
  }, [def, issues])

  if (!def) return (
    <div className="series-page series-state">
      <p>{t.series_not_found}</p>
      <Link to="/blog">{t.back_to_list}</Link>
    </div>
  )
  if (loading) return <div className="series-page series-state">{t.loading}</div>
  if (error) return <div className="series-page series-state">{t.load_failed}</div>

  return (
    <div className="series-page">
      <nav className="series-nav">
        <Link to="/blog">{t.all_posts_link}</Link>
      </nav>
      <header className="series-header">
        <h1 className="series-title">{title}</h1>
        {blurb && <p className="series-blurb">{blurb}</p>}
        <div className="series-meta">
          <span className="series-count">{ordered.length}{t.series_post_count_suffix}</span>
          {def.repoUrl && (
            <a
              href={def.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="series-repo"
            >
              {t.series_repo_link}
            </a>
          )}
        </div>
      </header>
      <div className="post-list">
        {ordered.map(issue => (
          <Post key={issue.id} issue={issue} />
        ))}
      </div>
    </div>
  )
}
