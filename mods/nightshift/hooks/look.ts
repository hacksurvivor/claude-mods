// What Nightshift draws with: the Codex CLI's logo (codex-frames.ts) as a still dot
// matrix, its working-line shimmer, and a Codex reply read back into its
// header, its steps and its words.

import { FRAMES } from './codex-frames'

export const HEADER = '**Codex**'

const INK = '#ecebe6'
// The strip's own background, which dim text fades toward.
const STRIP = '#262624'

// Braille dot order: bit n of a cell is this (column, row) within its 2×4 dots.
const DOT_AT: readonly (readonly [number, number])[] = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

/**
 * The Codex CLI's Braille logo at rest as a dot matrix: every dot its renderer
 * lit, in its cell's color, `height` pixels tall. It never moves.
 */
export function logoDots(height: number): { source: string; width: number } {
  const rows = FRAMES[0] ?? []
  const columns = [...(rows[0]?.[0] ?? '')].length
  const step = height / (rows.length * 4)
  const width = Math.round(step * columns * 2)
  const radius = (step * 0.42).toFixed(2)
  const dots: string[] = []

  rows.forEach(([text, colors], row) => {
    const palette = colors.split(',')

    ;[...text].forEach((char, column) => {
      const bits = (char.codePointAt(0) ?? 0x2800) - 0x2800

      DOT_AT.forEach(([dx, dy], bit) => {
        if (bits & (1 << bit)) {
          const x = ((column * 2 + dx + 0.5) * step).toFixed(2)
          const y = ((row * 4 + dy + 0.5) * step).toFixed(2)

          dots.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${palette[column] ?? INK}"/>`)
        }
      })
    })
  })

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${dots.join('')}</svg>`,
    width,
  }
}

function mix(a: string, b: string, share: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16)

  return `#${[0, 1, 2].map(at => Math.round(channel(a, at) * share + channel(b, at) * (1 - share)).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Each character's color in the working line, as the Codex CLI's
 * summary_shimmer.rs computes it: a band at least 3 characters wide crosses
 * the words in 1s every 4s after 0.6s, from half ink to full ink.
 */
export function shimmerColors(text: string, elapsed: number): string[] {
  const chars = [...text]
  const half = Math.max(chars.length * 0.1, 3)
  const sweep = Math.min(Math.max(0, elapsed - 600) % 4000, 1000) / 1000
  const position = sweep * (chars.length + 2 * half) - half

  return chars.map((_, at) => {
    const distance = Math.min(Math.abs(at + 0.5 - position) / half, 1)
    const intensity = 0.5 * (1 + Math.cos(Math.PI * distance))

    return mix(INK, STRIP, 0.5 + 0.5 * intensity)
  })
}

/** The working bullet's color: it brightens as its own 2s shimmer passes, as motion.rs draws it. */
export function bulletColor(elapsed: number): string {
  const position = ((elapsed % 2000) / 2000) * 21
  const distance = Math.abs(10 - position)
  const intensity = distance <= 5 ? 0.5 * (1 + Math.cos((Math.PI * distance) / 5)) : 0

  return mix(INK, STRIP, 0.5 + 0.5 * intensity)
}

export type Step = { glyph: string; text: string; isFailed: boolean }
export type Reply = { steps: Step[]; words: string }

const STEP = /^- (ran|edited|added|deleted|searched the web for|used) (.+)$/

const GLYPHS: Record<string, string> = {
  ran: '$',
  edited: '✎',
  added: '+',
  deleted: '−',
  'searched the web for': '⌕',
  used: '⚙',
}

const LABELS: Record<string, string> = {
  ran: 'Ran',
  edited: 'Edited',
  added: 'Added',
  deleted: 'Deleted',
  'searched the web for': 'Searched',
  used: 'Used',
}

export function isCodexReply(text: string): boolean {
  return text.trimStart().startsWith(HEADER)
}

/** Splits a Codex reply into its step rows and the rest, kept as markdown. */
export function readReply(text: string): Reply {
  const body = text.trimStart().slice(HEADER.length)
  const steps: Step[] = []
  const words: string[] = []

  for (const line of body.split('\n')) {
    const found = STEP.exec(line.trim())

    if (found) {
      const verb = found[1] ?? 'ran'
      const rest = (found[2] ?? '').replaceAll('`', '')

      steps.push({
        glyph: GLYPHS[verb] ?? '·',
        text: `${LABELS[verb] ?? verb} ${rest.replace(/ \(exit \d+\)$/, '')}`,
        isFailed: / \(exit \d+\)$/.test(rest),
      })
    } else {
      words.push(line)
    }
  }

  return { steps, words: words.join('\n').trim() }
}

/** `Running npm test`: the live line while Codex works, from one step. */
export function liveLine(step: string): string {
  const found = STEP.exec(`- ${step}`)

  if (!found) {
    return 'Thinking'
  }

  const rest = (found[2] ?? '').replaceAll('`', '').replace(/ \(exit \d+\)$/, '')
  const verbs: Record<string, string> = {
    ran: 'Running',
    edited: 'Editing',
    added: 'Adding',
    deleted: 'Deleting',
    'searched the web for': 'Searching',
    used: 'Using',
  }

  return `${verbs[found[1] ?? ''] ?? 'Working on'} ${rest}`
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// Codex's reasoning levels as the strip offers them, lightest first.
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type CodexEffort = (typeof CODEX_EFFORTS)[number]

export const EFFORT_LABELS: Record<CodexEffort, string> = {
  low: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

/**
 * The levels a model takes, from what its cache entry lists; every level when
 * the cache says nothing.
 */
export function effortsFor(supported: readonly string[] | undefined): CodexEffort[] {
  const known = CODEX_EFFORTS.filter(effort => supported === undefined || supported.includes(effort))

  return known.length > 0 ? known : [...CODEX_EFFORTS]
}

/** The chosen level, or the closest one below it that the model takes. */
export function effortWithin(chosen: CodexEffort, offered: readonly CodexEffort[]): CodexEffort {
  const at = CODEX_EFFORTS.indexOf(chosen)
  const below = offered.filter(effort => CODEX_EFFORTS.indexOf(effort) <= at)

  return below.at(-1) ?? offered[0] ?? chosen
}

// The Codex 7-day limit as a week of square tiles, read like a battery: the
// share left lit in the logo's ink, full at 100% and empty at 0%, and a faint
// tick where the week's remaining time ends, so lit tiles past the tick mean
// more left than the week needs. One static SVG, 26px tall.
const LIMIT_FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'
const LIMIT_TEXT = '#ecebe6'
const LIMIT_DIM = '#8a8984'
const LIMIT_LIT = '#d4d4ce'
const LIMIT_UNLIT = '#3a3936'
const LIMIT_TICK = '#74736d'
// From 75% the lit tiles warm to honey; from 90% they turn a soft red.
const LIMIT_WARM = '#d9b779'
const LIMIT_HOT = '#e36d5d'

// Measured with the strip's font: "100%" at 12.5px semibold is 37px wide,
// "Wed 22:59" at 11px about 58px.
const PERCENT_RESERVE = 38
const RESET_RESERVE = 58
const GAP_TILES_TEXT = 8
const GAP_TEXT_RESET = 10
// Room left of the first tile for the "now" tick at the start of the week.
const TICK_ROOM = 2
// Narrower than this, the reset time gives way to the tiles.
const MIN_RESET_WIDTH = 280

type TileGrid = { tile: number; gap: number; groupGap: number; perDay: number; day: number; span: number; count: number }

const clampTo = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * The week's grid that best fills `space`: 7 day groups of whole-pixel square
 * tiles, the most per day that fit, then the larger tile; the gap between
 * days clearly wider than inside one. Left-over room sits on the left.
 */
function tileGrid(space: number): TileGrid {
  let best: TileGrid | undefined

  for (const tile of [8, 7, 6]) {
    if (tile === 6 && best !== undefined) {
      break
    }

    const gap = 3

    for (let perDay = 2; perDay <= 5; perDay++) {
      const day = perDay * tile + (perDay - 1) * gap
      const groupGap = Math.min(12, Math.floor((space - 7 * day) / 6))

      if (groupGap < 7) {
        continue
      }

      if (best === undefined || perDay > best.perDay) {
        best = { tile, gap, groupGap, perDay, day, span: 7 * day + 6 * groupGap, count: 7 * perDay }
      }
    }

    if (best !== undefined && tile === 8 && best.perDay >= 3) {
      break
    }
  }

  return best ?? { tile: 6, gap: 3, groupGap: 7, perDay: 1, day: 6, span: 7 * 6 + 6 * 7, count: 7 }
}

// Wide enough for 8px tiles, three a day, beside "100%" and the reset time.
export const LIMIT_WIDTH = 368

/** The limit meter's SVG: `percent` used (drawn as what is left), `elapsed` of the week gone (0–1), and the reset label. */
export function limitTiles(args: { percent: number; elapsed?: number; reset?: string; width?: number }): {
  source: string
  width: number
} {
  const width = args.width ?? LIMIT_WIDTH
  const height = 26
  const used = clampTo(Number.isFinite(args.percent) ? args.percent : 0, 0, 100)
  const showReset = args.reset !== undefined && args.reset !== '' && width >= MIN_RESET_WIDTH
  const tilesRight = width - PERCENT_RESERVE - GAP_TILES_TEXT - (showReset ? RESET_RESERVE + GAP_TEXT_RESET : 0)
  const grid = tileGrid(tilesRight - TICK_ROOM)
  const left = tilesRight - grid.span
  const baseline = 17.5
  // Tiles stand on the text's baseline and reach about its cap height.
  const top = 9 + (8 - grid.tile)

  const remaining = 100 - used
  // Anything left lights one tile; only an untouched limit lights them all.
  const lit =
    remaining <= 0 ? 0 : remaining >= 100 ? grid.count : clampTo(Math.round((remaining / 100) * grid.count), 1, grid.count - 1)
  const ink = used >= 90 ? LIMIT_HOT : used >= 75 ? LIMIT_WARM : LIMIT_LIT
  const xOf = (index: number) =>
    left + Math.floor(index / grid.perDay) * (grid.day + grid.groupGap) + (index % grid.perDay) * (grid.tile + grid.gap)
  const radius = grid.tile >= 7 ? 1.5 : 1.25
  const parts: string[] = []

  for (let index = 0; index < grid.count; index++) {
    parts.push(
      `<rect x="${xOf(index)}" y="${top}" width="${grid.tile}" height="${grid.tile}" rx="${radius}" fill="${index < lit ? ink : LIMIT_UNLIT}"/>`,
    )
  }

  // The week's time left, snapped to the nearest tile edge so it never cuts a tile.
  if (args.elapsed !== undefined) {
    const boundary = Math.round((1 - clampTo(args.elapsed, 0, 1)) * grid.count)
    const tickX =
      boundary <= 0
        ? left - 2
        : boundary >= grid.count
          ? tilesRight + 2
          : (xOf(boundary - 1) + grid.tile + xOf(boundary)) / 2

    parts.push(`<rect x="${Math.round(tickX - 0.5)}" y="${top - 4}" width="1" height="${grid.tile + 8}" rx="0.5" fill="${LIMIT_TICK}"/>`)
  }

  const numbers = 'font-variant-numeric:tabular-nums'

  parts.push(
    `<text x="${tilesRight + GAP_TILES_TEXT}" y="${baseline}" font-family="${LIMIT_FONT}" font-size="12.5" font-weight="600" fill="${used >= 90 ? LIMIT_HOT : LIMIT_TEXT}" style="${numbers}">${Math.round(remaining)}%</text>`,
  )

  if (showReset) {
    parts.push(
      `<text x="${width}" y="${baseline}" text-anchor="end" font-family="${LIMIT_FONT}" font-size="11" fill="${LIMIT_DIM}" style="${numbers}">${(args.reset ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</text>`,
    )
  }

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`,
    width,
  }
}
