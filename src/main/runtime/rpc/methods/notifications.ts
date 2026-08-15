import { z } from 'zod'
import { defineStreamingMethod, defineMethod, type RpcAnyMethod } from '../core'

// Why: monotonically increasing per-process counter eliminates the
// Date.now() collision that could fire when two near-simultaneous
// notifications.subscribe calls landed on the same millisecond.
let notificationsSubscriptionSeq = 0

const NotificationUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

// Why: notifications.getMissedSince is the catch-up RPC for mobile reconnect
// (#8129). The client passes the highest seq it has already delivered; the
// runtime returns only notifications dispatched after that seq. Because the
// desktop assigns a monotonic seq to every dispatched notification, the cut is
// exact and idempotent — re-requesting with the same watermark can never
// return an already-delivered event, so reconnects never duplicate local
// pushes (the adversarial-review gate for #8129).
// `epoch` names the counter lifetime lastSeenSeq came from (#8591). The desktop's
// seq restarts at 0 on every launch while the client's watermark is persisted, so
// without it a post-restart watermark silently cuts away everything. Optional: a
// client that predates the field keeps the seq-only cut.
const NotificationGetMissedSinceParams = z.object({
  lastSeenSeq: z.number().int().min(0, 'lastSeenSeq must be a non-negative integer'),
  epoch: z.string().optional()
})

// Why: remote push needs a per-device key that outlives any socket, since a
// push is sealed at dispatch and opened much later — possibly after the app was
// killed. The desktop mints it and returns it over this already end-to-end
// encrypted channel, so it is never exposed to the relay or the push server.
//
// The device token is opaque here: a real APNs token on device, a synthetic
// string in development, and simulator tokens are far longer than the 64 hex
// characters a device returns. Only the sender interprets it.
const NotificationRegisterPushDeviceParams = z.object({
  deviceId: z.string().min(1).max(128),
  deviceToken: z.string().min(1).max(512),
  label: z.string().max(128).optional()
})

const NotificationUnregisterPushDeviceParams = z.object({
  deviceId: z.string().min(1).max(128)
})

// Why: notifications.subscribe streams desktop notification events to mobile
// clients over WebSocket. The mobile client shows a local push notification
// for each event. This avoids requiring Firebase/APNs — the existing
// persistent WebSocket connection doubles as the push channel.
export const NOTIFICATION_METHODS: readonly RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'notifications.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.onNotificationDispatched((event) => {
          emit(event)
        })

        // Why: scope by per-ws connectionId + per-process counter so
        // concurrent subscribes never collide on the cleanup map.
        const seq = ++notificationsSubscriptionSeq
        const subscriptionId = `notifications-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Why: the epoch rides the ready frame so a reconnecting client learns the
        // counter lifetime BEFORE it sends its watermark to getMissedSince (#8591).
        emit({ type: 'ready', subscriptionId, epoch: runtime.getMobileNotificationEpoch() })
      })
    }
  }),
  defineMethod({
    name: 'notifications.unsubscribe',
    params: NotificationUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'notifications.getMissedSince',
    params: NotificationGetMissedSinceParams,
    // Why: returns only notifications with seq > lastSeenSeq. The runtime owns
    // the monotonic seq, so this is the single source of truth for what the
    // client missed while its socket was reaped.
    handler: async (params, { runtime }) => {
      const missed = runtime.getMissedNotificationsSince(params.lastSeenSeq, params.epoch)
      return { notifications: missed, epoch: runtime.getMobileNotificationEpoch() }
    }
  }),
  defineMethod({
    name: 'notifications.registerPushDevice',
    params: NotificationRegisterPushDeviceParams,
    // Why re-registering is safe to call on every launch: a known device keeps
    // its key, so the phone can register unconditionally rather than tracking
    // whether it already did.
    handler: async (params, { runtime }) => {
      const pushKeyB64 = runtime.registerMobilePushDevice({
        deviceId: params.deviceId,
        deviceToken: params.deviceToken,
        ...(params.label ? { label: params.label } : {})
      })
      return { pushKeyB64 }
    }
  }),
  defineMethod({
    name: 'notifications.unregisterPushDevice',
    params: NotificationUnregisterPushDeviceParams,
    // Why this is needed even though APNs prunes dead tokens: a user switching
    // this phone to local-only delivery expects push to stop now, and the
    // token is still perfectly valid so Apple would never report it gone.
    handler: async (params, { runtime }) => {
      runtime.unregisterMobilePushDevice(params.deviceId)
      return { unregistered: true }
    }
  })
]
