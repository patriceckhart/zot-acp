import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AvailableCommand,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ModelInfo,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
  type StopReason
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { SessionManager } from './session.js'
import { SessionStore } from './session-store.js'
import { ZotRpcProcess } from '../zot-rpc/process.js'
import { discoverAllModels, type DiscoveredModel } from '../zot-rpc/discover.js'
import { listZotSessions, findZotSessionFile, ensureSessionFile } from './zot-sessions.js'
import { normalizeAssistantText, normalizeUserText } from './translate/messages.js'
import { toolResultToText } from './translate/tools.js'
import { promptToZotMessage } from './translate/prompt.js'
import { loadSkillCommands, loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getZotHome } from './paths.js'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Summarise the current transcript into one synthetic user message'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost)'
    },
    {
      name: 'name',
      description: 'Set the local session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'export',
      description: 'Export the current session transcript to HTML in the session cwd'
    },
    {
      name: 'clear',
      description: 'Drop the entire transcript (zot /clear)'
    }
  ]
}

function mergeCommands(...lists: AvailableCommand[][]): AvailableCommand[] {
  const out: AvailableCommand[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      out.push(c)
    }
  }
  return out
}

const pkg = readNearestPackageJson(import.meta.url)

export class ZotAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()

  private lastSessionCwd: string | null = null

  dispose(): void {
    this.sessions.disposeAll()
  }

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    void _config
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'zot-acp',
        title: 'zot ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.ZOT_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          list: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const skillCommands = loadSkillCommands(params.cwd)

    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands: [...fileCommands, ...skillCommands],
      zotCommand: process.env.ZOT_ACP_ZOT_COMMAND,
      provider: process.env.ZOT_ACP_PROVIDER,
      model: process.env.ZOT_ACP_MODEL
    })

    let state: any = null
    let allModels: DiscoveredModel[] = []

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s
        })
        .catch(() => {
          state = null
        }),
      discoverAllModels({ cwd: params.cwd, zotCommand: process.env.ZOT_ACP_ZOT_COMMAND })
        .then(m => {
          allModels = m
        })
        .catch(() => {
          allModels = []
        })
    ])

    // If discovery returned nothing, fall back to the live process's own list so
    // at least the active provider's models populate.
    if (allModels.length === 0) {
      try {
        const fallback = (await session.proc.getModels()) as any
        if (Array.isArray(fallback?.models)) {
          allModels = fallback.models
            .map((m: any) => {
              const id = String(m?.id ?? '').trim()
              const provider = String(m?.provider ?? state?.provider ?? '').trim()
              if (!id) return null
              return { provider, id } as DiscoveredModel
            })
            .filter(Boolean) as DiscoveredModel[]
        }
      } catch {
        // ignore — surfaced via empty model list
      }
    }

    const models = buildModelState(state, allModels)

    const startupInfo = buildStartupInfo({
      cwd: params.cwd,
      fileCommands,
      skillCommands,
      state
    })

    if (startupInfo) session.setStartupInfo(startupInfo)

    // Keep only one live zot subprocess per ACP connection.
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    const response = {
      sessionId: session.sessionId,
      models,
      _meta: {
        zotAcp: {
          startupInfo: startupInfo || null
        }
      }
    }

    if (startupInfo) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    setTimeout(() => {
      void this.conn
        .sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(
              toAvailableCommands(fileCommands),
              toAvailableCommands(skillCommands),
              builtinAvailableCommands()
            )
          }
        })
        .catch(() => undefined)
    }, 0)

    return response
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal auth is handled out-of-band via `--terminal-login`. Accept and no-op.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)

    const { message, images } = promptToZotMessage(params.prompt)

    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        try {
          await session.proc.compact()
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Compact failed: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // The session translator emits the `compact_done` summary inline, and
        // the trailing `done` event completes the turn through the normal path.
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        try {
          const stats = (await session.proc.getState()) as any
          const lines: string[] = []
          if (stats?.provider) lines.push(`Provider: ${stats.provider}`)
          if (stats?.model) lines.push(`Model: ${stats.model}`)
          if (stats?.cwd) lines.push(`Cwd: ${stats.cwd}`)
          if (typeof stats?.message_count === 'number') lines.push(`Messages: ${stats.message_count}`)

          const u = stats?.usage
          if (u && typeof u === 'object') {
            const parts: string[] = []
            if (typeof u.input === 'number') parts.push(`in ${u.input}`)
            if (typeof u.output === 'number') parts.push(`out ${u.output}`)
            if (typeof u.cache_read === 'number') parts.push(`cache read ${u.cache_read}`)
            if (typeof u.cache_write === 'number') parts.push(`cache write ${u.cache_write}`)
            if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
            if (typeof u.cost_usd === 'number') lines.push(`Cost: $${u.cost_usd.toFixed(4)}`)
          }

          const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
          })
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read session stats: ${String(e?.message ?? e)}` }
            }
          })
        }
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Usage: /name <name>' } }
          })
          return { stopReason: 'end_turn' }
        }

        this.store.setTitle(session.sessionId, name)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Session name set: ${name}` } }
        })
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        const result = await exportHtml(session.sessionId, session.cwd, session.sessionFile)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Session exported: ' } }
        })
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: result.name,
              uri: `file://${result.path}`,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'clear') {
        try {
          await session.proc.clear()
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Transcript cleared.' } }
          })
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Clear failed: ${String(e?.message ?? e)}` }
            }
          })
        }
        return { stopReason: 'end_turn' }
      }
    }

    const result = await session.prompt(message, images)

    const stopReason: StopReason =
      result === 'error' ? (session.wasCancelRequested() ? 'cancelled' : 'end_turn') : result

    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    await session.cancel()
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const all = listZotSessions()

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all

    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.sessions.close(params.sessionId)
    this.lastSessionCwd = params.cwd

    const stored = this.store.get(params.sessionId)
    const sessionFile = stored?.sessionFile ?? findZotSessionFile(params.sessionId)

    if (!sessionFile) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    ensureSessionFile(sessionFile, { sessionId: params.sessionId, cwd: params.cwd })

    let proc: ZotRpcProcess
    try {
      proc = await ZotRpcProcess.spawn({
        cwd: params.cwd,
        zotCommand: process.env.ZOT_ACP_ZOT_COMMAND,
        provider: process.env.ZOT_ACP_PROVIDER,
        model: process.env.ZOT_ACP_MODEL
      })
    } catch (e: any) {
      if (e?.name === 'ZotRpcSpawnError') {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
      }
      throw e
    }

    const fileCommands = loadSlashCommands(params.cwd)
    const skillCommands = loadSkillCommands(params.cwd)

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands: [...fileCommands, ...skillCommands],
      sessionFile
    })

    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile
    })

    // Replay the adapter's local transcript so the client can rehydrate the
    // conversation. zot RPC itself starts with an empty in-memory transcript,
    // so the model will not see this history — it is purely for the UI.
    await replayTranscript(this.conn, session.sessionId, sessionFile)

    let state: any = null
    let allModels: DiscoveredModel[] = []
    await Promise.all([
      proc.getState().then(s => (state = s)).catch(() => undefined),
      discoverAllModels({ cwd: params.cwd, zotCommand: process.env.ZOT_ACP_ZOT_COMMAND })
        .then(m => (allModels = m))
        .catch(() => undefined)
    ])
    const models = buildModelState(state, allModels)

    const response = {
      models,
      _meta: { zotAcp: { startupInfo: null } }
    }

    setTimeout(() => {
      void this.conn
        .sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(
              toAvailableCommands(fileCommands),
              toAvailableCommands(skillCommands),
              builtinAvailableCommands()
            )
          }
        })
        .catch(() => undefined)
    }, 0)

    return response
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId)

    let provider: string | null = null
    let modelId: string
    if (params.modelId.includes('/')) {
      const idx = params.modelId.indexOf('/')
      provider = params.modelId.slice(0, idx)
      modelId = params.modelId.slice(idx + 1)
    } else {
      modelId = params.modelId
    }

    // Same provider as the live process: cheap `set_model` switch.
    if (!provider || provider === session.activeProvider) {
      await session.proc.setModel(modelId)
      if (provider) session.activeProvider = provider
      return
    }

    // Different provider: respawn `zot rpc` with the new --provider/--model.
    // The adapter-local transcript is preserved; zot's in-memory context resets.
    try {
      await session.swapProcess({
        provider,
        model: modelId,
        zotCommand: process.env.ZOT_ACP_ZOT_COMMAND
      })
    } catch (e: any) {
      const authErr = maybeAuthRequiredError(e)
      if (authErr) throw authErr
      throw RequestError.internalError({}, `Failed to switch to ${provider}/${modelId}: ${String(e?.message ?? e)}`)
    }

    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Switched to ${provider}/${modelId} (model context was reset).` }
      }
    })
  }
}

async function replayTranscript(conn: AgentSideConnection, sessionId: string, sessionFile: string): Promise<void> {
  let raw = ''
  try {
    raw = readFileSync(sessionFile, 'utf-8')
  } catch {
    return
  }

  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj?.type !== 'message') continue

    const role = String(obj?.message?.role ?? '')
    if (role === 'user') {
      const text = normalizeUserText(obj?.message?.content)
      if (text) {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }
        })
      }
    } else if (role === 'assistant') {
      const text = normalizeAssistantText(obj?.message?.content)
      if (text) {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
        })
      }
    } else if (role === 'tool_result') {
      const toolName = String(obj?.toolName ?? 'tool')
      const toolCallId = String(obj?.toolCallId ?? crypto.randomUUID())
      const isError = Boolean(obj?.isError)
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: toolName,
          kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
          status: 'completed',
          rawInput: null,
          rawOutput: obj
        }
      })

      const text = toolResultToText(obj)
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
          rawOutput: obj
        }
      })
    }
  }
}

function buildModelState(
  state: any | null,
  models: DiscoveredModel[]
): { availableModels: ModelInfo[]; currentModelId: string } | null {
  const availableModels: ModelInfo[] = models
    .map(m => {
      const id = m.id.trim()
      if (!id) return null
      const provider = m.provider.trim()
      const fullId = provider ? `${provider}/${id}` : id
      return {
        modelId: fullId,
        name: fullId,
        description: null
      } satisfies ModelInfo
    })
    .filter(Boolean) as ModelInfo[]

  let currentModelId: string | null = null
  if (state && typeof state === 'object') {
    const m = typeof state.model === 'string' ? state.model.trim() : ''
    const p = typeof state.provider === 'string' ? state.provider.trim() : ''
    if (m) currentModelId = p ? `${p}/${m}` : m
  }

  if (!availableModels.length && !currentModelId) return null
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return { availableModels, currentModelId }
}

async function exportHtml(
  sessionId: string,
  cwd: string,
  sessionFile: string
): Promise<{ path: string; name: string }> {
  const { writeFileSync } = await import('node:fs')
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const name = `zot-session-${safe}.html`
  const outPath = join(cwd, name)

  let raw = ''
  try {
    raw = readFileSync(sessionFile, 'utf-8')
  } catch {
    raw = ''
  }

  const lines = raw.split(/\r?\n/).filter(Boolean)
  const escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  const blocks: string[] = []
  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj?.type !== 'message') continue
    const role = String(obj?.message?.role ?? '')
    const content = Array.isArray(obj?.message?.content)
      ? obj.message.content
          .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('')
      : ''
    if (!content) continue
    blocks.push(
      `<section class="msg msg-${escape(role)}"><h3>${escape(role)}</h3><pre>${escape(content)}</pre></section>`
    )
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>zot session ${escape(sessionId)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 880px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  .msg { border: 1px solid #e5e5e5; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
  .msg h3 { margin: 0 0 0.5rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  .msg-user { background: #f5f8ff; }
  .msg-assistant { background: #fafafa; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>zot session</h1>
<p>Session ID: ${escape(sessionId)}</p>
${blocks.join('\n')}
</body>
</html>
`

  writeFileSync(outPath, html, 'utf-8')
  return { path: outPath, name }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  skillCommands: ReturnType<typeof loadSkillCommands>
  state: any | null
}): string {
  const md: string[] = []

  const provider = typeof opts.state?.provider === 'string' ? opts.state.provider : null
  const model = typeof opts.state?.model === 'string' ? opts.state.model : null
  if (provider || model) {
    md.push(`zot — ${[provider, model].filter(Boolean).join(' / ')}`)
    md.push('---')
    md.push('')
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return
    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  const skills: string[] = opts.skillCommands.map(c => `/${c.name}`)
  addSection('Skills', skills)

  const prompts: string[] = opts.fileCommands.map(c => `/${c.name}`)
  addSection('Prompts', prompts)

  const exts: string[] = []
  const extDir = join(getZotHome(), 'extensions')
  try {
    for (const e of readdirSync(extDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const manifest = join(extDir, e.name, 'extension.json')
      try {
        const st = statSync(manifest)
        if (st.isFile()) exts.push(e.name)
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  addSection('Extensions', exts)

  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): { name?: string; version?: string } {
  try {
    let dir = dirname(fileURLToPath(metaUrl))
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'zot-acp', version: '0.0.0' }
}
