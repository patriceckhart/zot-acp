import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getZotAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  /** Adapter-local display name (zot RPC has no name field). */
  title?: string | null
  updatedAt: string
}

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      return { version: 1, sessions: {} }
    }
    return parsed
  } catch {
    return { version: 1, sessions: {} }
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path)
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export class SessionStore {
  private readonly path: string

  constructor(path = getZotAcpSessionMapPath()) {
    this.path = path
  }

  get(sessionId: string): StoredSession | null {
    const db = loadFile(this.path)
    return db.sessions[sessionId] ?? null
  }

  list(): StoredSession[] {
    const db = loadFile(this.path)
    return Object.values(db.sessions)
  }

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string; title?: string | null }): void {
    const db = loadFile(this.path)
    const prev = db.sessions[entry.sessionId]
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      title: entry.title ?? prev?.title ?? null,
      updatedAt: new Date().toISOString()
    }
    saveFile(this.path, db)
  }

  setTitle(sessionId: string, title: string): void {
    const db = loadFile(this.path)
    const prev = db.sessions[sessionId]
    if (!prev) return
    db.sessions[sessionId] = { ...prev, title, updatedAt: new Date().toISOString() }
    saveFile(this.path, db)
  }

  delete(sessionId: string): void {
    const db = loadFile(this.path)
    if (!db.sessions[sessionId]) return
    delete db.sessions[sessionId]
    saveFile(this.path, db)
  }
}
