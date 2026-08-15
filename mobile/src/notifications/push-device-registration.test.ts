import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { savePushIdentity, deletePushIdentity } from './push-key-store'
import {
  getOrCreatePushDeviceId,
  registerPushDevice,
  unregisterPushDevice
} from './push-device-registration'

vi.mock('expo-crypto', () => {
  let counter = 0
  return { randomUUID: () => `uuid-${++counter}` }
})

vi.mock('./push-key-store', () => ({
  savePushIdentity: vi.fn(async () => undefined),
  deletePushIdentity: vi.fn(async () => undefined)
}))

const store = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    })
  }
}))

const saveIdentity = vi.mocked(savePushIdentity)
const deleteIdentity = vi.mocked(deletePushIdentity)

function client(response: unknown, ok = true) {
  return {
    sendRequest: vi.fn(async () => (ok ? { ok: true, result: response } : (response as never)))
  }
}

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => store.get(key) ?? null)
})

describe('push device registration', () => {
  // Why stable: re-registering with a known id keeps the existing key, so a
  // fresh id per launch would churn keys and orphan keychain entries.
  it('reuses the device id across launches', async () => {
    const first = await getOrCreatePushDeviceId('host-1')
    const second = await getOrCreatePushDeviceId('host-1')
    expect(second).toBe(first)
  })

  it('mints a distinct id per pairing, so two desktops never share a key', async () => {
    expect(await getOrCreatePushDeviceId('host-1')).not.toBe(
      await getOrCreatePushDeviceId('host-2')
    )
  })

  it('stores the key with the host id the extension needs for routing', async () => {
    const rpc = client({ pushKeyB64: 'key-b64' })
    const result = await registerPushDevice({
      client: rpc,
      hostId: 'host-1',
      readDeviceToken: async () => 'apns-token'
    })

    expect(result.kind).toBe('registered')
    expect(saveIdentity).toHaveBeenCalledWith(expect.any(String), {
      pushKeyB64: 'key-b64',
      hostId: 'host-1'
    })
    expect(rpc.sendRequest).toHaveBeenCalledWith(
      'notifications.registerPushDevice',
      expect.objectContaining({ deviceToken: 'apns-token' })
    )
  })

  // Why not an error: every host predating remote push answers this way, and
  // treating it as a failure would warn on a perfectly healthy pairing.
  it('treats an unknown method as unsupported, not failed', async () => {
    const rpc = {
      sendRequest: vi.fn(async () => ({ ok: false, error: { code: 'method_not_found' } }))
    }
    const result = await registerPushDevice({
      client: rpc,
      hostId: 'host-1',
      readDeviceToken: async () => 'apns-token'
    })
    expect(result.kind).toBe('unsupported')
    expect(saveIdentity).not.toHaveBeenCalled()
  })

  it('reports other RPC errors as failed', async () => {
    const rpc = { sendRequest: vi.fn(async () => ({ ok: false, error: { code: 'internal' } })) }
    expect(
      (await registerPushDevice({ client: rpc, hostId: 'h', readDeviceToken: async () => 't' }))
        .kind
    ).toBe('failed')
  })

  // No entitlement, a simulator without push, or a user who denied
  // notifications. Local delivery still works, so this is not an error.
  it('reports a missing device token as unsupported', async () => {
    const rpc = client({ pushKeyB64: 'k' })
    expect(
      (await registerPushDevice({ client: rpc, hostId: 'h', readDeviceToken: async () => null }))
        .kind
    ).toBe('unsupported')
    expect(rpc.sendRequest).not.toHaveBeenCalled()
  })

  it('reports a throwing token read as unsupported rather than crashing connect', async () => {
    const rpc = client({ pushKeyB64: 'k' })
    const result = await registerPushDevice({
      client: rpc,
      hostId: 'h',
      readDeviceToken: async () => {
        throw new Error('no entitlement')
      }
    })
    expect(result.kind).toBe('unsupported')
  })

  // A response without a key would leave the extension unable to decrypt while
  // the desktop believes the phone is registered, so it must not be stored.
  it('never stores a malformed registration response', async () => {
    for (const response of [{}, { pushKeyB64: '' }, { pushKeyB64: 42 }]) {
      const result = await registerPushDevice({
        client: client(response),
        hostId: 'h',
        readDeviceToken: async () => 't'
      })
      expect(result.kind).toBe('failed')
    }
    expect(saveIdentity).not.toHaveBeenCalled()
  })

  it('drops the local key when unregistering', async () => {
    const rpc = client({ unregistered: true })
    await unregisterPushDevice({ client: rpc, hostId: 'host-1' })
    expect(rpc.sendRequest).toHaveBeenCalledWith(
      'notifications.unregisterPushDevice',
      expect.objectContaining({ deviceId: expect.any(String) })
    )
    expect(deleteIdentity).toHaveBeenCalled()
  })

  // Keeping a key the desktop no longer seals for has no upside.
  it('drops the local key even when the desktop cannot be told', async () => {
    const rpc = {
      sendRequest: vi.fn(async () => {
        throw new Error('offline')
      })
    }
    await unregisterPushDevice({ client: rpc, hostId: 'host-1' })
    expect(deleteIdentity).toHaveBeenCalled()
  })
})
