import { Link } from 'react-router-dom'
import { useT } from '../i18n'
import { useDocumentMeta } from '../useDocumentMeta'
import './NotFound.css'

export default function NotFound() {
  const t = useT()
  useDocumentMeta({ title: '404', description: t.not_found })
  return (
    <div className="not-found">
      <h1>404</h1>
      <p>Page not found</p>
      <Link to="/">← Back to Home</Link>
    </div>
  )
}
