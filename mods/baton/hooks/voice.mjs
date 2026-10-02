// Baton's voice bridge: Codex's live voice in Claude's window.
//
// It runs the two pieces the Codex CLI's own /voice runs: `codex app-server`
// (JSON-RPC over stdio, on the user's own Codex login) and the voice helper
// bundled with Codex, which owns WebRTC, the mic and the speaker. Audio never
// passes through here. It reports to Baton as JSON lines on stdout and takes
// Mute and End over HTTP on a Unix socket.
//
//   node voice.mjs <cwd> <socket> <codex|claude> <browser socket> [model]
//
// Lines out: {t:'state',phase,error?} {t:'caption',role,text,final}
// {t:'work',text} {t:'image',path} {t:'level',mic} {t:'exchange',you,codex,images}
// {t:'claude',task,you}: work the user wants Claude to do; Codex's run of it is stopped.
//
// Codex does the work it is handed, unless the user says Claude should (or
// picked Claude for all of it): then Baton hands the task to Claude, and reads
// Claude's answer back through /speak.

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [cwd = process.cwd(), socketPath, firstWorker = 'codex', browserSocket = '-', model] = process.argv.slice(2)

// Claude's browser pane for the voice's Codex turns, as Baton's codex tool has
// it: Codex does not ask before its steps; Baton asks in Claude.
const BROWSER =
  browserSocket === '-'
    ? []
    : [
        'mcp_servers.claude_browser.command="node"',
        `mcp_servers.claude_browser.args=${JSON.stringify([join(import.meta.dirname, 'browser-mcp.mjs'), browserSocket])}`,
        'mcp_servers.claude_browser.tool_timeout_sec=180',
        'mcp_servers.claude_browser.default_tools_approval_mode="approve"',
      ]
const say = event => process.stdout.write(`${JSON.stringify(event)}\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The voice helper ships inside the platform package next to the codex binary.
function voicePackage() {
  const codex = execFileSync('/bin/zsh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim()
  let dir = dirname(execFileSync('/usr/bin/readlink', ['-f', codex], { encoding: 'utf8' }).trim())

  for (let up = 0; up < 6; up++) {
    const found = execFileSync('/usr/bin/find', [dir, '-maxdepth', '9', '-path', '*codex-resources/voice/manifest.json'], {
      encoding: 'utf8',
    })
      .split('\n')
      .find(Boolean)

    if (found) {
      const root = dirname(dirname(dirname(found)))
      const manifest = JSON.parse(readFileSync(found, 'utf8'))

      return { root, helper: join(root, 'codex-resources/voice/bin/codex-voice-host'), commit: manifest.buildCommit }
    }

    dir = dirname(dir)
  }

  throw new Error("this Codex install has no voice helper; update Codex with `codex update`")
}

// --- the voice helper: frames are a big-endian u32 length, then JSON --------

const KEEP = ['HOME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
const RUNTIME = {
  GST_PLUGIN_PATH: '',
  GST_PLUGIN_PATH_1_0: '',
  GST_PLUGIN_SYSTEM_PATH: '',
  GST_PLUGIN_SYSTEM_PATH_1_0: '',
  GST_REGISTRY: '/dev/null',
  GST_REGISTRY_UPDATE: 'no',
  GST_REGISTRY_FORK: 'no',
}

let host
const hostWaiters = []

function startHost(pkg) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => KEEP.includes(key.toUpperCase())))

  host = spawn(pkg.helper, [], { cwd: pkg.root, env: { ...env, ...RUNTIME }, stdio: ['pipe', 'pipe', 'ignore'] })

  let buffer = Buffer.alloc(0)

  host.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data])

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)

      if (buffer.length < 4 + length) {
        break
      }

      const message = JSON.parse(buffer.subarray(4, 4 + length).toString())

      buffer = buffer.subarray(4 + length)
      hostWaiters.shift()?.resolve(message)
    }
  })
  host.on('exit', () => {
    for (const waiter of hostWaiters.splice(0)) {
      waiter.reject(new Error('the voice helper stopped'))
    }

    if (phase === 'live') {
      finish('the voice helper stopped')
    }
  })
}

function toHost(message, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`voice helper did not answer ${message.type}`)), ms)
    const body = Buffer.from(JSON.stringify(message))
    const head = Buffer.alloc(4)

    head.writeUInt32BE(body.length)
    hostWaiters.push({
      resolve: value => (clearTimeout(timer), resolve(value)),
      reject: error => (clearTimeout(timer), reject(error)),
    })
    host.stdin.write(Buffer.concat([head, body]))
  })
}

async function expectHost(message, type, ms) {
  const answer = await toHost(message, ms)

  if (answer.type !== type) {
    throw new Error(answer.type === 'transportTimedOut' ? 'voice connection timed out' : `voice helper said ${answer.type}`)
  }

  return answer
}

// --- the app server: newline-delimited JSON-RPC ----------------------------

let app
let nextId = 1
const calls = new Map()
const listeners = new Set()

function startApp() {
  app = spawn('/bin/zsh', ['-lc', 'exec codex "$@"', 'codex', 'app-server', ...BROWSER.flatMap(pair => ['-c', pair])], {
    cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
  })

  let buffer = ''

  app.stdout.on('data', data => {
    buffer += data

    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim()

      buffer = buffer.slice(end + 1)

      if (line === '') {
        continue
      }

      let message

      try {
        message = JSON.parse(line)
      } catch {
        continue
      }

      if (message.id !== undefined && message.method === undefined && calls.has(message.id)) {
        calls.get(message.id)(message)
        calls.delete(message.id)
      } else if (message.id !== undefined && message.method !== undefined) {
        answerServer(message)
      } else if (message.method !== undefined) {
        for (const listen of listeners) {
          listen(message)
        }
      }
    }
  })
  app.on('exit', () => {
    if (phase === 'live' || phase === 'connecting') {
      finish('Codex stopped')
    }
  })
}

// Codex asking the client something. Its own prompts during voice reach the
// user through Codex's hooks first; anything left here is declined, so a turn
// never waits on a question nobody sees.
function answerServer(message) {
  const result =
    message.method === 'mcpServer/elicitation/request'
      ? { action: 'decline', content: null, _meta: null }
      : message.method.endsWith('requestApproval') || message.method.endsWith('Approval')
        ? { decision: 'decline' }
        : undefined

  app.stdin.write(
    `${JSON.stringify(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'not handled by Baton' } })}\n`,
  )
}

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++

    calls.set(id, message => (message.error ? reject(new Error(message.error.message ?? method)) : resolve(message.result)))
    app.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

function nextNote(method, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (listeners.delete(listen), reject(new Error(`no ${method}`))), ms)
    const listen = message => {
      if (message.method === method) {
        clearTimeout(timer)
        listeners.delete(listen)
        resolve(message.params)
      } else if (message.method === 'thread/realtime/error') {
        clearTimeout(timer)
        listeners.delete(listen)
        reject(new Error(message.params?.message ?? 'Codex voice failed'))
      }
    }

    listeners.add(listen)
  })
}

// --- the conversation -------------------------------------------------------

let phase = 'connecting'
let threadId
let muted = false
let devicesOpen = false
let worker = firstWorker === 'claude' ? 'claude' : 'codex'
let activeTurn
let stopNextTurn = false
let lastYou = ''

// What the voice is told about the two workers, at the start and on a switch.
const ROUTING =
  'You are the voice of Codex inside Claude Code, where two agents can do work: Codex (your usual delegation) ' +
  "and Claude. When the user wants Claude to do something (\"pass this to Claude\", \"ask Claude\", \"let Claude do it\"), " +
  'still delegate it, but begin the delegation with "For Claude:" and tell the user in a few words that Claude is on it. ' +
  'A later message that begins "Claude says:" is Claude\'s answer: tell the user what it says, briefly and naturally.'
const workerNote = () =>
  worker === 'claude'
    ? 'The user chose Claude for all work: begin every delegation with "For Claude:" and say Claude is on it.'
    : 'The user chose Codex for work unless they ask for Claude.'

// Claude's when the user picked Claude, the delegation says so, or the user's
// last words name Claude ("cloud" is how speech often hears it).
function isForClaude(input) {
  return worker === 'claude' || /^\W*for claude\b/i.test(input) || /\b(claude|clawed|clod)\b/i.test(lastYou) ||
    /\b(pass|hand|give|send|ask|let)\b.{0,24}\bcloud\b/i.test(lastYou)
}

function stopTurn(turnId) {
  if (threadId && turnId) {
    void call('turn/interrupt', { threadId, turnId }).catch(() => {})
  }
}

// `/bin/zsh -lc 'npm test'` reads as `npm test`.
function shortCommand(command) {
  const inner = /^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"]?)(.*)\1$/s.exec(command ?? '')?.[2] ?? command ?? ''
  const line = inner.split('\n')[0].trim()

  return line.length > 28 ? `${line.slice(0, 27)}…` : line
}
const partial = { user: '', assistant: '' }
let exchange = { you: [], codex: [], images: [] }

function flush() {
  if (exchange.you.length > 0 || exchange.codex.length > 0 || exchange.images.length > 0) {
    say({ t: 'exchange', you: exchange.you.join(' '), codex: exchange.codex.join(' '), images: exchange.images })
  }

  exchange = { you: [], codex: [], images: [] }
}

function onNote(message) {
  const params = message.params ?? {}

  switch (message.method) {
    case 'thread/realtime/transcript/delta': {
      const role = params.role === 'user' ? 'user' : 'assistant'

      // A new thing said by you closes the exchange before it.
      if (role === 'user' && partial.user === '' && exchange.codex.length > 0) {
        flush()
      }

      partial[role] += params.delta ?? ''
      say({ t: 'caption', role, text: partial[role], final: false })
      break
    }
    case 'thread/realtime/transcript/done': {
      const role = params.role === 'user' ? 'user' : 'assistant'
      const text = (params.text ?? partial[role]).trim()

      partial[role] = ''

      if (text !== '') {
        if (role === 'user' && exchange.codex.length > 0) {
          flush()
        }

        if (role === 'user') {
          lastYou = text
        }

        ;(role === 'user' ? exchange.you : exchange.codex).push(text)
        say({ t: 'caption', role, text, final: true })
      }

      break
    }
    case 'thread/realtime/itemAdded': {
      const item = params.item ?? {}

      if (item.type === 'handoff_request' && isForClaude(item.input_transcript ?? '')) {
        const task = String(item.input_transcript ?? '').replace(/^\W*for claude\W*/i, '').trim() || lastYou

        // Codex has already started on it; stop that run, now or as it starts.
        if (activeTurn) {
          stopTurn(activeTurn)
        } else {
          stopNextTurn = true
        }

        say({ t: 'claude', task, you: exchange.you.join(' ') || lastYou })
        exchange.you = []
        say({ t: 'work', text: 'Claude is on it' })
      }

      break
    }
    case 'turn/started': {
      activeTurn = params.turn?.id ?? params.turnId

      if (stopNextTurn) {
        stopNextTurn = false
        stopTurn(activeTurn)
      }

      break
    }
    case 'item/started': {
      const item = params.item ?? {}

      if (item.type === 'commandExecution') {
        say({ t: 'work', text: `Running ${shortCommand(item.command)}` })
      } else if (item.type === 'imageGeneration') {
        say({ t: 'work', text: 'Making the image' })
      } else if (item.type === 'fileChange') {
        say({ t: 'work', text: 'Editing files' })
      }

      break
    }
    case 'item/completed': {
      const item = params.item ?? {}

      if (item.type === 'imageGeneration' && item.status !== 'failed' && typeof item.savedPath === 'string') {
        exchange.images.push(item.savedPath)
        say({ t: 'image', path: item.savedPath })
      }

      break
    }
    case 'turn/completed':
      activeTurn = undefined
      say({ t: 'work', text: '' })
      break
    case 'thread/realtime/closed':
      finish(params.reason === 'requested' ? undefined : `voice closed (${params.reason ?? 'unknown'})`)
      break
    case 'thread/realtime/error':
      finish(params.message ?? 'Codex voice failed')
      break
    default:
      break
  }
}

let finishing
function finish(error) {
  if (finishing) {
    return finishing
  }

  finishing = (async () => {
    const wasLive = phase === 'live'

    phase = 'ending'

    if (wasLive && threadId) {
      await Promise.race([call('thread/realtime/stop', { threadId }).catch(() => {}), sleep(2000)])
    }

    flush()

    if (host && host.exitCode === null) {
      await Promise.race([toHost({ type: 'close' }, 3000).catch(() => {}), sleep(3000)])
      host.kill()
    }

    app?.kill()
    server?.close()

    if (socketPath && existsSync(socketPath)) {
      rmSync(socketPath, { force: true })
    }

    phase = 'ended'
    say({ t: 'state', phase: 'ended', ...(error ? { error } : {}) })
    setTimeout(() => process.exit(0), 50)
  })()

  return finishing
}

// --- Mute and End, over HTTP on the socket ---------------------------------

let server

function serve() {
  if (!socketPath) {
    return
  }

  rmSync(socketPath, { force: true })
  server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/mute')) {
        muted = request.url.includes('on=1')

        if (devicesOpen) {
          await expectHost(
            { type: 'setAudioControls', controls: { microphoneMuted: muted, speakerSuppressed: false } },
            'audioControlsApplied',
            5000,
          )
        }
      } else if (request.url?.startsWith('/end')) {
        void finish()
      } else if (request.url?.startsWith('/route')) {
        worker = request.url.includes('to=claude') ? 'claude' : 'codex'
        await call('thread/realtime/appendText', { threadId, text: workerNote(), role: 'developer' })
      } else if (request.url?.startsWith('/speak')) {
        const text = await new Promise(resolve => {
          let body = ''

          request.on('data', chunk => (body += chunk))
          request.on('end', () => resolve(body))
        })

        if (phase === 'live' && text.trim() !== '') {
          await call('thread/realtime/appendSpeech', { threadId, text: `Claude says: ${text.trim()}` })
        }
      }

      response.end('ok')
    } catch (error) {
      response.statusCode = 500
      response.end(String(error.message ?? error))
    }
  })
  server.listen(socketPath)
}

async function levels() {
  while (phase === 'live') {
    try {
      const answer = await toHost({ type: 'inspectAudio' }, 2000)

      if (answer.type === 'audioState') {
        // Speech peaks sit far below full scale; a square root makes them visible.
        say({ t: 'level', mic: muted ? 0 : Math.min(1, Math.sqrt(answer.state.microphonePeak / 32767) * 1.4) })
      }
    } catch {
      // A missed reading is fine; the next one comes in 200 ms.
    }

    await sleep(200)
  }
}

process.on('SIGTERM', () => void finish())
process.on('SIGINT', () => void finish())
process.on('SIGHUP', () => void finish())

try {
  say({ t: 'state', phase: 'connecting' })
  serve()

  const pkg = voicePackage()

  startHost(pkg)
  startApp()
  listeners.add(onNote)

  await expectHost({ type: 'hello', protocol: 1, buildCommit: pkg.commit }, 'ready', 30000)
  await expectHost({ type: 'initializeRuntime' }, 'runtimeReady', 30000)

  const offer = await expectHost({ type: 'startTransport' }, 'offer', 20000)

  await call('initialize', {
    clientInfo: { name: 'baton', title: 'Baton for Claude Code', version: '0.2.0' },
    capabilities: { experimentalApi: true },
  })
  app.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)

  const started = await call('thread/start', {
    cwd,
    ...(model ? { model } : {}),
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
  })

  threadId = started.thread.id

  const answer = nextNote('thread/realtime/sdp', 30000)

  await call('thread/realtime/start', {
    threadId,
    outputModality: 'audio',
    includeStartupContext: false,
    transport: { type: 'webrtc', sdp: offer.sdp },
    version: 'v3',
    backendReasoningStatus: false,
  })

  const { sdp } = await answer

  await expectHost({ type: 'applyAnswer', sdp }, 'transportReady', 25000)
  // Opening the devices is when macOS asks for the microphone, the first time.
  // BATON_VOICE_DRY connects without them, for checks that must not record.
  if (!process.env.BATON_VOICE_DRY) {
    await expectHost({ type: 'openDevices' }, 'devicesOpened', 30000)
    await expectHost(
      { type: 'setAudioControls', controls: { microphoneMuted: false, speakerSuppressed: false } },
      'audioControlsApplied',
      5000,
    )
    devicesOpen = true
  }

  await call('thread/realtime/appendText', { threadId, text: `${ROUTING} ${workerNote()}`, role: 'developer' }).catch(() => {})

  phase = 'live'
  say({ t: 'state', phase: 'live' })
  void levels()
} catch (error) {
  await finish(String(error.message ?? error))
}
