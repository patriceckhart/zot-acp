import { RequestError } from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'

/**
 * Best-effort detection of missing-credential / not-configured errors from zot
 * or its provider clients. zot surfaces these as plain error messages in the
 * RPC `response.error` string or in `event.type === "error"` payloads.
 */
export function maybeAuthRequiredError(err: unknown): RequestError | null {
  const msg = String((err as any)?.message ?? err ?? '')
  const s = msg.toLowerCase()

  const patterns = [
    'api key',
    'apikey',
    'missing key',
    'no key',
    'not configured',
    'no credentials',
    'unauthorized',
    'authentication',
    'permission denied',
    'forbidden',
    '401',
    '403',
    'oauth',
    'auth.json'
  ]

  const hit = patterns.some(p => s.includes(p))
  if (!hit) return null

  return RequestError.authRequired(
    {
      authMethods: getAuthMethods()
    },
    'Configure an API key or log in with an OAuth provider.'
  )
}
