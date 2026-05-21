import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import { getZotCommand, shouldUseShellForZotCommand } from './command.js'

export class ZotRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'ZotRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type ZotRpcCommand =
  | { type: 'hello'; id?: string; token: string }
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'compact'; id?: string }
  | { type: 'get_state'; id?: string }
  | { type: 'get_messages'; id?: string }
  | { type: 'clear'; id?: string }
  | { type: 'set_model'; id?: string; model: string }
  | { type: 'get_models'; id?: string }
  | { type: 'ping'; id?: string }

type ZotRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export type ZotRpcEvent = Record<string, unknown>

type SpawnParams = {
  cwd: string
  /** Optional override for `zot` executable name/path */
  zotCommand?: string
  /** Provider override, forwarded as `--provider`. */
  provider?: string
  /** Model override, forwarded as `--model`. */
  model?: string
  /** Extra args appended verbatim. */
  extraArgs?: string[]
}

export class ZotRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: ZotRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: ZotRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private exited = false

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as ZotRpcResponse)
            return
          }
        }
      }

      for (const h of this.eventHandlers) h(msg as ZotRpcEvent)
    })

    child.on('exit', (code, signal) => {
      this.exited = true
      const err = new Error(`zot process exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })

    child.on('error', err => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  static async spawn(params: SpawnParams): Promise<ZotRpcProcess> {
    const cmd = getZotCommand(params.zotCommand)

    const args: string[] = ['rpc']
    if (params.provider) args.push('--provider', params.provider)
    if (params.model) args.push('--model', params.model)
    if (params.cwd) args.push('--cwd', params.cwd)
    if (params.extraArgs?.length) args.push(...params.extraArgs)

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: process.env,
      shell: shouldUseShellForZotCommand(cmd)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new ZotRpcSpawnError(
          `Could not start zot: executable not found (command: ${cmd}). Install it from https://www.zot.sh or ensure \`zot\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new ZotRpcSpawnError(`Could not start zot: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new ZotRpcSpawnError(`Could not start zot (command: ${cmd}).`, { code, cause: e })
    }

    child.stderr.on('data', () => {
      // leave stderr untouched; ACP clients may capture it.
    })

    const proc = new ZotRpcProcess(child)

    // Optional handshake if zot was launched with ZOTCORE_RPC_TOKEN. The adapter
    // doesn't set the token itself, but if the user exports it we forward it so
    // the spawned zot accepts our commands.
    const token = process.env.ZOTCORE_RPC_TOKEN
    if (token) {
      try {
        const res = await proc.request({ type: 'hello', token })
        if (!res.success) throw new Error(`hello failed: ${res.error ?? 'unknown'}`)
      } catch (e: any) {
        proc.dispose()
        throw new ZotRpcSpawnError(`zot hello (token) handshake failed: ${String(e?.message ?? e)}`)
      }
    }

    return proc
  }

  onEvent(handler: (ev: ZotRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed || this.exited) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins.
   * zot's `rpc` mode shouldn't emit any, but we keep the buffer for resilience.
   */
  consumePreludeLines(): string[] {
    return this.preludeLines.splice(0, this.preludeLines.length)
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`zot prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`zot abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(): Promise<unknown> {
    const res = await this.request({ type: 'compact' })
    if (!res.success) throw new Error(`zot compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`zot get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`zot get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async clear(): Promise<void> {
    const res = await this.request({ type: 'clear' })
    if (!res.success) throw new Error(`zot clear failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setModel(model: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', model })
    if (!res.success) throw new Error(`zot set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_models' })
    if (!res.success) throw new Error(`zot get_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async ping(): Promise<unknown> {
    const res = await this.request({ type: 'ping' })
    if (!res.success) throw new Error(`zot ping failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  private request(cmd: ZotRpcCommand): Promise<ZotRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = JSON.stringify(withId) + '\n'

    return new Promise<ZotRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      try {
        this.child.stdin.write(line, err => {
          if (err) {
            this.pending.delete(id)
            reject(err)
          }
        })
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
    })
  }
}
