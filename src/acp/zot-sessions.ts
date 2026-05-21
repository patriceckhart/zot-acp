import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SessionStore } from './session-store.js'
import { getZotAcpSessionsDir } from './paths.js'

export type ZotSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

/**
 * Build a session file path for a freshly created ACP session.
 *
 * zot RPC sessions are not persisted by zot itself (sessions are disabled by
 * default in RPC mode). The adapter writes its own JSONL transcript per session
 * so `session/load` can replay history.
 */
export function buildSessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = getZotAcpSessionsDir()
  return join(dir, `${safe}.jsonl`)
}

export function ensureSessionFile(sessionFile: string, header: { sessionId: string; cwd: string }): void {
  mkdirSync(dirname(sessionFile), { recursive: true })
  if (existsSync(sessionFile)) return

  const line = JSON.stringify({ type: 'session', id: header.sessionId, cwd: header.cwd, time: new Date().toISOString() }) + '\n'
  writeFileSync(sessionFile, line, 'utf-8')
}

export function appendSessionLine(sessionFile: string, entry: Record<string, unknown>): void {
  try {
    appendFileSync(sessionFile, JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // best-effort
  }
}

export function listZotSessions(): ZotSessionListItem[] {
  const store = new SessionStore()
  const items: ZotSessionListItem[] = []

  for (const s of store.list()) {
    let updatedAt: string | null = s.updatedAt ?? null
    if (!updatedAt) {
      try {
        updatedAt = statSync(s.sessionFile).mtime.toISOString()
      } catch {
        updatedAt = null
      }
    }

    let title: string | null = s.title ?? null
    if (!title) title = pickFallbackTitleFromHead(s.sessionFile)

    items.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title,
      updatedAt,
      sessionFile: s.sessionFile
    })
  }

  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  return items
}

export function findZotSessionFile(sessionId: string): string | null {
  const store = new SessionStore()
  return store.get(sessionId)?.sessionFile ?? null
}

function pickFallbackTitleFromHead(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split(/\r?\n/)
    let scanned = 0
    for (const line0 of lines) {
      const line = line0.trim()
      if (!line) continue
      scanned += 1
      try {
        const obj = JSON.parse(line) as any
        if (obj?.type === 'message' && obj?.message?.role === 'user') {
          const content = obj?.message?.content
          if (typeof content === 'string') return content.slice(0, 80)
          if (Array.isArray(content)) {
            const t = content.find((c: any) => c?.type === 'text' && typeof c?.text === 'string')
            if (t?.text) return String(t.text).slice(0, 80)
          }
        }
      } catch {
        // ignore
      }
      if (scanned > 2000) break
    }
  } catch {
    // ignore
  }
  return null
}
