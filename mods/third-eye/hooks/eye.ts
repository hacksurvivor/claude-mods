// What the third eye asks, how it reads the answer, and when it looks.

import type { Idea, Taste } from '../types'

// Quiet for this long after a reply before the eye looks: the person is reading.
export const IDLE_MS = 25_000
// At most one unasked-for idea in this window.
export const GAP_MS = 15 * 60_000
const ANCHOR_CHARS = 160
const TASTE_KEPT = 30

export function anchorOf(text: string): string {
  return text.trim().slice(-ANCHOR_CHARS)
}

// The last text block of a reply ends where the turn's answer ends.
export function isUnder(anchor: string, blockText: string): boolean {
  const block = anchorOf(blockText)

  return block.length >= 20 && anchor.endsWith(block.slice(-Math.min(block.length, 80)))
}

export function isDue(now: number, ideas: readonly Idea[]): boolean {
  const last = ideas.at(-1)

  return last === undefined || now - last.at >= GAP_MS
}

export function question(taste: Taste): string {
  const avoid = taste.dismissed.slice(-12)
  const liked = taste.asked.slice(-6)

  return [
    'Step outside this conversation for a moment and act as the person\'s third eye.',
    'Look only at what the person (not you) has asked for in this session: the questions they keep asking, what they measure, what they take for granted, and what they never ask about.',
    'Offer ONE idea they would not have suggested themselves: an angle outside their habitual frame that matters for what they are actually trying to achieve.',
    'Not the obvious next step, not a follow-up on what you just did, and not generic advice (tests, docs, backups, monitoring) unless it is truly surprising here. It must be concrete enough to start on in this session.',
    'Look from a side they skip: the person on the other end, the money, the time, the people outside the work, a different field that solved this already. Anchor it in one specific detail from this chat, so it could only have been said here.',
    avoid.length > 0 ? `They turned these down before, so stay away from their kind: ${avoid.map(item => `"${item}"`).join('; ')}.` : '',
    liked.length > 0 ? `They took these up before: ${liked.map(item => `"${item}"`).join('; ')}.` : '',
    'Write in the language the person writes in. Plain words, no hype.',
    'Reply with only this JSON, nothing around it:',
    '{"idea": "<the idea as one imperative sentence, at most 14 words>", "why": "<one or two sentences in second person naming the blind spot>", "prompt": "<what they could send you to start on it, in their voice>"}',
  ]
    .filter(line => line !== '')
    .join('\n')
}

export function parseIdea(reply: string): Pick<Idea, 'idea' | 'why' | 'prompt'> | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')

  if (start < 0 || end <= start) {
    return undefined
  }

  try {
    const data = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
    const { idea, why, prompt } = data

    if (typeof idea === 'string' && typeof why === 'string' && idea.trim() !== '' && why.trim() !== '') {
      return { idea: idea.trim(), why: why.trim(), prompt: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : idea.trim() }
    }
  } catch {
    // not JSON
  }

  return undefined
}

export function remember(taste: Taste, kind: keyof Taste, idea: string): Taste {
  return { ...taste, [kind]: [...taste[kind].filter(item => item !== idea), idea].slice(-TASTE_KEPT) }
}

export function readTaste(stored: unknown): Taste {
  const value = (stored ?? {}) as Partial<Taste>

  return {
    dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter(item => typeof item === 'string') : [],
    asked: Array.isArray(value.asked) ? value.asked.filter(item => typeof item === 'string') : [],
  }
}
