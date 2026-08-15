import * as Crypto from 'expo-crypto'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { savePushIdentity, deletePushIdentity } from './push-key-store'

// Why per pairing rather than per phone: the id names one (phone, desktop)
// relationship. A phone paired with two desktops holds two keys, and a push
// names the one it belongs to — so the desktop never has to know, or invent, a
// phone-side identifier.
const DEVICE_ID_PREFIX = 'orca:push-device-id:'

export type PushRegistrationClient = {
  sendRequest: (
    method: string,
    params: unknown
  ) => Promise<{ ok: boolean; result?: unknown; error?: { code?: string } }>
}

export type PushDeviceTokenReader = () => Promise<string | null>

/** Stable across launches: re-registering with a known id keeps the existing
 *  key, so a fresh id on every launch would churn keys and orphan entries. */
export async function getOrCreatePushDeviceId(hostId: string): Promise<string> {
  const storageKey = `${DEVICE_ID_PREFIX}${encodeURIComponent(hostId)}`
  const existing = await AsyncStorage.getItem(storageKey)
  if (existing) {
    return existing
  }
  const deviceId = Crypto.randomUUID()
  await AsyncStorage.setItem(storageKey, deviceId)
  return deviceId
}

export type RegisterPushDeviceResult =
  | { readonly kind: 'registered'; readonly deviceId: string }
  // The host predates remote push, or push is not configured on it. The caller
  // keeps using the local notification path, which is why this is not an error.
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' }

/**
 * Registers this phone for remote push with one desktop.
 *
 * Safe to call on every connect: a known device keeps its key, so the caller
 * does not have to track whether it already registered.
 */
export async function registerPushDevice(args: {
  readonly client: PushRegistrationClient
  readonly hostId: string
  readonly readDeviceToken: PushDeviceTokenReader
  readonly label?: string
}): Promise<RegisterPushDeviceResult> {
  let deviceToken: string | null
  try {
    deviceToken = await args.readDeviceToken()
  } catch {
    // No APNs token — no entitlement, a simulator without push support, or the
    // user denied notifications. Local delivery still works.
    return { kind: 'unsupported' }
  }
  if (!deviceToken) {
    return { kind: 'unsupported' }
  }

  const deviceId = await getOrCreatePushDeviceId(args.hostId)
  let response: Awaited<ReturnType<PushRegistrationClient['sendRequest']>>
  try {
    response = await args.client.sendRequest('notifications.registerPushDevice', {
      deviceId,
      deviceToken,
      ...(args.label ? { label: args.label } : {})
    })
  } catch {
    return { kind: 'failed' }
  }

  if (!response.ok) {
    // Why method_not_found is not a failure: every host that predates remote
    // push answers this way, and treating it as an error would surface a
    // warning on a perfectly healthy pairing.
    return response.error?.code === 'method_not_found'
      ? { kind: 'unsupported' }
      : { kind: 'failed' }
  }

  const pushKeyB64 = (response.result as { pushKeyB64?: unknown } | undefined)?.pushKeyB64
  if (typeof pushKeyB64 !== 'string' || pushKeyB64.length === 0) {
    return { kind: 'failed' }
  }

  // hostId is stored beside the key because the desktop cannot know it: it is
  // assigned by this phone's own host list. The extension reads it back after
  // decrypting so a tap routes exactly as a local notification would.
  await savePushIdentity(deviceId, { pushKeyB64, hostId: args.hostId })
  return { kind: 'registered', deviceId }
}

/** Stops remote delivery for this pairing and drops the local key. The desktop
 *  is told first so it stops sealing; the key is dropped either way, since
 *  keeping an unusable secret has no upside. */
export async function unregisterPushDevice(args: {
  readonly client: PushRegistrationClient
  readonly hostId: string
}): Promise<void> {
  const deviceId = await getOrCreatePushDeviceId(args.hostId)
  try {
    await args.client.sendRequest('notifications.unregisterPushDevice', { deviceId })
  } catch {
    // Ignored: the local key is dropped regardless, and the desktop prunes the
    // registration once APNs reports the token gone.
  }
  await deletePushIdentity(deviceId)
}
