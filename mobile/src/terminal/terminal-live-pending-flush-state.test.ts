import { describe, expect, it } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

describe('terminal live pending flush state', () => {
  it('Given no in-flight flush When waiting for the barrier Then allows control input', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()

    // When / Then
    await expect(waitForTerminalLivePendingFlush(state)).resolves.toBe(true)
  })

  it('Given an in-flight flush When control input waits Then control is held until flush succeeds', async () => {
    // Given
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state = createTerminalLivePendingFlushState()
    state.current = flushPromise

    // When
    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    await Promise.resolve()

    // Then
    expect(events).toEqual([])
    resolveFlush(true)
    await expect(controlSend).resolves.toBe(true)
    expect(events).toEqual(['control'])
  })

  it('Given an in-flight flush fails When control input waits Then control is skipped', async () => {
    // Given
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state = createTerminalLivePendingFlushState()
    state.current = flushPromise

    // When
    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    resolveFlush(false)

    // Then
    await expect(controlSend).resolves.toBe(false)
    expect(events).toEqual([])
  })
})

describe('terminal live mirror send queue', () => {
  it('Given high RTT When more input queues Then pending bytes share one follow-up send', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    let resolveFirstSend: (value: boolean) => void = () => {}
    const sender = async (_handle: string, payload: string): Promise<boolean> => {
      payloads.push(payload)
      if (payloads.length === 1) {
        return new Promise<boolean>((resolve) => {
          resolveFirstSend = resolve
        })
      }
      return true
    }

    // When
    const first = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'a' },
      sender
    )
    const second = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'b' },
      sender
    )
    const third = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'c' },
      sender
    )
    await Promise.resolve()

    // Then
    expect(payloads).toEqual(['a'])
    resolveFirstSend(true)
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
    expect(payloads).toEqual(['a', 'bc'])
  })

  // Dictation rewrites its own transcript several times a second. Replaying each
  // guess would draw and erase text the speaker never settled on.
  it('Given revisions queued behind a send When it lands Then only the final text is drawn', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const payloads: string[] = []
    let resolveFirstSend: (value: boolean) => void = () => {}
    const sender = async (_handle: string, payload: string): Promise<boolean> => {
      payloads.push(payload)
      if (payloads.length === 1) {
        return new Promise<boolean>((resolve) => {
          resolveFirstSend = resolve
        })
      }
      return true
    }

    // When: "hi" lands, then the transcript guesses "hi there", corrects to
    // "high", and settles on "higher"
    const edit = (eraseCount: number, appendText: string): Promise<boolean> =>
      queueTerminalLiveMirrorSend(state, 'terminal-1', { eraseCount, appendText }, sender)
    const first = edit(0, 'hi')
    const guess = edit(0, ' there')
    const correction = edit(6, 'gh')
    const settled = edit(0, 'er')
    await Promise.resolve()
    expect(payloads).toEqual(['hi'])
    resolveFirstSend(true)

    // Then: one plain append. The six erases cancelled text that never left the
    // queue, so " there" was never drawn and never had to be rubbed out.
    await expect(Promise.all([first, guess, correction, settled])).resolves.toEqual([
      true,
      true,
      true,
      true
    ])
    expect(payloads).toEqual(['hi', 'gher'])
  })

  it('Given a failed previous send When a mirror send queues Then it still runs in order', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const order: string[] = []
    const first = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'first' },
      async () => {
        order.push('first')
        return false
      }
    )

    // When
    const second = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'second' },
      async () => {
        order.push('second')
        return true
      }
    )

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(order).toEqual(['first', 'second'])
  })

  it('Given a throwing send When a mirror send queues Then the promise resolves false and the chain continues', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    const first = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'first' },
      async () => {
        throw new Error('boom')
      }
    )

    // When
    const second = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'second' },
      async () => true
    )

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('Given a settled mirror send When it was the newest Then the state resets to null', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()

    // When
    await queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'payload' },
      async () => true
    )
    await Promise.resolve()

    // Then
    expect(state.current).toBeNull()
  })

  it('Given queued input When the queue is cancelled Then unsent input is dropped', async () => {
    // Given
    const state = createTerminalLivePendingFlushState()
    let resolveSend: (value: boolean) => void = () => {}
    const sender = async (): Promise<boolean> =>
      new Promise((resolve) => {
        resolveSend = resolve
      })
    const active = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'a' },
      sender
    )
    const pending = queueTerminalLiveMirrorSend(
      state,
      'terminal-1',
      { eraseCount: 0, appendText: 'b' },
      sender
    )

    // When
    cancelTerminalLivePendingFlush(state)

    // Then
    await expect(Promise.all([active, pending])).resolves.toEqual([false, false])
    expect(state.current).toBeNull()
    resolveSend(true)
  })
})
