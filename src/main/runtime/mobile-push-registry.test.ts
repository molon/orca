import { describe, expect, it } from 'vitest'
import {
  MOBILE_PUSH_MAX_DEVICES,
  createMobilePushRegistryState,
  findMobilePushRegistration,
  listMobilePushRegistrations,
  pruneMobilePushRegistrations,
  readMobilePushRegistryState,
  removeMobilePushRegistration,
  upsertMobilePushRegistration,
  type MobilePushRegistration
} from './mobile-push-registry'

function registration(overrides: Partial<MobilePushRegistration> = {}): MobilePushRegistration {
  return {
    deviceId: 'device-1',
    deviceToken: 'token-1',
    pushKeyB64: 'key-1',
    registeredAtMs: 1,
    ...overrides
  }
}

describe('mobile push registry', () => {
  it('starts empty', () => {
    expect(listMobilePushRegistrations(createMobilePushRegistryState())).toEqual([])
  })

  it('keeps every paired device, since one desktop fans out to all of them', () => {
    let state = createMobilePushRegistryState()
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'a' }))
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'b' }))
    expect(listMobilePushRegistrations(state).map((entry) => entry.deviceId)).toEqual(['a', 'b'])
  })

  // Why: a reinstall or token rotation reuses the deviceId. Appending instead of
  // replacing would leave a dead token that every later dispatch still targets.
  it('replaces a device in place when it re-registers', () => {
    let state = createMobilePushRegistryState()
    state = upsertMobilePushRegistration(state, registration({ deviceToken: 'old' }))
    state = upsertMobilePushRegistration(state, registration({ deviceToken: 'new' }))
    expect(listMobilePushRegistrations(state)).toHaveLength(1)
    expect(findMobilePushRegistration(state, 'device-1')?.deviceToken).toBe('new')
  })

  it('gives each device its own key, so one unpairing cannot read another device push', () => {
    let state = createMobilePushRegistryState()
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'a', pushKeyB64: 'ka' }))
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'b', pushKeyB64: 'kb' }))
    expect(findMobilePushRegistration(state, 'a')?.pushKeyB64).not.toBe(
      findMobilePushRegistration(state, 'b')?.pushKeyB64
    )
  })

  it('removes a single device without disturbing the rest', () => {
    let state = createMobilePushRegistryState()
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'a' }))
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'b' }))
    state = removeMobilePushRegistration(state, 'a')
    expect(listMobilePushRegistrations(state).map((entry) => entry.deviceId)).toEqual(['b'])
  })

  it('returns the same state when removing a device that is not registered', () => {
    const state = upsertMobilePushRegistration(createMobilePushRegistryState(), registration())
    expect(removeMobilePushRegistration(state, 'absent')).toBe(state)
  })

  it('prunes only the devices APNs reported as unregistered', () => {
    let state = createMobilePushRegistryState()
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'a' }))
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'b' }))
    state = upsertMobilePushRegistration(state, registration({ deviceId: 'c' }))
    state = pruneMobilePushRegistrations(state, new Set(['a', 'c']))
    expect(listMobilePushRegistrations(state).map((entry) => entry.deviceId)).toEqual(['b'])
  })

  // Why: a transient send failure must not cost a device its registration, so
  // an empty prune set is a no-op rather than a rebuild.
  it('returns the same state when nothing is pruned', () => {
    const state = upsertMobilePushRegistration(createMobilePushRegistryState(), registration())
    expect(pruneMobilePushRegistrations(state, new Set())).toBe(state)
  })

  it('evicts the oldest device once past the cap', () => {
    let state = createMobilePushRegistryState()
    for (let i = 0; i < MOBILE_PUSH_MAX_DEVICES + 2; i++) {
      state = upsertMobilePushRegistration(
        state,
        registration({ deviceId: `device-${i}`, registeredAtMs: i })
      )
    }
    const ids = listMobilePushRegistrations(state).map((entry) => entry.deviceId)
    expect(ids).toHaveLength(MOBILE_PUSH_MAX_DEVICES)
    expect(ids).not.toContain('device-0')
    expect(ids).toContain(`device-${MOBILE_PUSH_MAX_DEVICES + 1}`)
  })

  // Why: push is an enhancement. A corrupt registry must not stop the desktop
  // from starting — phones re-register on their next connection.
  it('falls back to an empty registry rather than throwing on malformed state', () => {
    expect(listMobilePushRegistrations(readMobilePushRegistryState({ v: 99 }))).toEqual([])
    expect(listMobilePushRegistrations(readMobilePushRegistryState(null))).toEqual([])
    expect(listMobilePushRegistrations(readMobilePushRegistryState('nonsense'))).toEqual([])
  })

  it('round-trips a persisted registry', () => {
    const state = upsertMobilePushRegistration(createMobilePushRegistryState(), registration())
    expect(readMobilePushRegistryState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  // Simulator tokens are far longer than the 64 hex chars a real device returns,
  // so the token shape must stay opaque above the sender.
  it('accepts tokens of any shape, since dev and device tokens differ', () => {
    let state = createMobilePushRegistryState()
    state = upsertMobilePushRegistration(state, registration({ deviceToken: 'a'.repeat(200) }))
    expect(findMobilePushRegistration(state, 'device-1')?.deviceToken).toHaveLength(200)
  })
})
