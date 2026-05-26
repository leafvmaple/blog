// Manually-curated series metadata. Posts within a series are read in issue-
// number order, and series membership drives /series/:slug pages plus the
// prev/next nav on PostDetail.
//
// Membership is by issue number (not by label) — the AGENTS.md content map
// is the source of truth and labels alone can't distinguish "mini-cocos main
// index" from "zonix sub-post that also happens to touch C++".

import type { Lang } from './i18n'

export interface SeriesDef {
  slug: string
  titles: Record<Lang, string>
  blurbs: Record<Lang, string>
  /** Ordered list of issue numbers in reading order. */
  issues: number[]
  /** Optional main-index issue, rendered first with a leading badge. */
  anchor?: number
  /** External source-of-truth repo (zonix-plus / mini-cocos / zcc). */
  repoUrl?: string
}

export const SERIES: SeriesDef[] = [
  {
    slug: 'mini-cocos',
    titles: { zh: 'mini-cocos · 2D 引擎', ja: 'mini-cocos · 2D エンジン' },
    blurbs: {
      zh: '约 11k 行 C++17 的自研 2D 引擎，覆盖 GL + Vulkan RHI、Action 系统、资源管线、Lua 绑定，最后拆出 freestanding STL 为嵌入到 OS 做准备。',
      ja: '約 11k 行 C++17 の自作 2D エンジン。GL + Vulkan RHI、Action システム、リソースパイプライン、Lua バインディング、最後に freestanding STL を切り出して OS への組み込みを準備する。',
    },
    issues: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    anchor: 2,
    repoUrl: 'https://github.com/leafvmaple/mini-cocos',
  },
  {
    slug: 'zonix',
    titles: { zh: 'Zonix OS', ja: 'Zonix OS' },
    blurbs: {
      zh: '约 24k 行 freestanding C++17 教学型内核，同时面向 x86_64 / aarch64 / riscv64，覆盖 boot、虚拟内存、抢占式调度、同步原语、ELF 加载、用户态执行。',
      ja: '約 24k 行 freestanding C++17 の教育用カーネル。x86_64 / aarch64 / riscv64 を同時にサポートし、ブート、仮想メモリ、プリエンプティブスケジューラ、同期プリミティブ、ELF ローダ、ユーザーモード実行を網羅。',
    },
    issues: [11, 12, 13, 14, 15, 16, 17, 18, 19],
    anchor: 11,
    repoUrl: 'https://github.com/leafvmaple/zonix-plus',
  },
  {
    slug: 'zcc',
    titles: { zh: 'zcc · C 编译器', ja: 'zcc · C コンパイラ' },
    blurbs: {
      zh: 'Flex/Bison 词法语法 + LLVM IR codegen 的玩具 C 编译器，作为 zonix 的子模块整合进工具链回路。',
      ja: 'Flex/Bison による字句構文解析と LLVM IR codegen のおもちゃ C コンパイラ。zonix のサブモジュールとしてツールチェーンに統合。',
    },
    issues: [20, 21, 22, 23],
    repoUrl: 'https://github.com/leafvmaple/zcc',
  },
]

export function getSeries(slug: string): SeriesDef | undefined {
  return SERIES.find(s => s.slug === slug)
}

export function seriesForIssue(num: number): SeriesDef | undefined {
  return SERIES.find(s => s.issues.includes(num))
}

export interface Siblings {
  series?: SeriesDef
  prev?: number
  next?: number
}

export function siblingsInSeries(num: number): Siblings {
  const s = seriesForIssue(num)
  if (!s) return {}
  const idx = s.issues.indexOf(num)
  return {
    series: s,
    prev: idx > 0 ? s.issues[idx - 1] : undefined,
    next: idx < s.issues.length - 1 ? s.issues[idx + 1] : undefined,
  }
}
