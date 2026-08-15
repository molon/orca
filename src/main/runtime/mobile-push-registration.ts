// Why the desktop mints the key rather than the phone: the desktop is the
// sealer and owns the registry, so it can rotate a key without asking. The key
// reaches the phone over the pairing channel, which is already end-to-end
// encrypted, so it is never exposed to the relay or the push server.
import { generateMobilePushKey, mobilePushKeyToBase64 } from './mobile-push-envelope'
import {
  findMobilePushRegistration,
  removeMobilePushRegistration,
  upsertMobilePushRegistration,
  type MobilePushRegistryState
} from './mobile-push-registry'

export type MobilePushRegistrationRequest = {
  readonly deviceId: string
  readonly deviceToken: string
  readonly label?: string
  readonly nowMs: number
}

export type MobilePushRegistrationResult = {
  readonly state: MobilePushRegistryState
  /** Handed back to the phone, which stores it for the extension to read. */
  readonly pushKeyB64: string
}

/**
 * Registers or refreshes one device.
 *
 * Why the key is reused when the device is already known: a phone re-registers
 * on every launch and whenever APNs rotates its token. Minting a fresh key
 * each time would invalidate any push already in flight, and would churn the
 * phone's keychain for no benefit. The key changes only when the device is new
 * to this desktop.
 */
export function registerMobilePushDevice(
  state: MobilePushRegistryState,
  request: MobilePushRegistrationRequest
): MobilePushRegistrationResult {
  const existing = findMobilePushRegistration(state, request.deviceId)
  const pushKeyB64 = existing?.pushKeyB64 ?? mobilePushKeyToBase64(generateMobilePushKey())
  const nextState = upsertMobilePushRegistration(state, {
    deviceId: request.deviceId,
    deviceToken: request.deviceToken,
    pushKeyB64,
    // Keep the original registration time so the eviction order stays "oldest
    // device out", not "least recently launched app out".
    registeredAtMs: existing?.registeredAtMs ?? request.nowMs,
    ...(request.label ? { label: request.label } : {})
  })
  return { state: nextState, pushKeyB64 }
}

/**
 * Drops a device, so the desktop stops sealing for it.
 *
 * Why this exists rather than relying on APNs pruning: a user who switches
 * that phone to local-only delivery expects push to stop immediately. Waiting
 * for Apple to report the token as gone would never happen — the token is
 * still perfectly valid.
 */
export function unregisterMobilePushDevice(
  state: MobilePushRegistryState,
  deviceId: string
): MobilePushRegistryState {
  return removeMobilePushRegistration(state, deviceId)
}
