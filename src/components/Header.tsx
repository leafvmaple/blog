import { Link } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import './Header.css'

export default function Header() {
  const { lang, setLang } = useLang()
  const t = useT()
  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="header-brand">
          <img className="header-avatar" src="/assets/avatar.jpg" alt="avatar" />
          <span className="header-name">Zohar Lee</span>
        </Link>
        <nav className="header-nav">
          <Link to="/blog">{t.nav_blog}</Link>
          <a target="_blank" rel="noopener noreferrer" href="https://github.com/leafvmaple">GitHub</a>
          <button
            type="button"
            className="header-lang"
            onClick={() => setLang(lang === 'zh' ? 'ja' : 'zh')}
            aria-label="switch language"
            title={t.switch_lang_label}
          >
            {t.switch_lang_label}
          </button>
        </nav>
      </div>
    </header>
  )
}
