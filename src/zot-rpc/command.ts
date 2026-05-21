import { platform } from 'node:os'

export function defaultZotCommand(): string {
  return platform() === 'win32' ? 'zot.exe' : 'zot'
}

export function getZotCommand(override?: string): string {
  return override ?? defaultZotCommand()
}

export function shouldUseShellForZotCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}
