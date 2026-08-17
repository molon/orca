// The last hop on the desktop side: it turns a sealed envelope into one HTTP
// call to the push provider — Apple's own term for the server that talks to
// APNs on an app's behalf, kept distinct from Orca's own mobile relay. It is a
// dumb forwarder: it holds no keys and cannot read what it carries, so the only
// secret here is the token that stops strangers from using someone else's.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import type { MobilePushSendRequest, MobilePushSendResult } from './mobile-push-fanout'

export const MOBILE_PUSH_PROVIDER_FILENAME = 'orca-push-provider.json'

export type MobilePushProviderConfig = {
  readonly url: string
  readonly authToken: string
}

// A URL and a token; anything larger is a corrupt file rather than a big one.
const MAX_CONFIG_FILE_BYTES = 8 * 1024
// Long enough for a slow provider, short enough that a hung one cannot pile up
// behind a burst of notifications.
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Reads the operator-written provider config, or null when push is not set up.
 *
 * Why null rather than an error: no provider is the normal state. Push is an
 * enhancement over a local notification path that already works, so a missing
 * or malformed file must leave the desktop running exactly as before.
 */
export function loadMobilePushProviderConfig(
  userDataPath: string
): MobilePushProviderConfig | null {
  const path = join(userDataPath, MOBILE_PUSH_PROVIDER_FILENAME)
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
 * permanently gone. Every other failure — a provider restart, a flaky link, a
 * misconfigured environment — is transient, and treating it as permanent would
 * silently unsubscribe phones that are working fine.
 */
export function createMobilePushProviderSender(
  config: MobilePushProviderConfig,
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
      return { kind: 'failed', reason: `provider responded ${response.status}` }
    } catch (error) {
      // Never logged with the envelope: it is the content this whole path
      // exists to keep unreadable, including from our own logs.
      return {
        kind: 'failed',
        reason: error instanceof Error ? error.message : 'provider unreachable'
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Writes the config the settings pane edited, or removes it when the user
 * clears the fields.
 *
 * Why secure-file: the token is what stops a stranger from pushing to this
 * user's devices through their provider. It gets the same handling as the push
 * keys stored beside it.
 */
export function saveMobilePushProviderConfig(
  userDataPath: string,
  config: MobilePushProviderConfig | null
): void {
  const path = join(userDataPath, MOBILE_PUSH_PROVIDER_FILENAME)
  if (!config) {
    rmSync(path, { force: true })
    return
  }
  writeDurableSecureJsonFile(path, {
    url: config.url.replace(/\/+$/, ''),
    authToken: config.authToken
  })
}
