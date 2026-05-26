import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getIssue, getAllIssues, isHiddenLabel } from '../api'
import type { Issue } from '../api'
import Comments from '../components/Comments'
import { useLang, useT, localeOf, pickLocalized, useLabelT } from '../i18n'
import { useDocumentMeta } from '../useDocumentMeta'
import { useCodeCopy } from '../useCodeCopy'
import { siblingsInSeries } from '../series'
import 'github-markdown-css/github-markdown.css'
import './PostDetail.css'

export default function PostDetail() {
  const { number } = useParams<{ number: string }>()
  const { lang } = useLang()
  const t = useT()
  const labelT = useLabelT()
  const [issue, setIssue] = useState<Issue | null>(null)
  const [allIssues, setAllIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useCodeCopy(bodyRef)

  useEffect(() => {
    if (!number) return
    getIssue(parseInt(number))
      .then(setIssue)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [number])

  // Load all-issues snapshot so prev/next cards can show real titles, not just
  // "#13". loadAllPosts is globally cached so this is free if any other page
  // (Home, Archive, Label, Series) has already touched the data.
  useEffect(() => {
    getAllIssues().then(setAllIssues).catch(() => { /* prev/next is non-critical */ })
  }, [])

  const html = issue ? pickLocalized(issue.bodiesHtml, lang, '') : ''
  const metaTitle = issue ? pickLocalized(issue.titles, lang, issue.title) : undefined
  const metaDesc = issue ? pickLocalized(issue.descriptions, lang, '') : undefined
  useDocumentMeta({ title: metaTitle, description: metaDesc })

  if (loading) return <div className="detail-state">{t.loading}</div>
  if (error || !issue) return (
    <div className="detail-state detail-error-state">
      <p>{t.post_not_found}</p>
      <Link to="/blog">{t.back_to_list}</Link>
    </div>
  )

  const title = pickLocalized(issue.titles, lang, issue.title)
  const visibleLabels = issue.labels.filter(l => !isHiddenLabel(l.name))

  const siblings = siblingsInSeries(issue.number)
  const prevIssue = siblings.prev !== undefined ? allIssues.find(i => i.number === siblings.prev) : undefined
  const nextIssue = siblings.next !== undefined ? allIssues.find(i => i.number === siblings.next) : undefined

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
            <Link
              key={label.name}
              to={`/label/${encodeURIComponent(label.name)}`}
              className="post-label"
              style={{ background: `#${label.color}20`, color: `#${label.color}`, borderColor: `#${label.color}40` }}
            >
              {labelT(label.name)}
            </Link>
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
          ref={bodyRef}
          className="markdown-body detail-body"
          data-color-mode="auto"
          data-light-theme="light"
          data-dark-theme="dark"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </article>
      {siblings.series && (siblings.prev !== undefined || siblings.next !== undefined) && (
        <nav className="post-siblings" aria-label="Series navigation">
          <div className="post-siblings-breadcrumb">
            <span className="post-siblings-label">{t.series_in}</span>
            <Link to={`/series/${siblings.series.slug}`} className="post-siblings-series">
              {pickLocalized(siblings.series.titles, lang, siblings.series.slug)}
            </Link>
          </div>
          <div className="post-siblings-row">
            {siblings.prev !== undefined ? (
              <Link to={`/post/${siblings.prev}`} className="post-sibling post-sibling-prev">
                <span className="post-sibling-dir">← {t.series_prev}</span>
                <span className="post-sibling-headline">
                  <span className="post-sibling-num">#{siblings.prev}</span>
                  {prevIssue && (
                    <span className="post-sibling-title">
                      {pickLocalized(prevIssue.titles, lang, prevIssue.title)}
                    </span>
                  )}
                </span>
              </Link>
            ) : <span className="post-sibling-placeholder" />}
            {siblings.next !== undefined ? (
              <Link to={`/post/${siblings.next}`} className="post-sibling post-sibling-next">
                <span className="post-sibling-dir">{t.series_next} →</span>
                <span className="post-sibling-headline">
                  <span className="post-sibling-num">#{siblings.next}</span>
                  {nextIssue && (
                    <span className="post-sibling-title">
                      {pickLocalized(nextIssue.titles, lang, nextIssue.title)}
                    </span>
                  )}
                </span>
              </Link>
            ) : <span className="post-sibling-placeholder" />}
          </div>
        </nav>
      )}
      <Comments issueNumber={issue.number} issueUrl={issue.html_url} totalComments={issue.comments} />
    </div>
  )
}
