import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getIssue, isHiddenLabel } from '../api'
import type { Issue } from '../api'
import Comments from '../components/Comments'
import { useLang, useT, localeOf, pickLocalized, useLabelT } from '../i18n'
import { parseMarkdown } from '../markdown'
import 'github-markdown-css/github-markdown.css'
import './PostDetail.css'

export default function PostDetail() {
  const { number } = useParams<{ number: string }>()
  const { lang } = useLang()
  const t = useT()
  const labelT = useLabelT()
  const [issue, setIssue] = useState<Issue | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!number) return
    getIssue(parseInt(number))
      .then(setIssue)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [number])

  const html = useMemo(() => {
    if (!issue) return ''
    const body = pickLocalized(issue.bodies, lang, issue.body || '')
    return parseMarkdown(body).replace(/^<h1[^>]*>.*?<\/h1>\s*/i, '')
  }, [issue, lang])

  if (loading) return <div className="detail-state">{t.loading}</div>
  if (error || !issue) return (
    <div className="detail-state detail-error-state">
      <p>{t.post_not_found}</p>
      <Link to="/blog">{t.back_to_list}</Link>
    </div>
  )

  const title = pickLocalized(issue.titles, lang, issue.title)
  const visibleLabels = issue.labels.filter(l => !isHiddenLabel(l.name))

  return (
    <div className="post-detail">
      <nav className="detail-nav">
        <Link to="/blog">{t.all_posts_link}</Link>
      </nav>
      <article className="detail-article">
        <h1 className="detail-title">{title}</h1>
        <div className="detail-meta">
          <time>{new Date(issue.created_at).toLocaleDateString(localeOf(lang))}</time>
          {visibleLabels.map(label => (
            <span
              key={label.name}
              className="post-label"
              style={{ background: `#${label.color}20`, color: `#${label.color}`, borderColor: `#${label.color}40` }}
            >
              {labelT(label.name)}
            </span>
          ))}
          <a
            href={issue.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="detail-github-link"
          >
            {t.view_on_github}
          </a>
        </div>
        <div
          className="markdown-body detail-body"
          data-color-mode="auto"
          data-light-theme="light"
          data-dark-theme="dark"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </article>
      <Comments issueNumber={issue.number} issueUrl={issue.html_url} totalComments={issue.comments} />
    </div>
  )
}
