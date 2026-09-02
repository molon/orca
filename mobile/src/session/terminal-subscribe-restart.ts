/*
A terminal subscription that ends before it ever says `subscribed` did not end —
it never started, and the pane it belonged to is left with no live stream at all.

Where that comes from: the host keys a subscription by the stable
`${terminal}:${clientId}`, and a viewport resubscribe sends unsubscribe and
subscribe back to back over the same connection with that same id. The host's
unsubscribe guard only refuses ids owned by a *different* connection, so if the
two are processed out of order the unsubscribe tears down the subscription that
just replaced it. Captured in the field: first subscribes never failed this way
in forty-nine attempts, while resubscribes did in fifteen out of forty-one.

Treating that as an ordinary end left the pane silent until something else
happened to resubscribe it — which is why leaving the session and returning
fixed it, why the redraw button usually fixed it, and why the redraw button
sometimes did not: its own resubscribe could lose the same race.

Fixed here rather than on the host because a phone and the machine it talks to
update independently, so the client cannot assume a host that orders these
correctly. Bounded, because a subscribe that keeps dying is a real fault and
should surface as one rather than as a silent retry loop.
*/

import { logTerminalLiveness } from '../terminal/terminal-liveness-log'

const MAX_RESTARTS = 3
/** Growing, and starting past a frame: an immediate retry would be sent while
 *  the losing unsubscribe is still in flight and lose to it again. */
const RESTART_DELAYS_MS = [150, 400, 1200]

const attemptsByHandle = new Map<string, number>()
/** Which subscription attempt actually reached `subscribed`, by handle. Kept
 *  here rather than in the caller's closure so an end can be classified from
 *  the handle and seq alone. */
const startedSeqByHandle = new Map<string, number>()

/** The subscription took. Whatever it cost to get here stops counting. */
export function noteTerminalSubscribeSucceeded(handle: string, seq: number): void {
  attemptsByHandle.delete(handle)
  startedSeqByHandle.set(handle, seq)
}

/** Forgets a terminal entirely — it closed, or the route did. */
export function forgetTerminalSubscribeRestarts(handle: string): void {
  attemptsByHandle.delete(handle)
  startedSeqByHandle.delete(handle)
}

/**
 * How long to wait before subscribing again, or null to leave it alone —
 * either this subscription had really started, or the budget is spent.
 *
 * Logs either way, with everything a later capture needs to tell the two apart
 * without inferring: `started=false` is the race, while a `restartMs` reading
 * `budget-spent` is a subscribe failing for some other reason.
 */
export function planTerminalStreamRestart(
  handle: string,
  seq: number,
  type: string
): number | null {
  const started = startedSeqByHandle.get(handle) === seq
  const spent = attemptsByHandle.get(handle) ?? 0
  const restartMs = started || spent >= MAX_RESTARTS ? null : RESTART_DELAYS_MS[spent]
  if (restartMs !== null) {
    attemptsByHandle.set(handle, spent + 1)
  }
  logTerminalLiveness('stream-dead', {
    handle: handle.slice(-8),
    seq,
    type,
    started,
    attempt: spent,
    restartMs: restartMs ?? (started ? 'ended-normally' : 'budget-spent')
  })
  return restartMs
}
