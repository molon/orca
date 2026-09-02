import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetTerminalSubscribeRestarts,
  noteTerminalSubscribeSucceeded,
  planTerminalStreamRestart
} from './terminal-subscribe-restart'

const HANDLE = 'term-a'

beforeEach(() => {
  forgetTerminalSubscribeRestarts(HANDLE)
})

describe('terminal stream restart', () => {
  it('restarts a subscription that ended before it ever started', () => {
    // Captured in the field: a viewport resubscribe whose first event is `end`.
    // Treating it as an ordinary end left the pane with no live stream at all —
    // nothing arriving, and a one-screen buffer with nothing to scroll.
    expect(planTerminalStreamRestart(HANDLE, 3, 'end')).toBeGreaterThan(0)
  })

  it('leaves a stream that really ran alone', () => {
    noteTerminalSubscribeSucceeded(HANDLE, 3)

    // The terminal closed, or the route did. Resubscribing would revive a pane
    // the host has finished with.
    expect(planTerminalStreamRestart(HANDLE, 3, 'end')).toBeNull()
  })

  it('does not credit one attempt for another attempt having started', () => {
    noteTerminalSubscribeSucceeded(HANDLE, 3)

    // seq 5 is the resubscribe that replaced it; that seq 3 once worked says
    // nothing about whether this one ever did.
    expect(planTerminalStreamRestart(HANDLE, 5, 'end')).toBeGreaterThan(0)
  })

  it('backs off, then gives up rather than looping', () => {
    const delays = [
      planTerminalStreamRestart(HANDLE, 1, 'end'),
      planTerminalStreamRestart(HANDLE, 3, 'end'),
      planTerminalStreamRestart(HANDLE, 5, 'end')
    ]
    expect(delays.every((delay) => delay !== null)).toBe(true)
    // Growing: an immediate retry would be sent while the unsubscribe that lost
    // the race is still in flight, and lose to it again.
    expect(delays[0]!).toBeLessThan(delays[1]!)
    expect(delays[1]!).toBeLessThan(delays[2]!)
    // A subscribe that keeps dying is a real fault; it should surface as one
    // rather than as a silent loop.
    expect(planTerminalStreamRestart(HANDLE, 7, 'end')).toBeNull()
  })

  it('starts counting again once a subscription takes', () => {
    planTerminalStreamRestart(HANDLE, 1, 'end')
    planTerminalStreamRestart(HANDLE, 3, 'end')
    noteTerminalSubscribeSucceeded(HANDLE, 5)

    // Otherwise a terminal that hit the race twice hours ago would get one
    // retry the next time, then none.
    expect(planTerminalStreamRestart(HANDLE, 7, 'end')).toBe(
      planTerminalStreamRestart('fresh-handle', 1, 'end')
    )
  })

  it('is wired into the subscription listener', () => {
    const screen = readFileSync(
      new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
      'utf8'
    )
    const ended = screen.slice(
      screen.indexOf("if (data.type === 'end' || data.type === 'error') {"),
      screen.indexOf("if (data.type === 'subscribed') {")
    )
    expect(ended).toContain('planTerminalStreamRestart(handle, seq')
    expect(ended).toContain('subscribeToTerminalRef.current')
    expect(screen).toContain('noteTerminalSubscribeSucceeded(handle, seq)')
  })
})
