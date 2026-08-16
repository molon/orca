import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as SecureStore from 'expo-secure-store'
import { deletePushIdentity, loadPushIdentity, savePushIdentity } from './push-key-store'

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined)
}))

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { orcaPushKeychainAccessGroup: 'TEAM1.com.example.app.push' } } }
}))

const setItemAsync = vi.mocked(SecureStore.setItemAsync)
const getItemAsync = vi.mocked(SecureStore.getItemAsync)
const deleteItemAsync = vi.mocked(SecureStore.deleteItemAsync)

describe('push key store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why this is the load-bearing test: a push most often arrives on a locked
  // phone. A WHEN_UNLOCKED key is unreadable to the Notification Service
  // Extension at that moment, so the user would see placeholder text for
  // exactly the notifications push exists to deliver.
  it('stores the key so the extension can read it on a locked phone', async () => {
    await savePushIdentity('dev-1', { pushKeyB64: 'key-b64', hostId: 'host-1' })
    const options = setItemAsync.mock.calls[0]![2]
    expect(options?.keychainAccessible).toBe(SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY)
    expect(options?.keychainAccessible).not.toBe(SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY)
  })

  // THIS_DEVICE_ONLY keeps the key off iCloud Keychain, so restoring a backup
  // onto another phone cannot decrypt pushes sealed for the original device.
  it('keeps the key off backups and iCloud Keychain', async () => {
    await savePushIdentity('dev-1', { pushKeyB64: 'key-b64', hostId: 'host-1' })
    expect(String(setItemAsync.mock.calls[0]![2]?.keychainAccessible)).toContain('this-device-only')
  })

  // The entitlement alone shares nothing: a write without the group lands in
  // the app's default group, where the extension cannot see it, and every push
  // silently renders as placeholder text.
  it('writes into the group the extension reads', async () => {
    await savePushIdentity('dev-1', { pushKeyB64: 'key-b64', hostId: 'host-1' })
    getItemAsync.mockResolvedValueOnce(null)
    await loadPushIdentity('dev-1')
    expect(setItemAsync.mock.calls[0]![2]?.accessGroup).toBe('TEAM1.com.example.app.push')
    expect(getItemAsync.mock.calls[0]![1]?.accessGroup).toBe('TEAM1.com.example.app.push')
  })

  it('reads back with the same options it wrote with', async () => {
    getItemAsync.mockResolvedValueOnce(JSON.stringify({ pushKeyB64: 'key-b64', hostId: 'host-1' }))
    await expect(loadPushIdentity('dev-1')).resolves.toEqual({
      pushKeyB64: 'key-b64',
      hostId: 'host-1'
    })
    expect(getItemAsync.mock.calls[0]![0]).toBe(
      setItemAsync.mock.calls[0]?.[0] ?? 'orca:push-key:dev-1'
    )
    expect(getItemAsync.mock.calls[0]![1]?.keychainAccessible).toBe(
      SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
    )
  })

  it('scopes entries per pairing, so unpairing one desktop cannot read another key', async () => {
    await savePushIdentity('dev-1', { pushKeyB64: 'a', hostId: 'host-1' })
    await savePushIdentity('dev-2', { pushKeyB64: 'b', hostId: 'host-2' })
    expect(setItemAsync.mock.calls[0]![0]).not.toBe(setItemAsync.mock.calls[1]![0])
  })

  it('encodes the device id so an exotic id cannot collide or escape its key', async () => {
    await savePushIdentity('dev/../other', { pushKeyB64: 'a', hostId: 'h' })
    expect(setItemAsync.mock.calls[0]![0]).not.toContain('/')
  })

  it('returns null when no key is stored', async () => {
    getItemAsync.mockResolvedValueOnce(null)
    await expect(loadPushIdentity('dev-1')).resolves.toBeNull()
  })

  // Why null rather than a throw: the caller falls back to local notifications.
  // Surfacing a keychain fault would break a feature the user may never have
  // configured.
  it('returns null instead of throwing when the keychain read fails', async () => {
    getItemAsync.mockRejectedValueOnce(new Error('keychain locked'))
    await expect(loadPushIdentity('dev-1')).resolves.toBeNull()
  })

  // A truncated or hand-edited entry must not be trusted into the extension.
  it('returns null when the stored entry is malformed', async () => {
    getItemAsync.mockResolvedValueOnce('not json')
    await expect(loadPushIdentity('dev-1')).resolves.toBeNull()
    getItemAsync.mockResolvedValueOnce(JSON.stringify({ pushKeyB64: 'k' }))
    await expect(loadPushIdentity('dev-1')).resolves.toBeNull()
  })

  it('deletes the key when a host is unpaired', async () => {
    await deletePushIdentity('dev-1')
    expect(deleteItemAsync).toHaveBeenCalledTimes(1)
  })

  // The key is useless without the pairing, and a throw here would block the
  // unpair itself.
  it('does not throw when deleting a key that cannot be removed', async () => {
    deleteItemAsync.mockRejectedValueOnce(new Error('keychain locked'))
    await expect(deletePushIdentity('dev-1')).resolves.toBeUndefined()
  })
})
