import { useT } from '../i18n'
import './About.css'

export default function About() {
  const t = useT()
  return (
    <div className="about">
      <section className="about-hero">
        <img className="about-avatar" src="/assets/avatar.jpg" alt="avatar" />
        <div className="about-hero-text">
          <h1 className="about-name">Zohar Lee</h1>
          <p className="about-role">{t.about_role}</p>
          <div className="about-links">
            <a className="about-link-btn" target="_blank" rel="noopener noreferrer" href="https://github.com/leafvmaple">
              <svg height="16" viewBox="0 0 16 16" width="16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path></svg>
              GitHub
            </a>
          </div>
        </div>
      </section>

      <section className="about-section">
        <h2 className="about-section-title">{t.about_ai_native_title}</h2>
        <div className="ai-native-card">
          <div className="ai-native-badge">{t.about_ai_native_badge}</div>
          <p className="ai-native-desc">{t.about_ai_native_intro}</p>
          <ul className="ai-native-list">
            {t.about_ai_native_items.map(item => (
              <li key={item.title}>
                <span className="ai-dot" />
                <span><strong>{item.title}</strong>：{item.desc}</span>
              </li>
            ))}
          </ul>
          <p className="ai-native-desc" style={{ marginTop: '1.25em', fontStyle: 'italic', opacity: 0.85 }}>
            {t.about_ai_native_quote}
          </p>
        </div>
      </section>

      <section className="about-section">
        <h2 className="about-section-title">{t.about_tech_stack_title}</h2>
        <div className="about-stack">
          {t.about_tech_stack.map(line => <p key={line}>{line}</p>)}
        </div>
      </section>

      <section className="about-section">
        <h2 className="about-section-title">{t.about_projects_title}</h2>

        <a
          className="project-card project-card-featured"
          href="https://github.com/leafvmaple/zonix-plus"
          target="_blank"
          rel="noopener noreferrer"
        >
          <div className="project-card-header">
            <span className="project-name">zonix-plus · Zonix OS</span>
            <div className="project-card-right">
              <span className="project-since">{t.about_project_since} Jan 2026</span>
            </div>
          </div>
          <p className="project-desc">{t.about_project_zonix_desc}</p>
          <div className="project-tags">
            <span>C++17</span>
            <span>OS Kernel</span>
            <span>x86_64</span>
            <span>aarch64</span>
            <span>riscv64</span>
            <span>UEFI</span>
            <span>Clang/LLVM</span>
          </div>
        </a>

        <div className="project-grid">
          <a
            className="project-card"
            href="https://github.com/leafvmaple/zcc"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="project-card-header">
              <span className="project-name">zcc</span>
              <div className="project-card-right">
                <span className="project-since">{t.about_project_since} Jul 2024</span>
              </div>
            </div>
            <p className="project-desc">{t.about_project_zcc_desc}</p>
            <div className="project-tags">
              <span>C++</span>
              <span>Compiler</span>
              <span>Flex/Bison</span>
              <span>LLVM</span>
            </div>
          </a>

          <a
            className="project-card"
            href="https://github.com/leafvmaple/pylua"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="project-card-header">
              <span className="project-name">PyLua</span>
              <div className="project-card-right">
                <span className="project-since">{t.about_project_since} Jan 2026</span>
              </div>
            </div>
            <p className="project-desc">{t.about_project_pylua_desc}</p>
            <div className="project-tags">
              <span>Python</span>
              <span>Lua</span>
              <span>Interpreter</span>
              <span>VM</span>
            </div>
          </a>

          <a
            className="project-card"
            href="https://github.com/leafvmaple/luadata"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="project-card-header">
              <span className="project-name">luadata</span>
              <div className="project-card-right">
                <span className="project-since">{t.about_project_since} Apr 2019</span>
                <span className="project-stars">★ 28</span>
                <span className="project-live">PyPI ↗</span>
              </div>
            </div>
            <p className="project-desc">{t.about_project_luadata_desc}</p>
            <div className="project-tags">
              <span>Python</span>
              <span>Lua</span>
              <span>PyPI</span>
              <span>Data Pipeline</span>
            </div>
          </a>
        </div>
      </section>
    </div>
  )
}
