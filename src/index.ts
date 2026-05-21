import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { ZotAcpAgent } from './acp/agent.js'
import { getZotCommand, shouldUseShellForZotCommand } from './zot-rpc/command.js'

// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getZotCommand(process.env.ZOT_ACP_ZOT_COMMAND)
  const res = spawnSync(cmd, [], {
    stdio: 'inherit',
    env: process.env,
    shell: shouldUseShellForZotCommand(cmd)
  })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `zot-acp: could not start zot (command not found: ${cmd}). Install it from https://www.zot.sh or ensure \`zot\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>(resolve => {
      if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()

      try {
        process.stdout.write(chunk, err => {
          void err
          resolve()
        })
      } catch {
        resolve()
      }
    })
  }
})

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.on('end', () => controller.close())
    process.stdin.on('error', err => controller.error(err))
  }
})

const stream = ndJsonStream(input, output)

const agent = new AgentSideConnection(conn => new ZotAcpAgent(conn), stream)

function shutdown() {
  try {
    ;(agent as any)?.agent?.dispose?.()
  } catch {
    // ignore
  }
  try {
    process.exit(0)
  } catch {
    // ignore
  }
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.stdout.on('error', () => {
  try {
    process.exit(0)
  } catch {
    // ignore
  }
})
