import type { AuthMethod } from '@agentclientprotocol/sdk'

export const ZOT_SETUP_METHOD_ID = 'zot_terminal_login'

/**
 * Zed (and some other clients) currently support "Terminal Auth" via an extension field
 * in AuthMethod._meta, rather than the RFD "type/args/env" shape.
 *
 * We include BOTH for maximum compatibility:
 *  - `_meta["terminal-auth"]`: used by Zed to render the "Authenticate" banner + button.
 *  - `type/args/env`: registry-required shape.
 */
export function getAuthMethods(opts?: { supportsTerminalAuthMeta?: boolean }): AuthMethod[] {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true

  const method: any = {
    id: ZOT_SETUP_METHOD_ID,
    name: 'Launch zot in the terminal',
    description: 'Start zot in an interactive terminal to configure API keys or login',

    type: 'terminal',
    args: ['--terminal-login'],
    env: {}
  }

  if (supportsTerminalAuthMeta) {
    const launch = terminalAuthLaunchSpec()

    method._meta = {
      ...(method._meta ?? {}),
      'terminal-auth': {
        ...launch,
        label: 'Launch zot'
      }
    }
  }

  return [method as AuthMethod]
}

function terminalAuthLaunchSpec(): { command: string; args: string[] } {
  const argv0 = process.argv[0] || 'node'
  const argv1 = process.argv[1]
  if (argv1 && argv0) {
    const isNode = argv0.includes('node')
    const isJs = argv1.endsWith('.js')
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, '--terminal-login'] }
    }
  }

  return { command: 'zot-acp', args: ['--terminal-login'] }
}
