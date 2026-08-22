import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  join(__dirname, '../../app/h/[hostId]/session/[worktreeId].tsx'),
  'utf8'
)

/*
A source assertion, because the ordering it protects has no seam: both versions
compile, both pass every behavioural test, and the difference only shows as an
occasional blank terminal after returning from the background.

Resuming after a minute or two of background finds the socket dead, so foreground
recovery returns 'deferred' and is meant to re-run once the connection is back.
If the pending flag is cleared before the "are we actually active" guard, a
reconnect that completes while the app is merely 'inactive' — the app switcher, a
pulled-down notification, a push tap still launching — consumes that pending
recovery and drops it. Nothing re-arms it, and the WebView stays blank until the
user leaves the session and comes back.
*/
describe('deferred terminal foreground recovery', () => {
  it('checks the app is active before consuming the pending flag', () => {
    const guard = "if (AppState.currentState !== 'active') {"
    const clear = 'pendingForegroundRecoveryRef.current = false'
    const guardAt = sessionRouteSource.indexOf(guard)
    const clearAt = sessionRouteSource.indexOf(clear, guardAt)

    expect(guardAt).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(guardAt)
    // Nothing between them but the guard's own body: an early return.
    expect(sessionRouteSource.slice(guardAt, clearAt)).toContain('return')
  })

  it('still records the deferral when recovery could not run', () => {
    expect(sessionRouteSource).toContain(
      "pendingForegroundRecoveryRef.current = outcome === 'deferred'"
    )
  })
})
