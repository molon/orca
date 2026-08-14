import * as SecureStore from 'expo-secure-store'

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
  // Why its own service: the extension reads through an app-group keychain
  // entry, and keeping it out of the pairing service avoids widening what the
  // extension process can reach to just this key.
  keychainService: 'orca.push.v1'
}

const PUSH_KEY_PREFIX = 'orca:push-key:'

function storageKey(hostId: string): string {
  return `${PUSH_KEY_PREFIX}${encodeURIComponent(hostId)}`
}

/** Stores the per-device push key for one paired host. */
export async function savePushKey(hostId: string, pushKeyB64: string): Promise<void> {
  await SecureStore.setItemAsync(storageKey(hostId), pushKeyB64, PUSH_KEY_OPTIONS)
}

/** Returns null when no key is stored, or when the keychain read fails — the
 *  caller falls back to local notifications rather than surfacing an error for
 *  a feature the user may never have configured. */
export async function loadPushKey(hostId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(storageKey(hostId), PUSH_KEY_OPTIONS)
  } catch {
    return null
  }
}

/** Called when a host is unpaired. Failure is ignored: the key is useless
 *  without the pairing, and a throw here would block the unpair itself. */
export async function deletePushKey(hostId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(storageKey(hostId), PUSH_KEY_OPTIONS)
  } catch {
    // Intentionally ignored — see above.
  }
}
