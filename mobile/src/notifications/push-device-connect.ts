import { getDevicePushTokenAsync } from 'expo-notifications'
import { Platform } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { loadNotificationDeliveryMode } from '../storage/preferences'
import { resolveNotificationDeliveryMode } from './notification-delivery-mode'
import { registerPushDevice, unregisterPushDevice } from './push-device-registration'
import { recordHostPushDelivery } from './push-delivery-state'

/**
 * Brings this pairing's push registration in line with the delivery setting,
 * on every connect.
 *
 * Why it never throws: this runs on the connect path, where a rejection would
 * surface as an unhandled rejection and, worse, could interrupt wiring up the
 * live notification stream that push is only an enhancement over.
 */
export async function registerPushDeviceForHost(client: RpcClient, hostId: string): Promise<void> {
  try {
    const mode = resolveNotificationDeliveryMode(await loadNotificationDeliveryMode())
    if (mode === 'local-only') {
      // The user pinned local delivery, so the desktop must stop sealing for
      // this phone. APNs would never report the token as gone — it is still
      // perfectly valid — so the desktop has to be told.
      await unregisterPushDevice({ client, hostId })
      recordHostPushDelivery(hostId, { mode, pushRegistered: false })
      return
    }
    const result = await registerPushDevice({
      client,
      hostId,
      readDeviceToken: readNativePushToken,
      label: Platform.OS === 'ios' ? 'iOS' : 'Android'
    })
    // The live stream reads this to decide whether to raise its own
    // notification. Both paths carry every event, so without it a connected,
    // registered phone shows each one twice.
    recordHostPushDelivery(hostId, { mode, pushRegistered: result.kind === 'registered' })
  } catch {
    // Push stays unregistered and the local path keeps delivering.
    recordHostPushDelivery(hostId, { mode: 'auto', pushRegistered: false })
  }
}

/**
 * The native APNs/FCM token, or null when this build cannot have one.
 *
 * Simulators without push support and builds without the entitlement both fail
 * here, and neither is an error: the phone simply keeps local delivery.
 */
async function readNativePushToken(): Promise<string | null> {
  const token = await getDevicePushTokenAsync()
  return typeof token.data === 'string' && token.data.length > 0 ? token.data : null
}
