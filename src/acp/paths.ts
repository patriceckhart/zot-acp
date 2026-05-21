import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/**
 * $ZOT_HOME resolution mirrors zot's documented behaviour:
 *   - macOS:   ~/Library/Application Support/zot
 *   - Linux:   $XDG_STATE_HOME/zot or ~/.local/state/zot
 *   - Windows: %LOCALAPPDATA%\zot
 *
 * Honours the $ZOT_HOME environment variable if set.
 */
export function getZotHome(): string {
  if (process.env.ZOT_HOME && process.env.ZOT_HOME.trim()) return process.env.ZOT_HOME

  const home = homedir()
  const plat = platform()

  if (plat === 'darwin') {
    return join(home, 'Library', 'Application Support', 'zot')
  }

  if (plat === 'win32') {
    const localAppData = process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.trim()
    if (localAppData) return join(localAppData, 'zot')
    return join(home, 'AppData', 'Local', 'zot')
  }

  // Linux / other unix: XDG_STATE_HOME or ~/.local/state.
  const xdg = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim()
  return xdg ? join(xdg, 'zot') : join(home, '.local', 'state', 'zot')
}

/**
 * Storage owned by the ACP adapter.
 *
 * Intentionally separate from zot's own $ZOT_HOME directories.
 */
export function getZotAcpDir(): string {
  return join(getZotHome(), 'zot-acp')
}

export function getZotAcpSessionMapPath(): string {
  return join(getZotAcpDir(), 'session-map.json')
}

/**
 * Best-effort lookup for zot's sessions directory. Sessions are disabled by
 * default in `zot rpc`, but the adapter mirrors transcripts here so the
 * client can list / reload them.
 */
export function getZotAcpSessionsDir(): string {
  return join(getZotAcpDir(), 'sessions')
}
