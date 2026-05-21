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
  },
  ja: {
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
