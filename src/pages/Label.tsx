import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getAllIssues, isHiddenLabel, type Issue } from '../api'
import Post from '../components/Post'
import { useT, translateLabel, useLang } from '../i18n'
import { useDocumentMeta } from '../useDocumentMeta'
import './Label.css'

export default function Label() {
  const { name } = useParams<{ name: string }>()
  const { lang } = useLang()
  const t = useT()
  const labelName = name ? decodeURIComponent(name) : ''
  const localized = translateLabel(labelName, lang)

  useDocumentMeta({
    title: `${t.label_title_prefix}${localized}`,
    description: `${t.label_title_prefix}${localized}`,
  })

  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAllIssues()
      .then(setIssues)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const matched = useMemo(() => {
    const target = labelName.toLowerCase()
    return issues.filter(i =>
      i.labels.some(l => l.name.toLowerCase() === target && !isHiddenLabel(l.name)),
    )
  }, [issues, labelName])

  // Lift the label's color from the first match so the chip on this page
  // matches what readers just clicked on. Falls back to neutral gray.
  const sample = matched.find(i => i.labels.some(l => l.name.toLowerCase() === labelName.toLowerCase()))
  const colorHex = sample?.labels.find(l => l.name.toLowerCase() === labelName.toLowerCase())?.color || '888888'

  if (loading) return <div className="label-state">{t.loading}</div>
  if (error) return <div className="label-state">{t.load_failed}</div>

  return (
    <div className="label-page">
      <nav className="label-nav">
        <Link to="/blog">{t.all_posts_link}</Link>
      </nav>
      <header className="label-header">
        <h1 className="label-title">
          <span className="label-title-prefix">{t.label_title_prefix}</span>
          <span
            className="label-chip"
            style={{ background: `#${colorHex}20`, color: `#${colorHex}`, borderColor: `#${colorHex}40` }}
          >
            {localized}
          </span>
        </h1>
        <p className="label-count">
          {t.label_count_prefix}{matched.length}{t.label_count_suffix}
        </p>
      </header>
      {matched.length === 0 ? (
        <div className="label-empty">{t.label_not_found}</div>
      ) : (
        <div className="post-list">
          {matched.map(issue => <Post key={issue.id} issue={issue} />)}
        </div>
      )}
    </div>
  )
}
