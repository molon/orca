import { describe, expect, it } from 'vitest'
import { isNotificationRouteAlreadyOpen } from './notification-route-already-open'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'

const target = mobileSessionRouteTarget({ hostId: 'host-1', worktreeId: 'repo::/w' })
const openSegments = ['h', '[hostId]', 'session', '[worktreeId]']

describe('is the notification target already on screen', () => {
  // The bug this prevents: a second copy of the session pushed onto the stack,
  // with a back button that appears to go nowhere.
  it('recognises the session the user is already reading', () => {
    expect(
      isNotificationRouteAlreadyOpen(target, {
        segments: openSegments,
        params: { hostId: 'host-1', worktreeId: 'repo::/w' }
      })
    ).toBe(true)
  })

  // Segments carry the group prefix and a route target does not. Comparing them
  // raw matches nothing, and nothing about the app looks broken when it fails.
  it('accounts for the group prefix in the segments', () => {
    expect(
      isNotificationRouteAlreadyOpen(target, {
        segments: ['[hostId]', 'session', '[worktreeId]'],
        params: { hostId: 'host-1', worktreeId: 'repo::/w' }
      })
    ).toBe(false)
  })

  it('navigates when a different session is open', () => {
    expect(
      isNotificationRouteAlreadyOpen(target, {
        segments: openSegments,
        params: { hostId: 'host-1', worktreeId: 'repo::/other' }
      })
    ).toBe(false)
  })

  it('navigates when the same worktree is open on another host', () => {
    expect(
      isNotificationRouteAlreadyOpen(target, {
        segments: openSegments,
        params: { hostId: 'host-2', worktreeId: 'repo::/w' }
      })
    ).toBe(false)
  })

  it('navigates from any other screen', () => {
    expect(
      isNotificationRouteAlreadyOpen(target, {
        segments: ['h', '[hostId]', 'tasks'],
        params: { hostId: 'host-1' }
      })
    ).toBe(false)
  })

  // Incidental params — a display name, a scroll anchor — say nothing about
  // which session is open and must not stop the match.
  it('ignores params that do not identify the session', () => {
    expect(
      isNotificationRouteAlreadyOpen(target, {
        segments: openSegments,
        params: { hostId: 'host-1', worktreeId: 'repo::/w', name: 'Say hello' }
      })
    ).toBe(true)
  })
})
