import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { maybeAuthRequiredError } from './auth-required.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { ZotRpcProcess, ZotRpcSpawnError, type ZotRpcEvent } from '../zot-rpc/process.js'
import { SessionStore } from './session-store.js'
import { appendSessionLine, buildSessionFile, ensureSessionFile } from './zot-sessions.js'
import { toolResultToText } from './translate/tools.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: FileSlashCommand[]
  zotCommand?: string
  provider?: string
  model?: string
}

export type SwapProcessParams = {
  provider: string
  model?: string
  zotCommand?: string
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path =
    typeof (args as { path?: unknown } | null | undefined)?.path === 'string'
      ? (args as { path: string }).path
      : undefined
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

function parseToolArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return { _raw: raw }
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>
  return undefined
}

export class SessionManager {
  private sessions = new Map<string, ZotAcpSession>()
  private readonly store = new SessionStore()

  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  maybeGet(sessionId: string): ZotAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<ZotAcpSession> {
    let proc: ZotRpcProcess
    try {
      proc = await ZotRpcProcess.spawn({
        cwd: params.cwd,
        zotCommand: params.zotCommand,
        provider: params.provider,
        model: params.model
      })
    } catch (e) {
      if (e instanceof ZotRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    // zot RPC mode does not persist sessions, so the adapter mints its own id
    // and writes a parallel JSONL transcript under $ZOT_HOME/zot-acp/sessions/.
    const sessionId = crypto.randomUUID()
    const sessionFile = buildSessionFile(sessionId)
    ensureSessionFile(sessionFile, { sessionId, cwd: params.cwd })
    this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })

    const session = new ZotAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      sessionFile,
      provider: params.provider,
      zotCommand: params.zotCommand
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): ZotAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: ZotRpcProcess; sessionFile: string }): ZotAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new ZotAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      sessionFile: params.sessionFile,
      provider: params.provider,
      zotCommand: params.zotCommand
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class ZotAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]
  readonly sessionFile: string

  private startupInfo: string | null = null
  private startupInfoSentOutOfTurn = false
  private startupInfoSentInPrompt = false

  proc: ZotRpcProcess
  activeProvider: string | null
  private readonly zotCommand: string | undefined
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  private cancelRequested = false

  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  private toolCallArgs = new Map<string, Record<string, unknown> | undefined>()
  private editSnapshots = new Map<string, { path: string; oldText: string }>()

  // Buffered assistant text for the current turn, so we can flush it into the
  // local JSONL transcript when the turn ends.
  private assistantBuffer = ''
  private lastUserPrompt = ''

  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: ZotRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    sessionFile: string
    provider?: string
    zotCommand?: string
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.sessionFile = opts.sessionFile
    this.activeProvider = opts.provider ?? null
    this.zotCommand = opts.zotCommand

    this.proc.onEvent(ev => this.handleZotEvent(ev))
  }

  /**
   * Replace the underlying zot subprocess with a fresh one bound to the given
   * provider/model. Used when the ACP client switches model across providers,
   * since `zot rpc` is single-provider per process.
   *
   * The adapter's local transcript and ACP session id are preserved; only the
   * model context is reset (zot RPC has no session reload command).
   */
  async swapProcess(params: SwapProcessParams): Promise<void> {
    // Cancel any in-flight turn before tearing down the old process.
    try {
      if (this.pendingTurn) {
        this.cancelRequested = true
        try { await this.proc.abort() } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    try { this.proc.dispose?.() } catch { /* ignore */ }

    const next = await ZotRpcProcess.spawn({
      cwd: this.cwd,
      zotCommand: params.zotCommand ?? this.zotCommand,
      provider: params.provider,
      model: params.model
    })

    this.proc = next
    this.activeProvider = params.provider
    this.proc.onEvent(ev => this.handleZotEvent(ev))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSentOutOfTurn = false
    this.startupInfoSentInPrompt = false
  }

  sendStartupInfoIfPending(): void {
    if (this.startupInfoSentOutOfTurn || !this.startupInfo) return
    this.startupInfoSentOutOfTurn = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  private sendStartupInfoOnFirstPromptIfPending(): void {
    if (this.startupInfoSentInPrompt || !this.startupInfo) return
    this.startupInfoSentInPrompt = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    this.sendStartupInfoOnFirstPromptIfPending()

    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { zotAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { zotAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    try {
      await this.proc.abort()
    } catch {
      // ignore — abort may race with normal termination
    }
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // ignore notification errors (client may have gone away)
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.assistantBuffer = ''
    this.lastUserPrompt = t.message
    this.currentToolCalls.clear()
    this.toolCallArgs.clear()
    this.editSnapshots.clear()

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { zotAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Persist the user prompt to the adapter's transcript.
    appendSessionLine(this.sessionFile, {
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: t.message }]
      }
    })

    this.proc.prompt(t.message, t.images).catch(err => {
      void this.flushEmits().finally(() => {
        const authErr = maybeAuthRequiredError(err)
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null

        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { zotAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
      })
      void err
    })
  }

  private completeTurn(reason: StopReason): void {
    void this.flushEmits().finally(() => {
      if (this.assistantBuffer) {
        appendSessionLine(this.sessionFile, {
          type: 'message',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: this.assistantBuffer }]
          }
        })
        this.assistantBuffer = ''
      }

      this.pendingTurn?.resolve(reason)
      this.pendingTurn = null

      const next = this.turnQueue.shift()
      if (next) {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        })
        this.startTurn(next)
      } else {
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { zotAcp: { queueDepth: 0, running: false } }
        })
      }
    })
  }

  private handleZotEvent(ev: ZotRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'text_delta': {
        const delta = String((ev as any).delta ?? '')
        if (!delta) break
        this.assistantBuffer += delta
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: delta } satisfies ContentBlock
        })
        break
      }

      case 'tool_call': {
        const toolCallId = String((ev as any).id ?? '')
        const toolName = String((ev as any).name ?? 'tool')
        if (!toolCallId) break

        const args = parseToolArgs((ev as any).args)
        this.toolCallArgs.set(toolCallId, args)

        let line: number | undefined

        // Capture pre-edit file contents so we can emit a structured ACP diff
        // when the edit tool completes.
        if (toolName === 'edit') {
          const p = typeof args?.path === 'string' ? (args.path as string) : undefined
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const oldText = readFileSync(abs, 'utf8')
              this.editSnapshots.set(toolCallId, { path: p, oldText })

              const needle = typeof args?.oldText === 'string' ? (args.oldText as string) : ''
              line = findUniqueLineNumber(oldText, needle)
            } catch {
              // ignore snapshot failures
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)
        this.currentToolCalls.set(toolCallId, 'in_progress')

        this.emit({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: toolName,
          kind: toToolKind(toolName),
          status: 'in_progress',
          locations,
          rawInput: args
        })
        break
      }

      case 'tool_progress': {
        const toolCallId = String((ev as any).id ?? '')
        if (!toolCallId) break

        const text = String((ev as any).text ?? '')
        if (!text) break

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        })
        break
      }

      case 'tool_result': {
        const toolCallId = String((ev as any).id ?? '')
        if (!toolCallId) break

        const isError = Boolean((ev as any).is_error)
        const text = toolResultToText(ev)

        const snapshot = this.editSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                },
                ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
              ]
            }
          } catch {
            // ignore
          }
        }

        if (!content && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: ev
        })

        this.currentToolCalls.delete(toolCallId)
        this.toolCallArgs.delete(toolCallId)
        this.editSnapshots.delete(toolCallId)
        break
      }

      case 'usage': {
        // Surface cumulative usage as session info metadata so clients that show
        // token/cost stats can update without an explicit /session call.
        const cum = (ev as any).cumulative ?? (ev as any).usage
        if (cum && typeof cum === 'object') {
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { zotAcp: { usage: cum } }
          })
        }
        break
      }

      case 'assistant_start':
      case 'turn_start':
      case 'user_message':
      case 'assistant_message':
      case 'turn_end': {
        // zot uses turn_end for sub-steps too (e.g. tool_use); we rely on `done`
        // as the final signal for the ACP prompt response.
        break
      }

      case 'compact_done': {
        const summary = String((ev as any).summary ?? '')
        if (summary) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: summary } satisfies ContentBlock
          })
        }
        // Compaction shares its lifecycle with prompts; `done` resolves the turn.
        break
      }

      case 'error': {
        const msg = String((ev as any).message ?? 'unknown zot error')
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Error: ${msg}` } satisfies ContentBlock
        })
        break
      }

      case 'done': {
        const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
        this.completeTurn(reason)
        break
      }

      default:
        break
    }
  }
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'other'
    default:
      return 'other'
  }
}
