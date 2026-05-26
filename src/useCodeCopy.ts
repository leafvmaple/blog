import { useEffect, type RefObject } from 'react'

// Visual "copied" pulse duration. Long enough to register, short enough that
// rapid re-clicks still feel responsive.
const COPIED_MS = 1400

// Attaches a single click listener to the container ref and copies the
// adjacent <code> text when a .code-copy button inside any .code-block is
// clicked. Build-time fetch-posts.mjs emits the button HTML; this hook owns
// the runtime behavior.
//
// Event delegation on the container means HTML can be swapped (e.g. on
// language toggle) without re-attaching listeners.
export function useCodeCopy(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current
    if (!root) return

    const onClick = async (e: Event) => {
      const target = e.target as HTMLElement | null
      const btn = target?.closest<HTMLButtonElement>('.code-copy')
      if (!btn || !root.contains(btn)) return
      const code = btn.parentElement?.querySelector('code')
      if (!code) return
      try {
        await navigator.clipboard.writeText(code.textContent ?? '')
        btn.classList.add('copied')
        setTimeout(() => btn.classList.remove('copied'), COPIED_MS)
      } catch {
        // navigator.clipboard requires a secure context. Silently no-op so
        // production HTTPS users get feedback but HTTP previews don't error.
      }
    }

    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [ref])
}
