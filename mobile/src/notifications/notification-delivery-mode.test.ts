import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_DELIVERY_MODES,
  decideNotificationDelivery,
  isNotificationDeliveryUnsatisfiable,
  resolveNotificationDeliveryMode
} from './notification-delivery-mode'

describe('notification delivery mode', () => {
  // Why auto is the default: push is an addition, and everyone starts without
  // a push server configured. Anything else would change behavior on upgrade.
  it('defaults to auto for absent or unrecognized stored values', () => {
    expect(resolveNotificationDeliveryMode(null)).toBe('auto')
    expect(resolveNotificationDeliveryMode(undefined)).toBe('auto')
    expect(resolveNotificationDeliveryMode('')).toBe('auto')
    expect(resolveNotificationDeliveryMode('nonsense')).toBe('auto')
  })

  it('round-trips every mode it offers', () => {
    for (const mode of NOTIFICATION_DELIVERY_MODES) {
      expect(resolveNotificationDeliveryMode(mode)).toBe(mode)
    }
  })

  // The upgrade path: an existing user who has never touched this setting must
  // see exactly today's behavior.
  it('delivers locally in auto when push is not registered', () => {
    expect(decideNotificationDelivery({ mode: 'auto', pushRegistered: false })).toEqual({
      usePush: false,
      useLocal: true
    })
  })

  it('prefers push in auto once registered', () => {
    expect(decideNotificationDelivery({ mode: 'auto', pushRegistered: true })).toEqual({
      usePush: true,
      useLocal: false
    })
  })

  // Why never both: two paths delivering one event is how duplicate banners
  // happen, and the collapse id only merges them on the OS side by luck.
  it('never runs both paths for one event', () => {
    for (const mode of NOTIFICATION_DELIVERY_MODES) {
      for (const pushRegistered of [true, false]) {
        const decision = decideNotificationDelivery({ mode, pushRegistered })
        expect(decision.usePush && decision.useLocal).toBe(false)
      }
    }
  })

  it('keeps local-only local even when push is available', () => {
    expect(decideNotificationDelivery({ mode: 'local-only', pushRegistered: true })).toEqual({
      usePush: false,
      useLocal: true
    })
  })

  it('keeps push-only from falling back, so the pinned path stays diagnosable', () => {
    expect(decideNotificationDelivery({ mode: 'push-only', pushRegistered: true })).toEqual({
      usePush: true,
      useLocal: false
    })
  })

  // With no key there is nothing to seal for, so "push" would deliver nothing.
  // Reporting it as unsatisfiable lets the UI say so instead of the user
  // wondering why notifications stopped.
  it('reports push-only without registration as unsatisfiable', () => {
    expect(isNotificationDeliveryUnsatisfiable({ mode: 'push-only', pushRegistered: false })).toBe(
      true
    )
  })

  it('reports every other combination as satisfiable', () => {
    for (const mode of NOTIFICATION_DELIVERY_MODES) {
      for (const pushRegistered of [true, false]) {
        if (mode === 'push-only' && !pushRegistered) {
          continue
        }
        expect(isNotificationDeliveryUnsatisfiable({ mode, pushRegistered })).toBe(false)
      }
    }
  })
})
