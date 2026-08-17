import {
  decideNotificationDelivery,
  type NotificationDeliveryMode
} from './notification-delivery-mode'

/**
 * Which path is delivering for each paired desktop, decided once per connect.
 *
 * Why this is cached rather than computed per notification: the decision needs
 * the stored delivery mode and whether this pairing has a push key, both of
 * which are async reads. A notification arriving is the wrong moment to go ask
 * — and the answer only changes when a connection is established or the
 * setting is changed, which is exactly when this is written.
 */
const localDeliveryByHost = new Map<string, boolean>()

/**
 * Records the outcome of a connect-time registration attempt.
 *
 * Why the default is to deliver locally: a host with no entry has not decided
 * anything yet, and dropping notifications for a pairing that never registered
 * would silence the path that already worked.
 */
export function recordHostPushDelivery(
  hostId: string,
  input: { mode: NotificationDeliveryMode; pushRegistered: boolean }
): void {
  localDeliveryByHost.set(hostId, decideNotificationDelivery(input).useLocal)
}

/**
 * Whether the live stream should still raise a local notification.
 *
 * Push and the live stream both carry every event, so a phone that is
 * connected AND registered would otherwise show each notification twice — the
 * exact duplicate the delivery decision exists to prevent.
 */
export function shouldDeliverLocally(hostId: string): boolean {
  return localDeliveryByHost.get(hostId) ?? true
}

/** Called when a pairing goes away, so a later pairing reusing the id starts
 *  from the default rather than inheriting a stale decision. */
export function forgetHostPushDelivery(hostId: string): void {
  localDeliveryByHost.delete(hostId)
}
