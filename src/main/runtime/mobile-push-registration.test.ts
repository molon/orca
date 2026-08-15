import { describe, expect, it } from 'vitest'
import { createMobilePushRegistryState, listMobilePushRegistrations } from './mobile-push-registry'
import { registerMobilePushDevice, unregisterMobilePushDevice } from './mobile-push-registration'
import { mobilePushKeyFromBase64 } from './mobile-push-envelope'

describe('mobile push registration', () => {
  it('mints a usable key for a new device', () => {
    const { state, pushKeyB64 } = registerMobilePushDevice(createMobilePushRegistryState(), {
      deviceId: 'a',
      deviceToken: 'token-a',
      nowMs: 100
    })
    expect(() => mobilePushKeyFromBase64(pushKeyB64)).not.toThrow()
    expect(listMobilePushRegistrations(state)).toHaveLength(1)
  })

  it('gives different devices different keys', () => {
    const first = registerMobilePushDevice(createMobilePushRegistryState(), {
      deviceId: 'a',
      deviceToken: 'token-a',
      nowMs: 100
    })
    const second = registerMobilePushDevice(first.state, {
      deviceId: 'b',
      deviceToken: 'token-b',
      nowMs: 101
    })
    expect(second.pushKeyB64).not.toBe(first.pushKeyB64)
  })

  // Why: a phone re-registers on every launch and on every APNs token
  // rotation. Minting a fresh key each time would invalidate pushes already in
  // flight and churn the phone's keychain for no benefit.
  it('keeps the key when a known device re-registers with a new token', () => {
    const first = registerMobilePushDevice(createMobilePushRegistryState(), {
      deviceId: 'a',
      deviceToken: 'old-token',
      nowMs: 100
    })
    const second = registerMobilePushDevice(first.state, {
      deviceId: 'a',
      deviceToken: 'new-token',
      nowMs: 500
    })

    expect(second.pushKeyB64).toBe(first.pushKeyB64)
    expect(listMobilePushRegistrations(second.state)).toHaveLength(1)
    expect(listMobilePushRegistrations(second.state)[0]!.deviceToken).toBe('new-token')
  })

  // Eviction order must be "oldest device out", not "least recently launched
  // app out", or a phone that reconnects often would outlive one that does not.
  it('preserves the original registration time across re-registration', () => {
    const first = registerMobilePushDevice(createMobilePushRegistryState(), {
      deviceId: 'a',
      deviceToken: 'old-token',
      nowMs: 100
    })
    const second = registerMobilePushDevice(first.state, {
      deviceId: 'a',
      deviceToken: 'new-token',
      nowMs: 999
    })
    expect(listMobilePushRegistrations(second.state)[0]!.registeredAtMs).toBe(100)
  })

  // Why unregister exists at all: a user switching that phone to local-only
  // expects push to stop now. APNs would never report the token as gone — it
  // is still perfectly valid.
  it('stops sealing for a device once it unregisters', () => {
    const registered = registerMobilePushDevice(createMobilePushRegistryState(), {
      deviceId: 'a',
      deviceToken: 'token-a',
      nowMs: 100
    })
    const after = unregisterMobilePushDevice(registered.state, 'a')
    expect(listMobilePushRegistrations(after)).toHaveLength(0)
  })

  it('leaves other devices alone when one unregisters', () => {
    const first = registerMobilePushDevice(createMobilePushRegistryState(), {
      deviceId: 'a',
      deviceToken: 'token-a',
      nowMs: 100
    })
    const second = registerMobilePushDevice(first.state, {
      deviceId: 'b',
      deviceToken: 'token-b',
      nowMs: 101
    })
    const after = unregisterMobilePushDevice(second.state, 'a')
    expect(listMobilePushRegistrations(after).map((entry) => entry.deviceId)).toEqual(['b'])
  })

  it('re-registering after unregistering mints a fresh key', () => {
    const first = registerMobilePushDevice(createMobilePushRegistryState(), {
      deviceId: 'a',
      deviceToken: 'token-a',
      nowMs: 100
    })
    const cleared = unregisterMobilePushDevice(first.state, 'a')
    const again = registerMobilePushDevice(cleared, {
      deviceId: 'a',
      deviceToken: 'token-a',
      nowMs: 200
    })
    expect(again.pushKeyB64).not.toBe(first.pushKeyB64)
  })
})
