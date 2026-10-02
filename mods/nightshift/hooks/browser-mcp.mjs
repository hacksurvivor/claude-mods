// Claude's browser pane, offered to Codex as an MCP server.
//
// Codex starts this as a stdio MCP server for a run Nightshift hands it. Each tool
// call Codex makes waits here until Nightshift, polling the Unix socket below,
// carries it out in the Claude app's own browser pane ($.mcp.call on
// Claude_Browser) and posts the result back. So the user watches Codex browse
// where Claude would have.
//
//   node browser-mcp.mjs <socket>
//
// Nightshift's side: GET /next (a call, or 204 after 20 s), POST /result {id, result}.

import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [socketPath] = process.argv.slice(2)

const tab = { tabId: { type: 'string', description: 'Tab to act on; omit for the front tab' } }
const why = {
  action_summary: {
    type: 'string',
    description: 'A few words saying what this does on the page, e.g. "Opens the pricing page". Required for clicks, typing and keys.',
  },
}

// The browser pane's tools, as Codex sees them: the same names and arguments
// Claude's own browser tools take.
const TOOLS = [
  {
    name: 'navigate',
    description: 'Open a URL in the browser pane the user is watching in Claude, or go "back"/"forward".',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, ...tab }, required: ['url'] },
  },
  {
    name: 'get_page_text',
    description: "Read the page's visible text (article first, then body).",
    inputSchema: { type: 'object', properties: { max_chars: { type: 'number' }, ...tab } },
  },
  {
    name: 'read_page',
    description: 'Read the page as an accessibility tree; interactive elements carry ref_N ids for clicks and form input.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', enum: ['interactive', 'all'] }, max_chars: { type: 'number' }, ref_id: { type: 'string' }, ...tab },
    },
  },
  {
    name: 'find',
    description: 'Find elements whose role, name or text contains `query`; returns ref_N ids.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...tab }, required: ['query'] },
  },
  {
    name: 'computer',
    description:
      'Mouse and keyboard in the browser pane: screenshot, left_click (coordinate or ref), type, key, scroll, scroll_to, hover, wait. ' +
      'Take a screenshot before clicking by coordinate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'left_click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'scroll_to', 'hover', 'wait', 'zoom'],
        },
        coordinate: { type: 'array', items: { type: 'number' } },
        ref: { type: 'string' },
        text: { type: 'string' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number' },
        duration: { type: 'number' },
        region: { type: 'array', items: { type: 'number' } },
        ...why,
        ...tab,
      },
      required: ['action'],
    },
  },
  {
    name: 'form_input',
    description: 'Set the value of a form element by ref (input, textarea, select, checkbox).',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: {}, ...why, ...tab },
      required: ['ref', 'value'],
    },
  },
  { name: 'tabs_context', description: 'List the browser pane tabs.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'tabs_create',
    description: 'Open a new blank tab in the browser pane.',
    inputSchema: { type: 'object', properties: { foreground: { type: 'boolean' } } },
  },
]

// --- calls waiting for Nightshift ------------------------------------------------

let nextId = 1
const queue = []
const waiting = new Map()
let poller

function hand(call) {
  if (poller) {
    const respond = poller

    poller = undefined
    respond(call)
  } else {
    queue.push(call)
  }
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/next') {
    const call = queue.shift()

    if (call) {
      response.end(JSON.stringify(call))
      return
    }

    const timer = setTimeout(() => {
      if (poller === send) {
        poller = undefined
      }

      response.statusCode = 204
      response.end()
    }, 20000)
    const send = next => {
      clearTimeout(timer)
      response.end(JSON.stringify(next))
    }

    poller = send
    return
  }

  if (request.method === 'POST' && request.url === '/result') {
    let body = ''

    request.on('data', chunk => (body += chunk))
    request.on('end', () => {
      try {
        const { id, result } = JSON.parse(body)

        waiting.get(id)?.(JSON.stringify(result))
        waiting.delete(id)
      } catch {
        // A malformed answer is dropped; the step times out for Codex.
      }

      response.end('ok')
    })
    return
  }

  response.statusCode = 404
  response.end()
})

if (socketPath) {
  rmSync(socketPath, { force: true })
  server.listen(socketPath)
}

function shutdown() {
  server.close()

  if (socketPath) {
    rmSync(socketPath, { force: true })
  }

  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// --- MCP over stdio ---------------------------------------------------------

const reply = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

function runTool(name, args) {
  return new Promise(resolve => {
    const id = nextId++
    // Nightshift answers in seconds; past two minutes it is gone.
    const timer = setTimeout(() => {
      waiting.delete(id)
      resolve({ content: [{ type: 'text', text: "Claude's browser pane did not answer." }], isError: true })
    }, 120000)

    waiting.set(id, body => {
      clearTimeout(timer)

      try {
        resolve(JSON.parse(body))
      } catch {
        resolve({ content: [{ type: 'text', text: String(body) }], isError: true })
      }
    })
    hand({ id, tool: name, args: args ?? {} })
  })
}

const lines = createInterface({ input: process.stdin })

lines.on('line', async line => {
  let message

  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  const { id, method, params } = message

  if (method === 'initialize') {
    reply({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude_browser', version: '0.1.0' },
        instructions:
          "These tools drive the browser pane the user is watching inside the Claude app. Use them for any web browsing in this task.",
      },
    })
  } else if (method === 'tools/list') {
    reply({ id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const known = TOOLS.some(tool => tool.name === params?.name)
    const result = known
      ? await runTool(params.name, params.arguments)
      : { content: [{ type: 'text', text: `No tool named ${params?.name}` }], isError: true }

    reply({ id, result })
  } else if (method === 'ping') {
    reply({ id, result: {} })
  } else if (id !== undefined) {
    reply({ id, error: { code: -32601, message: `Unknown method ${method}` } })
  }
})

lines.on('close', shutdown)
