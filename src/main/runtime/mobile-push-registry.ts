// Why: one desktop pushes to every paired phone, so registrations are a set
// keyed by device rather than a single slot. Each device carries its own APNs
// token and its own push key, so unpairing one phone takes only that phone's
// key, and a token APNs rejects can be pruned without touching the others.
import { z } from 'zod'

// Why bounded: a registration is only created by an explicit pairing, so this
// is far above any real fleet. It stops a buggy or hostile client from growing
// the desktop's persisted state without limit.
export const MOBILE_PUSH_MAX_DEVICES = 32

export const MobilePushRegistrationSchema = z.object({
  deviceId: z.string().min(1).max(128),
  // Opaque to every layer above the sender: a real APNs token on device, a
  // synthetic string in development. Length differs between the two (simulator
  // tokens are far longer than the 64 hex chars a device returns), so this
  // deliberately does not constrain the shape.
  deviceToken: z.string().min(1).max(512),
  pushKeyB64: z.string().min(1).max(128),
  // Why tracked: pruning needs an ordering that does not depend on a clock the
  // caller might not have. Registration order is enough to evict the oldest.
  registeredAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  label: z.string().max(128).optional()
})

export type MobilePushRegistration = z.infer<typeof MobilePushRegistrationSchema>

export const MobilePushRegistryStateSchema = z.object({
  v: z.literal(1),
  registrations: z.array(MobilePushRegistrationSchema).max(MOBILE_PUSH_MAX_DEVICES)
})

export type MobilePushRegistryState = z.infer<typeof MobilePushRegistryStateSchema>

export function createMobilePushRegistryState(): MobilePushRegistryState {
  return { v: 1, registrations: [] }
}

/** Tolerates a malformed or absent persisted file by starting empty: push is an
 *  enhancement, and refusing to start because of it would be worse than losing
 *  registrations the phones re-establish on their next connection. */
export function readMobilePushRegistryState(raw: unknown): MobilePushRegistryState {
  const parsed = MobilePushRegistryStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : createMobilePushRegistryState()
}

/** Registering an already-known device replaces its entry in place. A reinstall
 *  or token rotation reuses the deviceId, so without this the registry would
 *  accumulate stale tokens and every dispatch would fan out to dead ones. */
export function upsertMobilePushRegistration(
  state: MobilePushRegistryState,
  registration: MobilePushRegistration
): MobilePushRegistryState {
  const parsed = MobilePushRegistrationSchema.parse(registration)
  const withoutDevice = state.registrations.filter((entry) => entry.deviceId !== parsed.deviceId)
  const next = [...withoutDevice, parsed]
  // Evict oldest first when over the cap; the newest registration is the one
  // whose owner is demonstrably present.
  const overflow = next.length - MOBILE_PUSH_MAX_DEVICES
  return {
    v: 1,
    registrations: overflow > 0 ? next.slice(overflow) : next
  }
}

export function removeMobilePushRegistration(
  state: MobilePushRegistryState,
  deviceId: string
): MobilePushRegistryState {
  const registrations = state.registrations.filter((entry) => entry.deviceId !== deviceId)
  return registrations.length === state.registrations.length ? state : { v: 1, registrations }
}

/** Drops the devices APNs reported as unregistered (uninstalled app, token
 *  permanently invalid). Called with the results of a fan-out, not eagerly:
 *  a transient send failure must not cost a device its registration. */
export function pruneMobilePushRegistrations(
  state: MobilePushRegistryState,
  unregisteredDeviceIds: ReadonlySet<string>
): MobilePushRegistryState {
  if (unregisteredDeviceIds.size === 0) {
    return state
  }
  const registrations = state.registrations.filter(
    (entry) => !unregisteredDeviceIds.has(entry.deviceId)
  )
  return registrations.length === state.registrations.length ? state : { v: 1, registrations }
}

export function listMobilePushRegistrations(
  state: MobilePushRegistryState
): readonly MobilePushRegistration[] {
  return state.registrations
}

export function findMobilePushRegistration(
  state: MobilePushRegistryState,
  deviceId: string
): MobilePushRegistration | null {
  return state.registrations.find((entry) => entry.deviceId === deviceId) ?? null
}
