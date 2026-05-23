# AGENTS.md

Instructions for AI coding assistants working on this repository.

This is **leafvmaple/blog** — a personal technical blog with a GitHub Issues backend (the issues are the post content) and a React/Vite SPA frontend (renders the issues into the public site). The author writes primarily about two long-running projects of his: a freestanding C++ kernel (zonix-plus) and a 2D engine (mini-cocos).

## Author / context

- Bilingual zh + ja blog. Every post has both languages.
- Author actively studies Japanese; prefers **full Japanese translation** (no English+Japanese mixing) when generating the ja version.
- Author background: ~10 years gameplay / engine industry; comfortable with modern C++, Linux kernel idioms, both ISA assembly and high-level abstractions. Don't write content as if explaining to a beginner.
- Primary dev machine: Windows 11 + PowerShell. **PowerShell + cp936 mangles UTF-8 through stdin pipes** — always use file-based `--body-file` when pushing markdown to GitHub via `gh`.
- WSL (Ubuntu) is available with `clang++` 18, `g++` 13.3, `llvm-objdump`, `objdump`, `nasm` — use it whenever the post needs real disassembly, builds, or Linux-specific tooling.

## Content map — the two series

Posts are numbered = GitHub Issue number. Both series share the same main-index + sub-post structure.

**mini-cocos series** (`~/d:/Code/mini-cocos`, ~11k LoC C++17, GL + Vulkan):

| # | slug | topic |
|---|---|---|
| 2 | main-index | engine design recap, decision table, sub-posts index |
| 3 | memory-models | Ref + autorelease vs unique_ptr vs (no) shared_ptr |
| 4 | iterate-and-mutate | pending queue + tombstone + dirty-sort pattern |
| 5 | event-dispatcher | 3 iterations: global table → dual-priority chain → +nested counter |
| 6 | render-and-rhi | 64-bit sortKey + RHI abstraction (GL vs Vulkan) |
| 7 | action-system | `update(t∈[0,1])` contract makes Action composable |
| 8 | resource-pipeline | FontAtlas + FileUtils search-path |
| 9 | lua-binding | hand-written metatables vs sol2 |
| 10 | freestanding-stl | `mstd::` alias for embed-into-OS preparation |

**zonix-plus series** (`d:/Code/zonix-plus`, ~24k LoC freestanding C++17, x86_64 + aarch64 + riscv64):

| # | slug | topic |
|---|---|---|
| 11 | design-recap | main-index, metric table, 3 design decisions, sub-posts index |
| 12 | context-switch-scheduler | `switch_to` RSP off-by-8 + GCC vs Clang epilogue + fork/trapret + scheduler |
| 13 | virtual-memory-swap | PTE as tagged union + swap entry encoded in PTE |
| 14 | boot-chain | MBR/VBR/bootloader + UEFI dual path + REALLOC trick + CR3+stack swap |
| 15 | multiarch-abstraction | `arch_*()` HAL + table-driven init across 3 ISAs |
| 16 | sync-primitives | Spinlock + WaitQueue + Semaphore (single-CPU spinlock for intr-mutex) |
| 17 | freestanding-cpp | `cxxrt.cpp` + `Result<T>`/`TRY` + GCC→Clang migration |
| 18 | user-mode-exec | ELF loader + ring 3 + syscall ABI + user-pointer safety |
| 19 | intrusive-list | intrusive linked list + modern C++ upgrades |

Also referenced: **zcc** (`d:/Code/zcc`), the author's own C compiler, integrated as a zonix submodule.

## When to write a new post vs update an existing one

See [posts/README.md](posts/README.md) "系列连载与迭代约定" section — Rules A–E. Summary:

- **New post** when: orthogonal new subsystem, major rewrite invalidating an existing post's conclusion, cross-cutting change touching many subsystems, or an existing post exceeds 400–500 lines.
- **Update existing** when: bug fix / perf optimization / refactor within the same subsystem, small engineering-aesthetic commits (those go to main-post §3 "工程审美" bucket).

Before drafting, identify which series the post belongs to and use the next sequential issue number.

## Writing style for posts (validated geek-blog conventions)

The author rewrote all 17 posts in one long session away from textbook/科普 tone toward a geek-blog style (think LWN, Fabien Sanglard, Raymond Chen). The rules below were validated point-by-point during that rewrite. Apply them to **every new post and every edit**. Reference posts that exemplify the style: **#11** (zonix main index), **#12** (switch_to bug story with real objdump), **#19** (intrusive list).

### Title rules (H1 and section headings)

- **No changing numbers** in titles — no LoC counts, commit counts, weeks-of-work, version numbers. Past-tense durations frozen in history are OK ("6 周潜伏" is fine).
- **No "我" / "你" pronouns**. Subject should be a technical object (`leave;ret`, `PTE`, `spinlock`, `iretq`, `Vulkan`).
- **No `主题：副标题` colon-subtitle pattern**. Single declarative statement.
- **Prefer abstract concepts over enumerated concrete types** so titles don't go stale when new types are added (picked "复合 Action" over listing `Sequence/Spawn/Ease/Repeat`).
- **State a reverse-intuitive fact or specific technical hook**, not "what this post is about".

### Intro structure

- **Lead with hard data**: real `grep -rE ... | wc -l`, `wc -l file`, `git log` output as a fenced ```text block — or a 3-column table (指标 / 数值 / 含义).
- **Delete self-introductions** ("我在游戏行业做 X 年..." / "code review 里第一个问题..." / "写这一篇的起因..."). The reader wants the punchline, not CV.
- **Delete `这一篇拆 X 件事:` meta-intros**. If a roadmap is genuinely useful, write one short sentence ("§1 看 X，§2 展开 Y，§3-5 是相关边角") — never a bulleted preview list.
- **Don't tout reproducibility**. Author's phrase: "把数值列出来就行". Never write "你可以自己跑" / "如果跑出来不一致请提 Issue". Just list the number.

### Body

- **Cut every `> 经验:` callout block**. Fold the key insight into one inline sentence in the surrounding prose if it's genuinely useful; otherwise delete entirely.
- **Replace literary phrases** ("这段代码漂亮在于", "最魔法的一段") with declarative fact ("这段代码不需要任何额外元数据来判断 X").
- **Add specification citations** where natural: Intel SDM Vol.3 (e.g. §4.5 Table 4-19 for PTE layout), SysV AMD64 ABI v1.0 (§3.2.1 callee-saved), POSIX, RFC. Cite specific sections.
- **Add real disassembly output** (`objdump -d --disassemble=symbol` / `llvm-objdump -d --disassemble-symbols=symbol`) when comparing compilers, ABIs, or epilogues — keep the byte-code column to make it visceral.
- **Cross-link to Linux source** when the same trick exists there (`include/linux/swapops.h`, `include/linux/rmap.h`, `container_of`) — establishes "this isn't novel, it's a recognized kernel idiom" context.

### Closing / footer

- Footer pattern: `*仓库：[repo](url)。本文属于 [系列](url)。*` (zh) / `*リポジトリ：[repo](url)。本記事は [シリーズ名](url) の一篇。*` (ja).
- **No "submit Issue if you disagree" invitations**. Same reasoning as no "你可以自己跑" — just present the facts.
- A `## N. 迭代记录` (zh) / `## N. 更新履歴` (ja) section at the end with commit hash + date + one-line description is good — but every date must be verified via `git log -1 --format='%h %ad' --date=short <hash>` and entries must be sorted descending by date.

### Strict factuality

The author's exact phrase: **"完全按照事实来"**. Whenever drafting or editing:

- **Verify every commit hash** with `git rev-parse <hash>` before pushing. Old posts had many hashes that didn't exist.
- **Verify every date** with `git log -1 --format='%h %ad' --date=short <hash>`. The original kernel-series posts had 20+ fabricated dates (off by weeks to months).
- **Verify every LoC / grep count claim** with real `wc -l` / `grep -c`. Don't perpetuate fiction from old drafts.
- **Soften when unmeasured**: "零开销" without `bloaty` measurement → "运行时开销几乎为 0" / "未量测". Don't fabricate to sound concrete.
- When sub-articles contradict each other or reality, fix them in the same pass.

### Cross-post links

Write `[#N](https://github.com/leafvmaple/blog/issues/N)` in markdown source. The blog has a `marked.use({ walkTokens })` hook in [src/markdown.ts](src/markdown.ts) that rewrites this pattern's `href` to `/post/N` (preserving any `#fragment`) so blog readers stay inside the SPA. GitHub Issue viewers see the raw URL, which also navigates correctly. Both [src/pages/PostDetail.tsx](src/pages/PostDetail.tsx) and [src/components/Comments.tsx](src/components/Comments.tsx) import `parseMarkdown` from this module.

## Workflow: drafting + publishing a post

Source of truth is [posts/README.md](posts/README.md). Summary:

1. Edit local `posts/N-slug.{zh,ja}.md` files following the style rules above.
2. `node scripts/assemble-post.mjs N tmp_body.md` — combines language-specific files into a single body wrapped with `<!--title:xx-->` and `<!--lang:xx-->` markers.
3. `gh issue edit N --repo leafvmaple/blog --body-file tmp_body.md` — **always use `--body-file`**, never pipe (cp936 mangles UTF-8).
4. `rm tmp_body.md`.
5. (**New post only**) `gh issue create --repo leafvmaple/blog --title "<English canonical>" --body "(placeholder)"` first to reserve the issue number, then steps 2–3 to fill the body, then `gh issue edit N --add-label "labels,comma,separated"`.
6. `git add posts/ && git commit && git push origin main` — pushing to `main` automatically triggers `.github/workflows/deploy.yml` which fetches issues, builds, deploys to gh-pages. No need to manually `gh workflow run`.
7. Verify deploy: `gh run list --repo leafvmaple/blog --workflow=deploy.yml --limit 1` then `gh run watch <id> --exit-status`.

`scripts/assemble-post.mjs` extracts each file's H1 as the localized title and the body as the localized content, in zh + ja order. The Issue title itself is the **English canonical** (used for URL slug, GitHub UI, fallback when a locale is missing). Don't translate it into Chinese or Japanese.

## Label inventory

Run `gh label list --repo leafvmaple/blog` to refresh. Existing labels: `os-kernel`, `C++`, `data-structure`, `game-engine`, `cocos2d-x`, `OpenGL`, `Vulkan`, `rendering`, `lua`, `recap`, `memory-management`, `scheduler`, `concurrency`, `boot`, `multi-arch`, `toolchain`, `syscall`, `elf`, `user-mode`, `pinned`.

New labels: `gh label create <name> --repo leafvmaple/blog --description "..." --color "<6-digit hex>"`. Pick colors consistent with the existing palette (each subsystem has its own).

## Local build / verify (rare)

`npm ci` then `npm run build` (= `tsc -b && vite build`). Local Windows env's `node_modules` is often missing; install on demand. Don't rely on local build for tooling correctness — the GitHub Actions runner uses Linux and is authoritative.
