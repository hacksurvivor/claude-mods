import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Installed, Inventory, Mine, Tab, Update } from '../types'
import {
  FOLDED,
  applyResult,
  clonesCard,
  details,
  parse,
  publishPrompt,
  readyOf,
  restLine,
  rowStat,
  summary,
  tabLabel,
  updateLine,
  updateVersions,
  viewsCard,
} from './shelf'

// /mods opens a panel beside the chat: the mods you made (on or off, published
// or only on this Mac, tests, what each has done), the plugins you installed
// from marketplaces, the updates the Updates mod found, and the repo's GitHub numbers.
// bin/inventory.py reads all of it; it writes only when a switch is flipped.

const PANE_ID = 'mods'
const LOAD_TIMEOUT_MS = 60_000
const TESTS_TIMEOUT_MS = 600_000
const SWITCH_TIMEOUT_MS = 60_000

const inventory = atom({ plugin: 'tree-of-mods', key: 'inventory' } as const, null as Inventory | null)
const error = atom({ plugin: 'tree-of-mods', key: 'error' } as const, null as string | null)
const tab = atom({ plugin: 'tree-of-mods', key: 'tab' } as const, 'yours' as Tab)
const isLoading = atom({ plugin: 'tree-of-mods', key: 'isLoading' } as const, false)
const changed = atom({ plugin: 'tree-of-mods', key: 'changed' } as const, [] as string[])
const showsAll = atom({ plugin: 'tree-of-mods', key: 'showsAll' } as const, false)
const opened = atom({ plugin: 'tree-of-mods', key: 'opened' } as const, null as string | null)
const updating = atom({ plugin: 'tree-of-mods', key: 'updating' } as const, [] as string[])
const failures = atom({ plugin: 'tree-of-mods', key: 'failures' } as const, {} as Record<string, string>)
const needsReload = atom({ plugin: 'tree-of-mods', key: 'needsReload' } as const, false)
// The host allows a command 10 minutes at most; each step inside gets 4.
const APPLY_TIMEOUT_MS = 600_000

function helper($: EngineInterface, args: string[], timeoutMs: number) {
  return $.process.run(['/bin/zsh', '-lc', '"$@"', 'mods', 'python3', `${$.plugin.root}/bin/inventory.py`, ...args], { timeoutMs })
}

async function load($: EngineInterface, args: string[]): Promise<void> {
  try {
    const ran = await helper($, args, args.includes('--tests') ? TESTS_TIMEOUT_MS : LOAD_TIMEOUT_MS)
    const found = parse(ran.stdout)

    if ('error' in found) {
      await update($, error, () => found.error)

      return
    }

    await update($, inventory, () => found.inventory)
    await update($, error, () => null)
  } catch (failure) {
    await update($, error, () => (failure instanceof Error ? failure.message : String(failure)).slice(0, 160))
  }
}

// The list at once from the cache, then the tests of mods that changed.
async function refresh($: EngineInterface): Promise<void> {
  await update($, isLoading, () => true)
  await load($, [])
  await update($, isLoading, () => false)
  void load($, ['--tests'])
}

async function switchMine($: EngineInterface, mod: Mine): Promise<void> {
  const ran = await helper($, ['toggle', mod.dir, mod.isOn ? 'off' : 'on'], SWITCH_TIMEOUT_MS)

  if (ran.exitCode !== 0) {
    $.ui.toast(`Couldn't switch ${mod.name}: ${(ran.stdout + ran.stderr).trim().slice(0, 120)}`, { timeoutMs: 8_000 })

    return
  }

  await update($, inventory, now => now && { ...now, yours: now.yours.map(item => (item.id === mod.id ? { ...item, isOn: !mod.isOn } : item)) })
  await update($, changed, list => (list.includes(mod.id) ? list : [...list, mod.id]))
}

async function switchInstalled($: EngineInterface, plugin: Installed): Promise<void> {
  const ran = await $.process.run(['/bin/zsh', '-lc', '"$@"', 'mods', 'claude', 'plugin', plugin.isOn ? 'disable' : 'enable', plugin.id], {
    timeoutMs: SWITCH_TIMEOUT_MS,
  })

  if (ran.exitCode !== 0) {
    $.ui.toast(`Couldn't switch ${plugin.name}: ${(ran.stderr || ran.stdout).trim().slice(0, 120)}`, { timeoutMs: 8_000 })

    return
  }

  await update($, inventory, now => now && { ...now, installed: now.installed.map(item => (item.id === plugin.id ? { ...item, isOn: !plugin.isOn } : item)) })
  await update($, changed, list => (list.includes(plugin.id) ? list : [...list, plugin.id]))
}

async function publish($: EngineInterface, mod: Mine): Promise<void> {
  await $.ui.close({ id: PANE_ID })
  await $.prompt.submit({ text: publishPrompt(mod, (await read($, inventory))?.repo), asUser: true })
}

// Runs the chosen updates through the helper, then reads the list again.
async function applyUpdates($: EngineInterface, ids: string[]): Promise<void> {
  if ((await read($, updating)).length > 0 || ids.length === 0) {
    return
  }

  await update($, updating, () => ids)
  await update($, failures, now => Object.fromEntries(Object.entries(now).filter(([id]) => !ids.includes(id))))

  try {
    const ran = await helper($, ['apply', ...ids], APPLY_TIMEOUT_MS)
    const result = applyResult(ran.stdout)

    if (result === undefined) {
      $.ui.toast(`Couldn't update: ${(ran.stderr || ran.stdout).trim().slice(0, 120)}`, { timeoutMs: 8_000 })

      return
    }

    await update($, failures, now => ({ ...now, ...result.failed }))

    if (result.reload) {
      await update($, needsReload, () => true)
    }

    const failed = Object.keys(result.failed).length
    $.ui.toast(
      failed === 0
        ? `Updated ${result.done.length}.${result.reload ? ' Reload plugins to finish.' : ''}`
        : `Updated ${result.done.length}, ${failed} failed. The Updates tab says why.`,
      { timeoutMs: 8_000 },
    )
  } finally {
    await update($, updating, () => [])
    await load($, [])
  }
}

async function review($: EngineInterface, item: Update): Promise<void> {
  await $.ui.close({ id: PANE_ID })
  await $.prompt.submit({ text: item.review ?? `Help me update ${item.name} from ${item.from} to ${item.to}.`, asUser: true })
}

async function copyCommand($: EngineInterface, item: Update, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const copied = await $.ui.copy({ text: item.command ?? '', surface })
  $.ui.toast(copied.isCopied ? 'Copied. Paste it in a terminal; it asks for your password.' : `Couldn't copy: ${item.command}`, {
    timeoutMs: 8_000,
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mods', description: 'Open The Tree of Mods: your mods, installed plugins, updates', immediate: true })

    return next(e)
  })

  on('command.run', { command: 'mods' }, async $ => {
    await $.ui.open({ id: PANE_ID, title: 'The Tree of Mods', closeOnEscape: true })
    void refresh($)

    return { text: 'The Tree of Mods is open on the side.' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.props.title !== 'The Tree of Mods') {
      return next(e)
    }

    const found = await read($, inventory)
    const failed = await read($, error)
    const current = await read($, tab)
    const switched = await read($, changed)
    const isAll = await read($, showsAll)
    const loading = await read($, isLoading)
    const open = await read($, opened)
    const running = await read($, updating)
    const failedNow = await read($, failures)
    const reloadNow = await read($, needsReload)
    const { Box, Button, Text } = $.ui.resolve(e)
    const labels = tabLabel(found)

    const onOff = (key: string, isOn: boolean, press: () => void) => (
      <Button key={key} label={isOn ? 'On' : 'Off'} plain dimColor={!isOn} onPress={press} />
    )

    const row = (key: string, name: string, meta: string | null, right: JSX.Element[]) => (
      <Box key={key} flexDirection="row" columnGap={2} paddingY={0}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate">{name}</Text>
        </Box>
        {meta === null ? null : <Text dimColor wrap="truncate">{meta}</Text>}
        {right}
      </Box>
    )

    // A card on top: the number big, its label and a note dim under it.
    const card = (key: string, value: string, label: string, lines: string[]) => (
      <Box key={key} flexDirection="column" flexGrow={1} width="50%" borderStyle="round" borderDimColor paddingX={1}>
        <Text bold>{value}</Text>
        <Text dimColor wrap="truncate">{label}</Text>
        {lines.map((line, at) => (
          <Text key={`${key}-${at}`} dimColor wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    )

    const mineRow = (mod: Mine) => {
      const stat = rowStat(mod)
      const isOpen = open === mod.id

      return (
        <Box key={`mine-${mod.id}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text color={mod.isOn ? 'success' : undefined} dimColor={!mod.isOn}>
              ●
            </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Button key={`open-${mod.id}`} label={mod.name} plain onPress={() => update($, opened, now => (now === mod.id ? null : mod.id))} />
            </Box>
            <Text color={stat.tone} dimColor={stat.tone === undefined} wrap="truncate">
              {stat.text}
            </Text>
            {onOff(`switch-${mod.id}`, mod.isOn, () => switchMine($, mod))}
          </Box>
          {isOpen ? (
            <Box key={`details-${mod.id}`} flexDirection="column" marginLeft={2} marginBottom={1}>
              <Text dimColor wrap="wrap">
                {mod.description}
              </Text>
              <Box flexDirection="row" columnGap={2}>
                <Box flexGrow={1}>
                  <Text dimColor>{details(mod, found?.stats.modViews?.[mod.id])}</Text>
                </Box>
                {mod.isPublished ? null : <Button key={`publish-${mod.id}`} label="Publish" variant="secondary" onPress={() => publish($, mod)} />}
              </Box>
            </Box>
          ) : null}
        </Box>
      )
    }

    const yoursTab = () => {
      const yours = found?.yours ?? []
      const published = yours.filter(mod => mod.isPublished)
      // Published first, then the ones that did something, then the rest.
      const ordered = [...published, ...yours.filter(mod => !mod.isPublished && mod.usage !== null), ...yours.filter(mod => !mod.isPublished && mod.usage === null)]
      const visible = isAll ? ordered : ordered.slice(0, FOLDED)
      const rest = ordered.slice(visible.length)
      const clones = clonesCard(found?.stats ?? {})
      const views = viewsCard(found?.stats ?? {}, published)
      const head = summary(yours)

      return (
        <Box flexDirection="column" rowGap={1}>
          {typeof clones === 'string' ? (
            <Text dimColor>{clones}</Text>
          ) : (
            <Box flexDirection="row" columnGap={1}>
              {card('clones', clones.value, clones.label, [clones.spark, clones.note])}
              {card('views', views.value, views.label, ['', views.note])}
            </Box>
          )}
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={2}>
              <Box flexGrow={1}>
                <Text dimColor>{head.left}</Text>
              </Box>
              <Text dimColor>{head.right}</Text>
            </Box>
            {visible.map(mineRow)}
            {rest.length > 0 || isAll ? (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>●</Text>
                <Box flexGrow={1}>
                  <Text dimColor wrap="truncate">{isAll ? '' : restLine(rest.map(mod => mod.name))}</Text>
                </Box>
                <Button key="show-all" label={isAll ? 'Show less' : 'Show'} plain dimColor onPress={() => update($, showsAll, all => !all)} />
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }

    const installedTab = () => (
      <Box flexDirection="column">
        {(found?.installed ?? []).map(plugin =>
          row(`plugin-${plugin.id}`, plugin.name, plugin.update === null ? plugin.version : `${plugin.update} ready`, [
            onOff(`switch-${plugin.id}`, plugin.isOn, () => switchInstalled($, plugin)),
          ]),
        )}
      </Box>
    )

    const updateRow = (item: Update) => {
      const isRunning = running.includes(item.id)
      const reason = failedNow[item.id]
      const action =
        item.kind === 'ready' ? (
          <Button key={`apply-${item.id}`} label={isRunning ? 'Updating…' : 'Update'} plain onPress={() => applyUpdates($, [item.id])} />
        ) : item.kind === 'review' ? (
          <Button key={`review-${item.id}`} label="Review" plain onPress={() => review($, item)} />
        ) : (
          <Button key={`copy-${item.id}`} label="Copy command" plain onPress={press => copyCommand($, item, press.surface)} />
        )

      return (
        <Box key={`update-${item.id}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate">
                {item.name}
              </Text>
            </Box>
            <Text dimColor>{updateVersions(item)}</Text>
            {action}
          </Box>
          <Text dimColor wrap="truncate">
            {updateLine(item)}
          </Text>
          {reason === undefined ? null : (
            <Text color="error" wrap="wrap">
              {reason}
            </Text>
          )}
        </Box>
      )
    }

    const updatesTab = () => {
      const items = found?.updates ?? []
      const readyNow = readyOf(found)
      const reviews = items.filter(item => item.kind === 'review')
      const manual = items.filter(item => item.kind === 'manual')

      if (items.length === 0) {
        return <Text dimColor>Everything is up to date. Updates checks once a week; /updates checks now.</Text>
      }

      return (
        <Box flexDirection="column" rowGap={1}>
          {readyNow.length > 0 ? (
            <Box flexDirection="column" rowGap={1}>
              <Box flexDirection="row" columnGap={2} alignItems="center">
                <Box flexGrow={1}>
                  <Text dimColor>{running.length > 0 ? `Updating ${running.length}…` : `${readyNow.length} ready`}</Text>
                </Box>
                {running.length > 0 ? null : (
                  <Button key="update-all" label="Update all" variant="primary" onPress={() => applyUpdates($, readyNow.map(item => item.id))} />
                )}
              </Box>
              {readyNow.map(updateRow)}
            </Box>
          ) : (
            <Text dimColor>Nothing updates by itself right now.</Text>
          )}
          {reviews.length > 0 ? (
            <Box flexDirection="column" rowGap={1}>
              <Text dimColor>Changed upstream · yours to merge</Text>
              {reviews.map(updateRow)}
            </Box>
          ) : null}
          {manual.length > 0 ? (
            <Box flexDirection="column" rowGap={1}>
              <Text dimColor>Needs you</Text>
              {manual.map(updateRow)}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1} rowGap={1}>
        <Box flexDirection="row" columnGap={2}>
          {(['yours', 'installed', 'updates'] as const).map(name => (
            <Button key={`tab-${name}`} label={labels[name]} plain dimColor={current !== name} onPress={() => update($, tab, () => name)} />
          ))}
        </Box>
        {failed === null ? null : <Text color="error" wrap="wrap">{`Couldn't read your mods: ${failed}`}</Text>}
        {found === null ? (
          <Text dimColor>{loading ? 'Reading your mods…' : 'Nothing read yet.'}</Text>
        ) : current === 'yours' ? (
          yoursTab()
        ) : current === 'installed' ? (
          installedTab()
        ) : (
          updatesTab()
        )}
        {switched.length === 0 && !reloadNow ? null : (
          <Box flexDirection="column">
            <Text dimColor wrap="wrap">
              {switched.length === 0 ? 'Plugins were updated. Reload them to finish.' : `Switched ${switched.length}. Installed plugins switch on a plugin reload; your own mods in new sessions.`}
            </Text>
            <Box flexDirection="row">
              <Button key="reload" label="Reload plugins" plain onPress={() => { void update($, needsReload, () => false); void $.prompt.fill({ text: '/reload-plugins', mode: 'replace' }) }} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
