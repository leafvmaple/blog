import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

export type Lang = 'zh' | 'ja'
export const LANGS: Lang[] = ['zh', 'ja']
export const DEFAULT_LANG: Lang = 'zh'

// Native label for each language, shown in the language picker.
export const LANG_LABELS: Record<Lang, string> = {
  zh: '中文',
  ja: '日本語',
}

const STORAGE_KEY = 'lang'

// Detect from navigator.language(s). Falls back to DEFAULT_LANG.
function detectLang(): Lang {
  if (typeof navigator === 'undefined') return DEFAULT_LANG
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const raw of candidates) {
    const tag = (raw || '').toLowerCase()
    if (tag.startsWith('ja')) return 'ja'
    if (tag.startsWith('zh')) return 'zh'
  }
  return DEFAULT_LANG
}

function loadInitial(): Lang {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'ja') return saved
  }
  return detectLang()
}

interface LangCtx {
  lang: Lang
  setLang: (l: Lang) => void
}

const Ctx = createContext<LangCtx>({ lang: DEFAULT_LANG, setLang: () => {} })

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(loadInitial)

  useEffect(() => {
    document.documentElement.lang = lang === 'ja' ? 'ja' : 'zh-CN'
    document.title = T[lang].doc_title
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    localStorage.setItem(STORAGE_KEY, l)
    setLangState(l)
  }, [])

  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>
}

export function useLang() {
  return useContext(Ctx)
}

// Locale tag for Date.toLocaleDateString and similar.
export function localeOf(lang: Lang): string {
  return lang === 'ja' ? 'ja-JP' : 'zh-CN'
}

// UI string dictionary. Keep small; add keys as needed.
export const T = {
  zh: {
    doc_title: 'Zohar Lee - 写代码不赚钱 就交个朋友',
    nav_blog: 'Blog',
    home_title: '文章',
    loading: '加载中...',
    load_failed: '加载失败',
    all_posts_loaded: '· 已加载全部文章 ·',
    back_to_list: '← 返回列表',
    all_posts_link: '← 所有文章',
    view_on_github: '在 GitHub 查看 ↗',
    post_not_found: '文章不存在或加载失败',
    comments_title: '评论',
    comment_on_github: '去 GitHub 评论 ↗',
    no_comments: '暂无评论，去 GitHub 留下第一条评论吧',
    all_comments_loaded: '· 已加载全部评论 ·',
    switch_lang_label: '语言',

    // About page
    about_role: 'Senior Game Developer · AI Native Engineer · Engine & OS Hacker',
    about_ai_native_title: 'AI Native',
    about_ai_native_badge: 'AI Native · Senior Game Developer',
    about_ai_native_intro:
      '我的日常工作与技术探索方式已经完全 AI 化。作为一名拥有 10 年经验、专注 Gameplay 表现层（动画 / 特效 / 渲染同步）与引擎底层的资深开发者，AI Agent 已经成为我的核心协作者——从超大规模 C++ 代码库的维护、重构、跨引擎（自研引擎到 UE5 / Unity）架构迁移，到个人操作系统内核的探索，它不只是代码补全，而是真正能与我并肩攻坚的重度结对编程伙伴。',
    about_ai_native_items: [
      {
        title: 'Vibe Coding — 表现层与复杂逻辑的自然语言驱动',
        desc: '以自然语言驱动复杂的 Gameplay 表现层迭代，将动画状态机反馈、特效触发、渲染同步等宏观表现需求智能化拆解，把精力从微观 C++ 语法细节中解放出来，专注商业引擎与自研引擎的底层架构决策、AAA 级性能优化与表现力落地。',
      },
      {
        title: '跨引擎与跨架构迁移 — 复杂系统演进的 AI 结对攻坚',
        desc: '借助 AI 的上下文分析能力，辅助自研引擎底层逻辑向 Unreal Engine 5 / Unity 迁移与解耦，以及个人 OS 内核在 x86_64 / aarch64 间的平滑演进；让 AI 承担繁琐的底层 API 转换与模板代码，人则专注内存管理、多线程同步及系统级性能调优等核心难点。',
      },
      {
        title: '游戏工作流重塑 — AI 辅助策划与数据流转',
        desc: '针对游戏开发繁重的技术 PM 属性，构建 AI 辅助的数据表（Data Table）智能查询与流转管线，打通策划设计需求到技术实现的链路，消除技术与策划之间的信息鸿沟，自动化重构游戏资产、优化研发管线。',
      },
      {
        title: '领域知识工程 — 打造全栈私有技术大脑',
        desc: '将 10 年沉淀的自研引擎底层逻辑、现代 C++ 最佳实践、商业引擎核心技术以及底层系统级开发文档融会贯通，构建专属的 AI 辅助知识图谱，实现复杂技术问题的秒级智能检索。',
      },
    ],
    about_ai_native_quote: '"让 AI 去处理繁琐的微观构建，让我专注于宏观的架构艺术与极致的表现力。"',

    about_tech_stack_title: 'Tech Stack',
    about_tech_stack: [
      'C++ · C · Lua · Python · TypeScript · C# · Assembly',
      'Unreal Engine 5 · Unity · 自研引擎 · Direct3D 11 · Animation / VFX / Rendering',
      'OS Kernel · x86_64 · aarch64 · Linux · Windows · macOS',
    ],

    about_projects_title: 'Projects',
    about_project_since: 'since',
    about_project_zonix_desc:
      '个人操作系统内核 —— 同时面向 x86_64 / aarch64 / riscv64 三种架构的教学型内核，使用 freestanding C++17 编写。覆盖 BIOS + UEFI 双引导路径、进程管理、含 swap 的虚拟内存、同步原语、抢占式调度、VFS 系统调用与 FAT 文件系统支持，通过 Kconfig 风格的模块化配置驱动，使用 Clang/LLVM 工具链构建。',
    about_project_zcc_desc:
      '用 Flex/Bison 做词法语法分析、对接 LLVM 后端的玩具 C 编译器。用于把编译原理从书本练到落地，理解从前端 AST 到 LLVM IR、再到目标代码的完整链路。',
    about_project_pylua_desc:
      '用 Python 实现的 Lua 解释器 / 虚拟机实验项目：包含 .luac 字节码读取、词法 / 语法分析、AST、简单代码生成与运行时执行，提供 pylua / pyluac 命令行工具，含 print / metatable 等基础内建函数。',
    about_project_luadata_desc:
      '已发布到 PyPI 的开源工具库，可将 Python 列表 / 字典与 Lua table 互相序列化。广泛用于游戏策划数据表与 Lua 配置文件之间的双向流转。',
  },
  ja: {
    doc_title: 'Zohar Lee - コードを書いて稼げないなら、友達になろう',
    nav_blog: 'Blog',
    home_title: '記事',
    loading: '読み込み中...',
    load_failed: '読み込みに失敗しました',
    all_posts_loaded: '· すべての記事を読み込みました ·',
    back_to_list: '← 一覧に戻る',
    all_posts_link: '← 記事一覧',
    view_on_github: 'GitHub で見る ↗',
    post_not_found: '記事が見つからないか、読み込みに失敗しました',
    comments_title: 'コメント',
    comment_on_github: 'GitHub でコメントする ↗',
    no_comments: 'コメントはまだありません。GitHub で最初のコメントを残しましょう',
    all_comments_loaded: '· すべてのコメントを読み込みました ·',
    switch_lang_label: '言語',

    // About page
    about_role: 'シニアゲーム開発者 · AI Native エンジニア · エンジン & OS ハッカー',
    about_ai_native_title: 'AI Native',
    about_ai_native_badge: 'AI Native · シニアゲーム開発者',
    about_ai_native_intro:
      '私の日々の開発と技術探索はすでに完全に AI 化されています。Gameplay 表現層（アニメーション / VFX / レンダリング同期）とエンジン基盤を専門とする10年経験のシニア開発者として、AI Agent は私の中核的な協働パートナーになりました。超大規模 C++ コードベースの保守・リファクタリング、自社エンジンから UE5 / Unity へのクロスエンジン移行、個人 OS カーネルの探索まで、単なるコード補完ではなく、本気で並走できるヘビーペアプログラミング相手です。',
    about_ai_native_items: [
      {
        title: 'Vibe Coding — 表現層と複雑ロジックを自然言語で駆動',
        desc: '自然言語で複雑な Gameplay 表現層のイテレーションを駆動し、アニメーションステートマシンのフィードバック、VFX トリガー、レンダリング同期などのマクロな表現要件を AI にインテリジェントに分解させ、ミクロな C++ 構文の詳細から解放され、商用エンジン・自社エンジンの基盤アーキテクチャ判断、AAA 級のパフォーマンス最適化、表現力の実装に集中できます。',
      },
      {
        title: 'クロスエンジン・クロスアーキテクチャ移行 — 複雑システム進化の AI ペア攻略',
        desc: 'AI のコンテキスト解析力を借りて、自社エンジンの基盤ロジックを Unreal Engine 5 / Unity へ移行・分離し、個人 OS カーネルを x86_64 / aarch64 間でスムーズに進化させます。煩雑な低レベル API 変換やボイラープレートは AI に任せ、人間はメモリ管理、マルチスレッド同期、システム級パフォーマンスチューニングなどの核心難題に集中します。',
      },
      {
        title: 'ゲームワークフローの再構築 — AI 支援の企画・データフロー',
        desc: 'ゲーム開発に重い技術 PM 的性質に対応するため、AI 支援のデータテーブル（Data Table）スマートクエリと流通パイプラインを構築し、企画の設計要件から技術実装までを直結させ、技術と企画の情報の断絶を解消し、ゲームアセットの自動リファクタリングと開発パイプラインの最適化を実現します。',
      },
      {
        title: 'ドメイン知識エンジニアリング — フルスタックの個人技術頭脳の構築',
        desc: '10年蓄積した自社エンジン基盤ロジック、モダン C++ ベストプラクティス、商用エンジンの中核技術、低レベルシステム開発ドキュメントを統合し、専用の AI 支援知識グラフを構築し、複雑な技術課題の秒単位のスマート検索を実現します。',
      },
    ],
    about_ai_native_quote: '「煩雑なミクロ構築は AI に任せ、私はマクロな設計の美学と究極の表現力に集中する。」',

    about_tech_stack_title: 'Tech Stack',
    about_tech_stack: [
      'C++ · C · Lua · Python · TypeScript · C# · Assembly',
      'Unreal Engine 5 · Unity · 自社エンジン · Direct3D 11 · Animation / VFX / Rendering',
      'OS Kernel · x86_64 · aarch64 · Linux · Windows · macOS',
    ],

    about_projects_title: 'Projects',
    about_project_since: 'since',
    about_project_zonix_desc:
      '個人 OS カーネル —— x86_64 / aarch64 / riscv64 の3アーキテクチャ向けの教育用カーネルで、freestanding C++17 で記述。BIOS + UEFI のデュアルブート経路、プロセス管理、swap 付き仮想メモリ、同期プリミティブ、プリエンプティブスケジューラ、VFS システムコール、FAT ファイルシステムをサポート。Kconfig 風のモジュラー設定で駆動し、Clang/LLVM ツールチェーンでビルドします。',
    about_project_zcc_desc:
      'Flex/Bison で字句・構文解析、LLVM バックエンドに繋ぐ玩具 C コンパイラ。コンパイラ理論を本から実装まで落とし込み、フロントエンド AST から LLVM IR、ターゲットコードまでの完全なパイプラインを理解するために作成。',
    about_project_pylua_desc:
      'Python で実装した Lua インタプリタ / VM 実験プロジェクト：.luac バイトコード読み込み、字句・構文解析、AST、シンプルなコード生成と実行時実行を含み、pylua / pyluac CLI ツールと print / metatable などの基本ビルトインを提供。',
    about_project_luadata_desc:
      'PyPI に公開済みの OSS ライブラリ。Python の list / dict と Lua の table を相互シリアライズでき、ゲーム企画のデータテーブルと Lua 設定ファイル間の双方向変換に広く利用されています。',
  },
} as const

export type StringKey = keyof typeof T['zh']

export function useT() {
  const { lang } = useLang()
  return T[lang]
}

// Pick a localized body from an issue's `bodies` map, with sensible fallback.
export function pickLocalized<T extends string>(
  map: Partial<Record<Lang, T>> | undefined,
  lang: Lang,
  fallback: T,
): T {
  if (!map) return fallback
  return map[lang] ?? map[DEFAULT_LANG] ?? map.zh ?? map.ja ?? fallback
}

// Per-language label display names. Key = canonical GitHub label name; missing
// entries fall back to the label's own name (so language-neutral labels like
// "C++" / "OpenGL" need no entry).
export const LABEL_T: Record<Lang, Record<string, string>> = {
  zh: {},
  ja: {
    '游戏引擎': 'ゲームエンジン',
    '渲染': 'レンダリング',
    '复盘': '振り返り',
  },
}

export function translateLabel(name: string, lang: Lang): string {
  return LABEL_T[lang]?.[name] ?? name
}

export function useLabelT() {
  const { lang } = useLang()
  return (name: string) => translateLabel(name, lang)
}
