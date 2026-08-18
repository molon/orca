import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'
import type { PushChannel } from './push-channel'

const accessGroup = Constants.expoConfig?.extra?.orcaPushKeychainAccessGroup

/**
 * A channel's key lives beside the per-pairing push keys and for the same
 * reason: the extension decrypts in its own process and can only reach what the
 * shared access group lets it.
 */
const CHANNEL_KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  keychainService: 'orca.push.v1',
  ...(typeof accessGroup === 'string' ? { accessGroup } : {})
}

// Colons are not legal here — SecureStore takes only alphanumerics, '.', '-'
// and '_', and throws on anything else.
const CHANNEL_PREFIX = 'orca.push-channel.'

/**
 * What the extension needs to open one channel's pushes and route a tap.
 *
 * hostId is not in the pasted string: the machine that printed it cannot know
 * the id this phone gave it. It comes from which host's page the string was
 * pasted into, which is also what makes tapping land in the right place.
 */
export type StoredPushChannel = {
  readonly provider: string
  readonly pushKeyB64: string
  readonly hostId: string
  readonly authToken: string
}

function storageKey(channelId: string): string {
  return `${CHANNEL_PREFIX}${channelId}`
}

export async function savePushChannel(channel: PushChannel, hostId: string): Promise<void> {
  const stored: StoredPushChannel = {
    provider: channel.provider,
    pushKeyB64: channel.keyB64,
    hostId,
    authToken: channel.authToken
  }
  await SecureStore.setItemAsync(
    storageKey(channel.channelId),
    JSON.stringify(stored),
    CHANNEL_KEY_OPTIONS
  )
}

/** Null when nothing is stored or the entry is unreadable — the caller falls
 *  back to the direct connection rather than surfacing a fault for a feature
 *  the user may never have configured. */
export async function loadPushChannel(channelId: string): Promise<StoredPushChannel | null> {
  try {
    const raw = await SecureStore.getItemAsync(storageKey(channelId), CHANNEL_KEY_OPTIONS)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as StoredPushChannel).pushKeyB64 !== 'string' ||
      typeof (parsed as StoredPushChannel).hostId !== 'string' ||
      typeof (parsed as StoredPushChannel).provider !== 'string'
    ) {
      return null
    }
    return parsed as StoredPushChannel
  } catch {
    return null
  }
}

export async function deletePushChannel(channelId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(storageKey(channelId), CHANNEL_KEY_OPTIONS)
  } catch {
    // The key is useless once the host is gone, and a throw here would block
    // whatever removal is in progress.
  }
}
