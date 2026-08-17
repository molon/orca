import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'

// Injected by the notification-service-extension plugin, which derives it from
// the Apple team id. Absent when the build has no team: the extension then has
// no group either, so both sides agree there is nothing to share and push
// falls back to placeholder text.
const accessGroup = Constants.expoConfig?.extra?.orcaPushKeychainAccessGroup
// Why AFTER_FIRST_UNLOCK rather than the WHEN_UNLOCKED level the pairing
// credentials use: a push most often arrives while the phone is locked in a
// pocket. The Notification Service Extension wakes to decrypt it, and a
// WHEN_UNLOCKED item is unreadable at that moment — the user would get
// placeholder text for exactly the notifications push exists to deliver.
//
// This is a deliberately separate entry, NOT a relaxation of the pairing
// credentials: widening those would weaken every other secret to buy this one
// capability. THIS_DEVICE_ONLY still keeps the key off iCloud Keychain and
// backup restores, so a restored backup cannot decrypt another device's pushes.
const PUSH_KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  // Why its own service: the extension reads through a shared keychain access
  // group, and keeping this out of the pairing service avoids widening what
  // the extension process can reach to just these entries.
  keychainService: 'orca.push.v1',
  // Without this the key lands in the app's default group, which the extension
  // cannot read — the entitlement alone shares nothing.
  ...(typeof accessGroup === 'string' ? { accessGroup } : {})
}

// Colons are not legal here: expo-secure-store accepts only alphanumerics,
// '.', '-' and '_', and throws on anything else. The throw is what makes this
// worth spelling out — it propagates out of the save, gets swallowed by the
// connect path, and leaves the extension with no key and no clue why.
const PUSH_KEY_PREFIX = 'orca.push-key.'

/**
 * What the extension needs to turn one push into a routed notification.
 *
 * Why hostId lives here rather than inside the envelope: hostId is assigned by
 * the phone's own host list, so the desktop cannot know it and cannot seal it
 * in. Storing it beside the key lets the extension recover it after decrypting,
 * which keeps tap routing identical to the local path.
 */
export type StoredPushIdentity = {
  readonly pushKeyB64: string
  readonly hostId: string
}

/**
 * Keyed by deviceId, which the phone mints per pairing rather than per phone.
 * A phone paired with two desktops holds two entries, and a push names the one
 * it belongs to — so the desktop never has to know a phone-side identifier.
 */
function storageKey(deviceId: string): string {
  // Appended verbatim: deviceId is a UUID this app mints, so it is already
  // within the legal set. Percent-encoding it would introduce '%', which is
  // not.
  return `${PUSH_KEY_PREFIX}${deviceId}`
}

export async function savePushIdentity(
  deviceId: string,
  identity: StoredPushIdentity
): Promise<void> {
  await SecureStore.setItemAsync(storageKey(deviceId), JSON.stringify(identity), PUSH_KEY_OPTIONS)
}

/** Returns null when nothing is stored, the entry is unreadable, or it is
 *  malformed — the caller falls back to local notifications rather than
 *  surfacing an error for a feature the user may never have configured. */
export async function loadPushIdentity(deviceId: string): Promise<StoredPushIdentity | null> {
  try {
    const raw = await SecureStore.getItemAsync(storageKey(deviceId), PUSH_KEY_OPTIONS)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as StoredPushIdentity).pushKeyB64 !== 'string' ||
      typeof (parsed as StoredPushIdentity).hostId !== 'string'
    ) {
      return null
    }
    return parsed as StoredPushIdentity
  } catch {
    return null
  }
}

/** Called when a host is unpaired or the user turns push off for it. Failure is
 *  ignored: the key is useless without the pairing, and a throw here would
 *  block the unpair itself. */
export async function deletePushIdentity(deviceId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(storageKey(deviceId), PUSH_KEY_OPTIONS)
  } catch {
    // Intentionally ignored — see above.
  }
}
