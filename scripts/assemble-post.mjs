#!/usr/bin/env node
// Assemble a multilingual issue body from per-language source files.
//
// Usage:
//   node scripts/assemble-post.mjs <issue-number> [out-file]
//
// Reads every `posts/<N>-*.<lang>.md` (lang = zh / ja / ...) and writes the
// combined body wrapped in `<!--lang:xx-->...<!--/lang:xx-->` markers, prefixed
// with `<!--title:xx-->...<!--/title:xx-->` blocks extracted from each file's
// first `# H1` line. fetch-posts.mjs splits both back at build time, so the
// GitHub Issue title only needs the canonical English version while each
// locale renders its own translated title.
//
// If [out-file] is given, writes UTF-8 bytes there (recommended on Windows
// PowerShell, which mangles UTF-8 stdout via cp936). Otherwise prints to stdout.
//
// Typical use:
//   node scripts/assemble-post.mjs 2 tmp_body.md
//   gh issue edit 2 --repo leafvmaple/blog --body-file tmp_body.md

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const POSTS_DIR = resolve(__dirname, '..', 'posts')

const LANG_ORDER = ['zh', 'ja']

async function main() {
  const number = process.argv[2]
  if (!number || !/^\d+$/.test(number)) {
    console.error('Usage: node scripts/assemble-post.mjs <issue-number>')
    process.exit(2)
  }

  const files = await readdir(POSTS_DIR)
  const re = new RegExp(`^${number}-.*\\.([a-z-]+)\\.md$`)
  const found = new Map()
  for (const f of files) {
    const m = f.match(re)
    if (m) found.set(m[1].toLowerCase(), f)
  }

  if (found.size === 0) {
    console.error(`[assemble-post] no posts/${number}-*.<lang>.md found`)
    process.exit(1)
  }

  const ordered = [
    ...LANG_ORDER.filter(l => found.has(l)),
    ...[...found.keys()].filter(l => !LANG_ORDER.includes(l)).sort(),
  ]

  const parts = []
  const titleBlocks = []
  for (const lang of ordered) {
    const raw = (await readFile(resolve(POSTS_DIR, found.get(lang)), 'utf8')).trim()
    const m = raw.match(/^#\s+(.+?)\s*$/m)
    if (!m) {
      console.error(`[assemble-post] ${found.get(lang)} missing top-level "# Title" line`)
      process.exit(1)
    }
    titleBlocks.push(`<!--title:${lang}-->${m[1].trim()}<!--/title:${lang}-->`)
    parts.push(`<!--lang:${lang}-->\n${raw}\n<!--/lang:${lang}-->`)
  }
  const out = titleBlocks.join('\n') + '\n\n' + parts.join('\n\n') + '\n'
  const outFile = process.argv[3]
  if (outFile) {
    await writeFile(resolve(process.cwd(), outFile), out, 'utf8')
    console.error(`[assemble-post] wrote ${Buffer.byteLength(out, 'utf8')} bytes to ${outFile}`)
  } else {
    process.stdout.write(out)
  }
}

main().catch(err => {
  console.error('[assemble-post] failed:', err)
  process.exit(1)
})
