// The last hop on the desktop side: it turns a sealed envelope into one HTTP
// call to the push relay. The relay is a dumb forwarder — it holds no keys and
// cannot read what it carries — so the only secret here is the token that
// stops strangers from using someone else's relay.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MobilePushSendRequest, MobilePushSendResult } from './mobile-push-fanout'

export const MOBILE_PUSH_RELAY_FILENAME = 'orca-push-relay.json'

export type MobilePushRelayConfig = {
  readonly url: string
  readonly authToken: string
}

// A URL and a token; anything larger is a corrupt file rather than a big one.
const MAX_CONFIG_FILE_BYTES = 8 * 1024
// Long enough for a slow relay, short enough that a hung one cannot pile up
// behind a burst of notifications.
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Reads the operator-written relay config, or null when push is not set up.
 *
 * Why null rather than an error: no relay is the normal state. Push is an
 * enhancement over a local notification path that already works, so a missing
 * or malformed file must leave the desktop running exactly as before.
 */
export function loadMobilePushRelayConfig(userDataPath: string): MobilePushRelayConfig | null {
  const path = join(userDataPath, MOBILE_PUSH_RELAY_FILENAME)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.length > MAX_CONFIG_FILE_BYTES) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const { url, authToken } = parsed as { url?: unknown; authToken?: unknown }
    if (typeof url !== 'string' || typeof authToken !== 'string') {
      return null
    }
    const trimmed = url.replace(/\/+$/, '')
    if (!/^https?:\/\//.test(trimmed) || authToken.length === 0) {
      return null
    }
    return { url: trimmed, authToken }
  } catch {
    return null
  }
}

/**
 * Builds the sender the runtime fans out through.
 *
 * Why 410 is the only outcome that unregisters: it is APNs saying the token is
 * permanently gone. Every other failure — a relay restart, a flaky link, a
 * misconfigured environment — is transient, and treating it as permanent would
 * silently unsubscribe phones that are working fine.
 */
export function createMobilePushRelaySender(
  config: MobilePushRelayConfig,
  fetchImpl: typeof fetch = fetch
): (request: MobilePushSendRequest) => Promise<MobilePushSendResult> {
  return async (request) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${config.url}/push`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.authToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          deviceToken: request.deviceToken,
          deviceId: request.deviceId,
          envelope: request.envelope,
          ...(request.collapseId ? { collapseId: request.collapseId } : {})
        }),
        signal: controller.signal
      })
      if (response.status === 202) {
        return { kind: 'sent' }
      }
      if (response.status === 410) {
        return { kind: 'unregistered' }
      }
      return { kind: 'failed', reason: `relay responded ${response.status}` }
    } catch (error) {
      // Never logged with the envelope: it is the content this whole path
      // exists to keep unreadable, including from our own logs.
      return {
        kind: 'failed',
        reason: error instanceof Error ? error.message : 'relay unreachable'
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
