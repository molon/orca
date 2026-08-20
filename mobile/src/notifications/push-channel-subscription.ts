import { getDevicePushTokenAsync } from 'expo-notifications'
import type { PushChannel } from './push-channel'

/**
 * Tells a channel's server which device to deliver to.
 *
 * Why the phone does this rather than the publisher: a hook holds a key and
 * nothing else — it has no way to learn an APNs token — so the only side that
 * knows the token has to hand it over.
 */
export type SubscribeResult =
  | { readonly kind: 'subscribed' }
  // No token: a simulator without push, a build without the entitlement, or a
  // user who declined notifications. None of these are errors, and local
  // delivery keeps working.
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly reason: string }

const REQUEST_TIMEOUT_MS = 15_000

async function readDeviceToken(): Promise<string | null> {
  try {
    const token = await getDevicePushTokenAsync()
    return typeof token.data === 'string' && token.data.length > 0 ? token.data : null
  } catch {
    return null
  }
}

export async function subscribeToPushChannel(
  channel: PushChannel,
  fetchImpl: typeof fetch = fetch
): Promise<SubscribeResult> {
  const deviceToken = await readDeviceToken()
  if (!deviceToken) {
    return { kind: 'unsupported' }
  }
  return postSubscription(channel, deviceToken, 'subscribe', fetchImpl)
}

/** Called when the user clears the channel, so the server stops sending to a
 *  device that no longer wants it — APNs would never report a still-valid token
 *  as gone, so it has to be told. */
export async function unsubscribeFromPushChannel(
  channel: PushChannel,
  fetchImpl: typeof fetch = fetch
): Promise<SubscribeResult> {
  const deviceToken = await readDeviceToken()
  if (!deviceToken) {
    return { kind: 'unsupported' }
  }
  return postSubscription(channel, deviceToken, 'unsubscribe', fetchImpl)
}

async function postSubscription(
  channel: PushChannel,
  deviceToken: string,
  path: 'subscribe' | 'unsubscribe',
  fetchImpl: typeof fetch
): Promise<SubscribeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${channel.provider}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(channel.authToken ? { authorization: `Bearer ${channel.authToken}` } : {})
      },
      body: JSON.stringify({ channelId: channel.channelId, deviceToken }),
      signal: controller.signal
    })
    if (response.status === 204) {
      return { kind: 'subscribed' }
    }
    return { kind: 'failed', reason: `server responded ${response.status}` }
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : 'server unreachable'
    }
  } finally {
    clearTimeout(timer)
  }
}
