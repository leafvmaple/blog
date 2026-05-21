import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LANGS, LANG_LABELS, useLang, useT } from '../i18n'
import './Header.css'

export default function Header() {
  const { lang, setLang } = useLang()
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

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
          <div className="header-lang-wrap" ref={wrapRef}>
            <button
              type="button"
              className="header-lang"
              onClick={() => setOpen(o => !o)}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={t.switch_lang_label}
              title={t.switch_lang_label}
            >
              <span>{LANG_LABELS[lang]}</span>
              <svg className="header-lang-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 4 L5 7 L8 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {open && (
              <ul className="header-lang-menu" role="listbox" aria-label={t.switch_lang_label}>
                {LANGS.map(l => (
                  <li key={l} role="none">
                    <button
                      type="button"
                      role="option"
                      aria-selected={l === lang}
                      className={'header-lang-item' + (l === lang ? ' is-active' : '')}
                      onClick={() => {
                        setLang(l)
                        setOpen(false)
                      }}
                    >
                      {LANG_LABELS[l]}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </nav>
      </div>
    </header>
  )
}
