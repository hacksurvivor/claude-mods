import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clonesCard, details, parse, restLine, rowStat, sparkline, summary, viewsCard } from '../hooks/shelf'
import type { Inventory, Mine } from '../types'

const mod = (over: Partial<Mine>): Mine => ({
  id: 'bouncer',
  name: 'Bouncer',
  version: '0.1.0',
  description: '',
  dir: '/work/mods/bouncer',
  isPublished: false,
  isOn: true,
  usage: '1 link judged',
  tests: { pass: 12, fail: 0 },
  ...over,
})

const INVENTORY: Inventory = {
  yours: [
    mod({ id: 'nightshift', name: 'Nightshift', isPublished: true, usage: null, tests: { pass: 56, fail: 0 } }),
    mod({}),
    mod({ id: 'toolsmith', name: 'Toolsmith', usage: '5 updates found' }),
    mod({ id: 'clock', name: 'Clock', usage: null, tests: { pass: 9, fail: 0 } }),
    mod({ id: 'taste-ledger', name: 'Taste ledger', usage: '0 rules yet' }),
    mod({ id: 'account-guard', name: 'Account guard', usage: null }),
    mod({ id: 'scoreboard', name: 'Scoreboard', usage: null }),
    mod({ id: 'effort-router', name: 'Effort router', usage: null, isOn: false }),
  ],
  installed: [
    { id: 'icons8@icons8', name: 'icons8', market: 'icons8', version: '0.4.1', isOn: true, update: '0.5.1' },
    { id: 'vercel@claude-plugins-official', name: 'vercel', market: 'claude-plugins-official', version: '0.50.0', isOn: false, update: null },
  ],
  updates: [
    { kind: 'ready', id: 'icons8@icons8', name: 'icons8', from: '0.4.1', to: '0.5.1', line: 'Animated icons', reload: true },
    { kind: 'ready', id: 'npm:@openai/codex', name: 'Codex CLI', from: '0.159.2', to: '0.160.0' },
    { kind: 'review', id: 'adapted:img2threejs', name: 'img2threejs', from: 'dede590', to: 'v2.0.0', review: 'Merge img2threejs v2.0.0 into my copy.' },
    { kind: 'manual', id: 'skills:graphify', name: 'graphify', from: '0.4.23', to: '0.9.74', command: 'sudo pipx upgrade --global graphifyy' },
  ],
  stats: { cloners: 45, clones: 112, daily: [0, 0, 0, 112], peak: '2026-10-02', visitors: 1, stars: 0, modViews: { nightshift: 1 } },
}

describe('what the panel says', () => {
  test('a row says published, else what the mod did, else its tests', () => {
    expect(rowStat(mod({ isPublished: true }))).toEqual({ text: 'Published', tone: 'success' })
    expect(rowStat(mod({}))).toEqual({ text: '1 link judged' })
    expect(rowStat(mod({ usage: null }))).toEqual({ text: '12 tests pass' })
    expect(rowStat(mod({ tests: { pass: 3, fail: 1 } }))).toEqual({ text: '1 test fails', tone: 'error' })
    expect(details(mod({ isPublished: true }), 1)).toBe('0.1.0 · 12 tests pass · 1 page view')
  })

  test('the clones card says when every clone came on one day', () => {
    expect(sparkline([0, 0, 3, 0, 12])).toBe('▁▁▃▁█')
    expect(clonesCard({ clones: 112, cloners: 45, daily: [0, 0, 0, 112], peak: '2026-10-02' })).toEqual({
      value: '112',
      label: 'clones · 14 days',
      spark: '▁▁▁█',
      note: 'all on Oct 2',
    })
    expect(clonesCard({ clones: 20, cloners: 9, daily: [5, 0, 15], peak: '2026-10-02' })).toMatchObject({ note: '9 sources' })
    expect(clonesCard({ error: 'HTTP 403' })).toBe("Couldn't read GitHub: HTTP 403")
  })

  test('the views card and the summary line', () => {
    const published = INVENTORY.yours.filter(item => item.isPublished)

    expect(viewsCard({ modViews: { nightshift: 1 } }, published)).toEqual({ value: '1', label: 'page view · Nightshift', note: '14 days' })
    expect(summary(INVENTORY.yours)).toEqual({ left: '8 mods · 7 on', right: '137 tests pass' })
    expect(restLine(['Clock', 'Account guard', 'Scoreboard'])).toBe('Clock and 2 more')
    expect(parse('{"error": "boom"}')).toEqual({ error: 'boom' })
  })
})

type Seen = { ran: string[][]; filled: string[]; submitted: string[]; copied: string[]; toasts: string[] }

function world(on: On): Seen {
  const seen: Seen = { ran: [], filled: [], submitted: [], copied: [], toasts: [] }
  on('process.run', ($, e) => {
    const argv = e.argv.slice(4)
    seen.ran.push(argv)

    return {
      value: {
        exitCode: 0,
        stdout: argv.includes('toggle')
          ? '{"ok": true}'
          : argv.includes('apply')
            ? JSON.stringify({ done: ['icons8@icons8'], failed: { 'npm:@openai/codex': 'npm error code EACCES' }, reload: true })
            : JSON.stringify(INVENTORY),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.close', () => ({ value: undefined as never }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    seen.copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)

    return { text: e.text }
  })

  return seen
}

const presentation = { isFullscreen: false, columns: 120 }
const pane = (surface: 'desktop' | 'terminal') =>
  ({ plugin: 'tree-of-mods', component: 'Pane', surface, props: { title: 'The Tree of Mods', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } }) as const

describe('the panel', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`on the ${surface}, /mods shows your numbers and mods; the tabs switch`, async ($, on) => {
      world(on)
      await $.command.run({ command: 'mods', args: '', origin: { kind: 'composer' }, presentation })
      const ui = await $.ui.mount(pane(surface) as never)

      expect(await ui.find({ type: 'Text', text: '112' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'all on Oct 2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'page view · Nightshift' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '8 mods · 7 on' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Published' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '1 link judged' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Clock and 3 more' })).toBeDefined()

      await ui.press({ key: 'open-bouncer' })
      expect(await ui.find({ type: 'Text', text: '0.1.0 · 12 tests pass' })).toBeDefined()
      expect(await ui.find({ key: 'publish-bouncer' })).toBeDefined()

      await ui.press({ key: 'tab-installed' })
      expect(await ui.find({ type: 'Text', text: '0.5.1 ready' })).toBeDefined()

      await ui.press({ key: 'tab-updates' })
      expect(await ui.find({ type: 'Text', text: '0.4.1 → 0.5.1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2 ready' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Needs your password' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('switches flip your mods through the helper and plugins through claude, then offer a reload', async ($, on) => {
    const seen = world(on)
    await $.command.run({ command: 'mods', args: '', origin: { kind: 'composer' }, presentation })
    const ui = await $.ui.mount(pane('desktop') as never)

    await ui.press({ key: 'switch-bouncer' })
    expect(seen.ran.at(-1)?.[1]).toMatch(/\/bin\/inventory\.py$/)
    expect(seen.ran.at(-1)?.slice(2)).toEqual(['toggle', '/work/mods/bouncer', 'off'])

    await ui.press({ key: 'tab-installed' })
    await ui.press({ key: 'switch-vercel@claude-plugins-official' })
    expect(seen.ran.at(-1)).toEqual(['claude', 'plugin', 'enable', 'vercel@claude-plugins-official'])

    await ui.press({ key: 'reload' })
    expect(seen.filled).toEqual(['/reload-plugins'])
    await ui.unmount()
  })

  test('Publish hands the mod to Claude, which asks before pushing', async ($, on) => {
    const seen = world(on)
    await $.command.run({ command: 'mods', args: '', origin: { kind: 'composer' }, presentation })
    const ui = await $.ui.mount(pane('desktop') as never)

    await ui.press({ key: 'open-bouncer' })
    await ui.press({ key: 'publish-bouncer' })
    expect(seen.submitted[0]).toMatch(/^Get my Bouncer mod .* Stop and ask me before committing or pushing\.$/)
    await ui.unmount()
  })

  test('the Updates tab applies, says why one failed, offers a reload, and hands reviews to Claude', async ($, on) => {
    const seen = world(on)
    await $.command.run({ command: 'mods', args: '', origin: { kind: 'composer' }, presentation })
    const ui = await $.ui.mount(pane('desktop') as never)
    await ui.press({ key: 'tab-updates' })

    await ui.press({ key: 'update-all' })
    expect(seen.ran.find(argv => argv.includes('apply'))?.slice(2)).toEqual(['apply', 'icons8@icons8', 'npm:@openai/codex'])
    expect(await ui.find({ type: 'Text', text: 'npm error code EACCES' })).toBeDefined()
    expect(seen.toasts.at(-1)).toBe('Updated 1, 1 failed. The Updates tab says why.')
    expect(await ui.find({ type: 'Text', text: 'Plugins were updated. Reload them to finish.' })).toBeDefined()

    await ui.press({ key: 'copy-skills:graphify' })
    expect(seen.copied).toEqual(['sudo pipx upgrade --global graphifyy'])

    await ui.press({ key: 'review-adapted:img2threejs' })
    expect(seen.submitted).toEqual(['Merge img2threejs v2.0.0 into my copy.'])
    await ui.unmount()
  })
})
