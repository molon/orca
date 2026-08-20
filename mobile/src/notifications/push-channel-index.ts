import AsyncStorage from '@react-native-async-storage/async-storage'

/*
Remembers which channel a host was paired with.

Why this is not in the keychain beside the key: the extension looks a channel up
by the id the push names, so it never needs to go the other way. Only the
settings screen does — to show what is configured and to know what to remove —
and that is not secret.
*/
const HOST_CHANNEL_PREFIX = 'orca:push-channel-host:'

export async function loadChannelIdForHost(hostId: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(`${HOST_CHANNEL_PREFIX}${hostId}`)
  } catch {
    return null
  }
}

export async function saveChannelIdForHost(
  hostId: string,
  channelId: string | null
): Promise<void> {
  const key = `${HOST_CHANNEL_PREFIX}${hostId}`
  try {
    if (channelId) {
      await AsyncStorage.setItem(key, channelId)
    } else {
      await AsyncStorage.removeItem(key)
    }
  } catch {
    // The keychain entry is what matters; losing this only means the screen
    // shows nothing configured while notifications keep arriving.
  }
}

/** Every channel this phone follows, for re-subscribing on launch — a token
 *  rotates without warning, and re-subscribing is what makes that a non-event. */
export async function listPairedChannels(): Promise<{ hostId: string; channelId: string }[]> {
  try {
    const keys = await AsyncStorage.getAllKeys()
    const paired = keys.filter((key) => key.startsWith(HOST_CHANNEL_PREFIX))
    const entries = await AsyncStorage.multiGet(paired)
    return entries.flatMap(([key, value]) =>
      value ? [{ hostId: key.slice(HOST_CHANNEL_PREFIX.length), channelId: value }] : []
    )
  } catch {
    return []
  }
}
