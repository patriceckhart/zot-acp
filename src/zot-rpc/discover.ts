import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import { getZotCommand, shouldUseShellForZotCommand } from './command.js'

/**
 * Built-in zot providers. zot rpc is single-provider per process, so to populate
 * a cross-provider model picker the adapter spawns a short-lived `zot rpc
 * --provider X` for each and aggregates the `get_models` responses.
 *
 * `openai-codex` is the ChatGPT/Codex subscription route; it is treated as a
 * separate provider in zot because it reads the OAuth token from auth.json
 * (`openai.oauth`) rather than an OpenAI API key, and posts to
 * `chatgpt.com/backend-api/codex/responses`. See zot's `internal/agent/config.go`
 * `ResolveCredentialFull`.
 */
export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'openai-codex', 'kimi', 'google', 'deepseek'] as const
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number]

export type DiscoveredModel = {
  provider: string
  id: string
  context_window?: number
  max_output?: number
  reasoning?: boolean
}

const TIMEOUT_MS = 5000

/**
 * Spawn `zot rpc --provider X` just long enough to issue one `get_models` command,
 * then kill it. Used to enumerate models across every provider without keeping
 * five+ zot subprocesses alive.
 *
 * Failures (missing credential, network down, executable absent, provider with
 * no auth configured) resolve to an empty list so a single bad provider doesn't
 * break the picker. This means the picker shows exactly the providers the user
 * is logged into via the `zot` CLI.
 */
export function discoverModelsForProvider(
  provider: string,
  opts: { cwd: string; zotCommand?: string } = { cwd: process.cwd() }
): Promise<DiscoveredModel[]> {
  return new Promise(resolve => {
    const cmd = getZotCommand(opts.zotCommand)
    const args = ['rpc', '--provider', provider, '--cwd', opts.cwd]

    let settled = false
    const settle = (models: DiscoveredModel[]) => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      resolve(models)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: 'pipe',
        env: process.env,
        shell: shouldUseShellForZotCommand(cmd)
      })
    } catch {
      resolve([])
      return
    }

    const timer = setTimeout(() => settle([]), TIMEOUT_MS)

    child.on('error', () => settle([]))
    child.on('exit', () => {
      clearTimeout(timer)
      settle([])
    })

    if (!child.stdout || !child.stdin) {
      settle([])
      return
    }

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }

      if (msg?.type === 'response' && msg?.command === 'get_models') {
        const models = Array.isArray(msg?.data?.models) ? msg.data.models : []
        const out: DiscoveredModel[] = models
          .map((m: any) => {
            const id = typeof m?.id === 'string' ? m.id.trim() : ''
            const p = typeof m?.provider === 'string' ? m.provider.trim() : provider
            if (!id) return null
            return {
              provider: p || provider,
              id,
              context_window: typeof m?.context_window === 'number' ? m.context_window : undefined,
              max_output: typeof m?.max_output === 'number' ? m.max_output : undefined,
              reasoning: typeof m?.reasoning === 'boolean' ? m.reasoning : undefined
            } satisfies DiscoveredModel
          })
          .filter(Boolean) as DiscoveredModel[]
        clearTimeout(timer)
        settle(out)
      }
    })

    try {
      child.stdin.write(JSON.stringify({ id: '1', type: 'get_models' }) + '\n')
    } catch {
      settle([])
    }
  })
}

/**
 * Enumerate models across every known zot provider in parallel.
 *
 * Providers with no usable credentials surface an empty list (zot rpc exits
 * before responding), so the picker mirrors what the `zot` CLI is logged into.
 */
export async function discoverAllModels(opts: {
  cwd: string
  zotCommand?: string
  providers?: readonly string[]
}): Promise<DiscoveredModel[]> {
  const providers = opts.providers ?? KNOWN_PROVIDERS

  const results = await Promise.all(
    providers.map(p =>
      discoverModelsForProvider(p, { cwd: opts.cwd, zotCommand: opts.zotCommand }).catch(() => [] as DiscoveredModel[])
    )
  )

  const flat: DiscoveredModel[] = []
  for (const list of results) flat.push(...list)

  flat.sort((a, b) => (a.provider + a.id).localeCompare(b.provider + b.id))

  return flat
}
