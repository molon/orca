import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetHostPushDelivery,
  recordHostPushDelivery,
  shouldDeliverLocally
} from './push-delivery-state'

beforeEach(() => {
  for (const host of ['host-1', 'host-2']) {
    forgetHostPushDelivery(host)
  }
})

describe('push delivery state', () => {
  // The bug this exists to prevent: both paths carry every event, so a phone
  // that is connected AND registered showed each notification twice.
  it('stops the live stream from delivering once push is registered', () => {
    recordHostPushDelivery('host-1', { mode: 'auto', pushRegistered: true })
    expect(shouldDeliverLocally('host-1')).toBe(false)
  })

  it('keeps the live stream delivering when registration did not happen', () => {
    recordHostPushDelivery('host-1', { mode: 'auto', pushRegistered: false })
    expect(shouldDeliverLocally('host-1')).toBe(true)
  })

  // Why default true: a pairing that has not decided anything yet must not
  // lose notifications on the path that already worked.
  it('delivers locally for a host it has never heard of', () => {
    expect(shouldDeliverLocally('never-seen')).toBe(true)
  })

  it('honours a user who pinned local delivery even when registered', () => {
    recordHostPushDelivery('host-1', { mode: 'local-only', pushRegistered: true })
    expect(shouldDeliverLocally('host-1')).toBe(true)
  })

  it('keeps hosts independent, so one pairing cannot silence another', () => {
    recordHostPushDelivery('host-1', { mode: 'auto', pushRegistered: true })
    recordHostPushDelivery('host-2', { mode: 'auto', pushRegistered: false })
    expect(shouldDeliverLocally('host-1')).toBe(false)
    expect(shouldDeliverLocally('host-2')).toBe(true)
  })

  // A later pairing reusing the id must not inherit the old decision, or it
  // would start life silently dropping every notification.
  it('forgets a pairing so a new one starts from the default', () => {
    recordHostPushDelivery('host-1', { mode: 'auto', pushRegistered: true })
    forgetHostPushDelivery('host-1')
    expect(shouldDeliverLocally('host-1')).toBe(true)
  })
})
