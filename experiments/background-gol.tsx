// Archived background variant: Conway's Game of Life ambient field.
//
// Tried as an alternative to the default particles + connecting-lines field.
// Stashed here for later experimentation — outside src/ so neither Vite nor
// tsc compiles it. To revive: copy this file's content into
// src/components/Background.tsx (the active background module).
//
// Tuning notes from the session it was last in active use:
//   - Cell size 18 px (smaller = denser grid; larger = chunkier)
//   - One generation every 650 ms (slower than 60 fps so transitions read as
//     organic, not jittery); each cell eases its alpha toward target every
//     frame so births / deaths fade in/out instead of popping.
//   - Initial alive density 0.08 — sparser than the canonical ~0.18 GoL seed,
//     intentionally so the field doesn't dominate the page.
//   - Every 8 steps, sprinkle 4 random alive cells so the grid never decays
//     to a pure still life on a quiet day.
//   - Peak fill alpha 0.04 dark / 0.02 light. Treat the field as a watermark
//     behind copy, not as content.
//
// Performance: O(rows × cols) per generation step + O(rows × cols) per frame
// render. ~70×45 = 3150 cells on a 1280×800 viewport runs comfortably at 60 fps
// well under 1% CPU on modern hardware.

import { useEffect, useRef } from 'react'
import '../src/components/Background.css'

export default function Background() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let animId = 0
    let W = 0, H = 0
    let cols = 0, rows = 0
    let grid = new Uint8Array(0)
    let next = new Uint8Array(0)
    let alpha = new Float32Array(0)
    let stepCount = 0
    let lastStepAt = 0

    const CELL = 18         // px per cell (square) — larger cells = sparser field
    const STEP_MS = 650     // ms per Life generation
    const EASE = 0.10       // per-frame lerp toward target alpha
    const SEED_RATE = 0.08  // initial alive density
    const SPARK_EVERY = 8   // every N steps, sprinkle a few random cells
    const SPARK_COUNT = 4   // cells per sprinkle
    const MAX_A_DARK = 0.04   // peak fill alpha in dark mode (watermark-level)
    const MAX_A_LIGHT = 0.02  // peak fill alpha in light mode

    const darkMq = window.matchMedia('(prefers-color-scheme: dark)')
    let dark = darkMq.matches
    const onScheme = (e: MediaQueryListEvent) => { dark = e.matches }
    darkMq.addEventListener('change', onScheme)

    function resize() {
      const dpr = window.devicePixelRatio || 1
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = W * dpr
      canvas.height = H * dpr
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      // setTransform (not scale) so repeated resizes don't compound.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      cols = Math.max(8, Math.ceil(W / CELL))
      rows = Math.max(8, Math.ceil(H / CELL))
      grid = new Uint8Array(cols * rows)
      next = new Uint8Array(cols * rows)
      alpha = new Float32Array(cols * rows)
      for (let i = 0; i < grid.length; i++) {
        if (Math.random() < SEED_RATE) grid[i] = 1
      }
      stepCount = 0
      lastStepAt = 0
    }

    function step() {
      for (let r = 0; r < rows; r++) {
        const rUp = (r - 1 + rows) % rows
        const rDn = (r + 1) % rows
        for (let c = 0; c < cols; c++) {
          const cL = (c - 1 + cols) % cols
          const cR = (c + 1) % cols
          const n =
            grid[rUp * cols + cL] + grid[rUp * cols + c] + grid[rUp * cols + cR] +
            grid[r   * cols + cL] +                         grid[r   * cols + cR] +
            grid[rDn * cols + cL] + grid[rDn * cols + c] + grid[rDn * cols + cR]
          const alive = grid[r * cols + c] === 1
          next[r * cols + c] = (alive && (n === 2 || n === 3)) || (!alive && n === 3) ? 1 : 0
        }
      }
      const tmp = grid; grid = next; next = tmp
      stepCount++
      // Periodic spark to keep ambient motion even if grid stabilizes.
      if (stepCount % SPARK_EVERY === 0) {
        for (let k = 0; k < SPARK_COUNT; k++) {
          const i = (Math.random() * grid.length) | 0
          grid[i] = 1
        }
      }
    }

    function draw(t: number) {
      if (lastStepAt === 0) lastStepAt = t
      if (t - lastStepAt >= STEP_MS) {
        step()
        lastStepAt = t
      }
      // Ease alpha toward target (1 if alive, 0 if dead) — smooths births/deaths.
      for (let i = 0; i < alpha.length; i++) {
        const target = grid[i]
        alpha[i] += (target - alpha[i]) * EASE
      }

      ctx.clearRect(0, 0, W, H)
      const rgb = dark ? '90, 170, 255' : '0, 100, 210'
      const maxA = dark ? MAX_A_DARK : MAX_A_LIGHT
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const a = alpha[r * cols + c]
          if (a < 0.02) continue
          ctx.fillStyle = `rgba(${rgb}, ${a * maxA})`
          ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2)
        }
      }

      animId = requestAnimationFrame(draw)
    }

    resize()
    animId = requestAnimationFrame(draw)

    const onResize = () => resize()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', onResize)
      darkMq.removeEventListener('change', onScheme)
    }
  }, [])

  return <canvas ref={canvasRef} className="bg-canvas" />
}
