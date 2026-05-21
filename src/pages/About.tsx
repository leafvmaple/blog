import './About.css'

export default function About() {
  return (
    <div className="about">
      <section className="about-hero">
        <img className="about-avatar" src="/assets/avatar.png" alt="avatar" />
        <div className="about-hero-text">
          <h1 className="about-name">Zohar Lee</h1>
          <p className="about-role">Senior Game Developer · AI Native Engineer · Engine & OS Hacker</p>
          <div className="about-links">
            <a className="about-link-btn" target="_blank" rel="noopener noreferrer" href="https://github.com/leafvmaple">
              <svg height="16" viewBox="0 0 16 16" width="16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path></svg>
              GitHub
            </a>
          </div>
        </div>
      </section>

      <section className="about-section">
        <h2 className="about-section-title">AI Native</h2>
        <div className="ai-native-card">
          <div className="ai-native-badge">AI Native · Senior Game Developer</div>
          <p className="ai-native-desc">
            我的日常工作与技术探索方式已经完全 AI 化。作为一名拥有 10 年经验、专注 Gameplay 表现层（动画 / 特效 / 渲染同步）
            与引擎底层的资深开发者，AI Agent 已经成为我的核心协作者——从超大规模 C++ 代码库的维护、重构、跨引擎
            （自研引擎到 UE5 / Unity）架构迁移，到个人操作系统内核的探索，它不只是代码补全，而是真正能与我并肩攻坚的重度结对编程伙伴。
          </p>
          <ul className="ai-native-list">
            <li>
              <span className="ai-dot" />
              <span><strong>Vibe Coding — 表现层与复杂逻辑的自然语言驱动</strong>：以自然语言驱动复杂的 Gameplay 表现层迭代，将动画状态机反馈、特效触发、渲染同步等宏观表现需求智能化拆解，把精力从微观 C++ 语法细节中解放出来，专注商业引擎与自研引擎的底层架构决策、AAA 级性能优化与表现力落地。</span>
            </li>
            <li>
              <span className="ai-dot" />
              <span><strong>跨引擎与跨架构迁移 — 复杂系统演进的 AI 结对攻坚</strong>：借助 AI 的上下文分析能力，辅助自研引擎底层逻辑向 Unreal Engine 5 / Unity 迁移与解耦，以及个人 OS 内核在 x86_64 / aarch64 间的平滑演进；让 AI 承担繁琐的底层 API 转换与模板代码，人则专注内存管理、多线程同步及系统级性能调优等核心难点。</span>
            </li>
            <li>
              <span className="ai-dot" />
              <span><strong>游戏工作流重塑 — AI 辅助策划与数据流转</strong>：针对游戏开发繁重的技术 PM 属性，构建 AI 辅助的数据表（Data Table）智能查询与流转管线，打通策划设计需求到技术实现的链路，消除技术与策划之间的信息鸿沟，自动化重构游戏资产、优化研发管线。</span>
            </li>
            <li>
              <span className="ai-dot" />
              <span><strong>领域知识工程 — 打造全栈私有技术大脑</strong>：将 10 年沉淀的自研引擎底层逻辑、现代 C++ 最佳实践、商业引擎核心技术以及底层系统级开发文档融会贯通，构建专属的 AI 辅助知识图谱，实现复杂技术问题的秒级智能检索。</span>
            </li>
          </ul>
          <p className="ai-native-desc" style={{ marginTop: '1.25em', fontStyle: 'italic', opacity: 0.85 }}>
            “让 AI 去处理繁琐的微观构建，让我专注于宏观的架构艺术与极致的表现力。”
          </p>
        </div>
      </section>

      <section className="about-section">
        <h2 className="about-section-title">Tech Stack</h2>
        <div className="about-stack">
          <p>C++ &middot; C &middot; Lua &middot; Python &middot; TypeScript &middot; C# &middot; Assembly</p>
          <p>Unreal Engine 5 &middot; Unity &middot; 自研引擎 &middot; Direct3D 11 &middot; Animation / VFX / Rendering</p>
          <p>OS Kernel &middot; x86_64 &middot; aarch64 &middot; Linux &middot; Windows &middot; macOS</p>
        </div>
      </section>

      <section className="about-section">
        <h2 className="about-section-title">Projects</h2>

        <a
          className="project-card project-card-featured"
          href="https://github.com/leafvmaple/Zongine"
          target="_blank"
          rel="noopener noreferrer"
        >
          <div className="project-card-header">
            <span className="project-name">Zongine</span>
            <div className="project-card-right">
              <span className="project-since">since Mar 2025</span>
            </div>
          </div>
          <p className="project-desc">
            自研 C++ 游戏引擎实验项目。沉淀 10 年 Gameplay 表现层（动画 / 特效 / 渲染同步）与引擎底层经验，
            从渲染管线、资源系统到 ECS 架构全部自己写，作为 AI Native 重度结对编程的实践场。
          </p>
          <div className="project-tags">
            <span>C++</span>
            <span>Game Engine</span>
            <span>Rendering</span>
            <span>ECS</span>
          </div>
        </a>

        <div className="project-grid">
          <a
            className="project-card"
            href="https://github.com/leafvmaple/Sword-UE5"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="project-card-header">
              <span className="project-name">Sword-UE5</span>
              <div className="project-card-right">
                <span className="project-since">since Mar 2026</span>
              </div>
            </div>
            <p className="project-desc">
              基于 Unreal Engine 5 的武侠 Gameplay 原型，自研引擎能力向 UE5 迁移的实践项目，
              聚焦动画 / 特效 / 渲染同步等表现层落地。
            </p>
            <div className="project-tags">
              <span>C++</span>
              <span>Unreal Engine 5</span>
              <span>Gameplay</span>
            </div>
          </a>

          <a
            className="project-card"
            href="https://github.com/leafvmaple/Wuxia-Unity"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="project-card-header">
              <span className="project-name">Wuxia-Unity</span>
              <div className="project-card-right">
                <span className="project-since">since Mar 2026</span>
              </div>
            </div>
            <p className="project-desc">
              Unity 引擎下的武侠 Gameplay 原型，与 Sword-UE5 互为参照，
              用于打通跨引擎能力对齐与表现层一致性验证。
            </p>
            <div className="project-tags">
              <span>C#</span>
              <span>Unity</span>
              <span>Gameplay</span>
            </div>
          </a>

          <a
            className="project-card"
            href="https://github.com/leafvmaple/zonix"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="project-card-header">
              <span className="project-name">zonix</span>
              <div className="project-card-right">
                <span className="project-since">since Oct 2025</span>
              </div>
            </div>
            <p className="project-desc">
              个人操作系统内核探索项目。从引导、内存管理到调度的逐步自研实践，
              目标支持 x86_64 / aarch64 双架构平滑演进，是系统级编程的练兵场。
            </p>
            <div className="project-tags">
              <span>C</span>
              <span>OS Kernel</span>
              <span>x86_64</span>
              <span>aarch64</span>
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
                <span className="project-since">since Apr 2019</span>
                <span className="project-stars">★ 28</span>
              </div>
            </div>
            <p className="project-desc">
              已发布到 PyPI 的工具库，可将 Python 列表 / 字典序列化为 Lua table，
              专为游戏策划数据表与 Lua 配置文件流转设计。
            </p>
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
