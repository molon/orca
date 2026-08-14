// Why: remote push travels through a push server and Apple's APNs, neither of
// which may read notification content. The desktop seals the payload for one
// specific device; only that device's Notification Service Extension can open
// it. The server sees a device token and an opaque blob.
//
// Why its own key rather than the E2EE session key: the session key is
// ephemeral (per-connection ECDH), but a push is sealed at dispatch time and
// opened much later — possibly after the app was killed and the socket is long
// gone. The push key is established once per device at registration and
// persists on both sides.
import nacl from 'tweetnacl'
import { z } from 'zod'

export const MOBILE_PUSH_ENVELOPE_VERSION = 1

// Why bounded: APNs rejects payloads over 4 KiB, and the envelope is only one
// field of the notification body. Sealing something larger cannot be delivered,
// so it fails here rather than at Apple.
export const MOBILE_PUSH_PLAINTEXT_MAX_BYTES = 2 * 1024

const PUSH_KEY_BYTES = nacl.secretbox.keyLength
const PUSH_NONCE_BYTES = nacl.secretbox.nonceLength

/** What a sealed push carries, once opened. Mirrors the local-notification data
 *  shape so the tap-routing path is identical for local and remote delivery.
 *
 *  Why unknown keys are stripped, not rejected: desktop and phone update
 *  independently, so a newer desktop adding an optional field must not make
 *  older phones reject the whole envelope and fall back to placeholder text.
 *  See docs/reference/remote-wire-compatibility.md, Rule 1. */
export const MobilePushPayloadSchema = z.object({
  source: z.string().min(1).max(64),
  hostId: z.string().min(1).max(128),
  title: z.string().max(512),
  body: z.string().max(1024),
  worktreeId: z.string().min(1).max(256).optional(),
  notificationId: z.string().min(1).max(128).optional()
})

export type MobilePushPayload = z.infer<typeof MobilePushPayloadSchema>

export class MobilePushEnvelopeError extends Error {}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Why the copy: tweetnacl checks `instanceof Uint8Array`, and values crossing
// the Hermes native bridge can fail it despite being byte-identical. Same
// defense as mobile/src/transport/e2ee.ts.
function u8(value: Uint8Array): Uint8Array {
  return new Uint8Array(value)
}

/** A fresh per-device push key. One device unpairing takes only its own key. */
export function generateMobilePushKey(): Uint8Array {
  return u8(nacl.randomBytes(PUSH_KEY_BYTES))
}

export function mobilePushKeyToBase64(key: Uint8Array): string {
  if (key.length !== PUSH_KEY_BYTES) {
    throw new MobilePushEnvelopeError(`push key must be ${PUSH_KEY_BYTES} bytes, got ${key.length}`)
  }
  return toBase64(key)
}

export function mobilePushKeyFromBase64(value: string): Uint8Array {
  let key: Uint8Array
  try {
    key = fromBase64(value)
  } catch {
    throw new MobilePushEnvelopeError('push key is not valid base64')
  }
  if (key.length !== PUSH_KEY_BYTES) {
    throw new MobilePushEnvelopeError(`push key must be ${PUSH_KEY_BYTES} bytes, got ${key.length}`)
  }
  return key
}

/** base64([24-byte nonce][ciphertext]), matching the framing the E2EE channel
 *  already uses so both sides read one familiar layout. */
export function sealMobilePushEnvelope(payload: MobilePushPayload, key: Uint8Array): string {
  const parsed = MobilePushPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new MobilePushEnvelopeError('push payload does not match the payload schema')
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(parsed.data))
  if (plaintext.byteLength > MOBILE_PUSH_PLAINTEXT_MAX_BYTES) {
    throw new MobilePushEnvelopeError(
      `push payload is ${plaintext.byteLength} bytes, over the ${MOBILE_PUSH_PLAINTEXT_MAX_BYTES} limit`
    )
  }
  const nonce = nacl.randomBytes(PUSH_NONCE_BYTES)
  const box = nacl.secretbox(u8(plaintext), u8(nonce), u8(key))
  const framed = new Uint8Array(nonce.length + box.length)
  framed.set(nonce, 0)
  framed.set(box, nonce.length)
  return toBase64(framed)
}

/** Opens a sealed envelope. Throws on any tampering, wrong key, or malformed
 *  input — the extension shows its fallback text rather than trusting it. */
export function openMobilePushEnvelope(envelope: string, key: Uint8Array): MobilePushPayload {
  let framed: Uint8Array
  try {
    framed = fromBase64(envelope)
  } catch {
    throw new MobilePushEnvelopeError('envelope is not valid base64')
  }
  if (framed.length <= PUSH_NONCE_BYTES) {
    throw new MobilePushEnvelopeError('envelope is too short to contain a nonce and ciphertext')
  }
  const nonce = framed.slice(0, PUSH_NONCE_BYTES)
  const box = framed.slice(PUSH_NONCE_BYTES)
  const plaintext = nacl.secretbox.open(u8(box), u8(nonce), u8(key))
  if (!plaintext) {
    throw new MobilePushEnvelopeError('envelope failed authentication')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new MobilePushEnvelopeError('envelope plaintext is not valid JSON')
  }
  const parsed = MobilePushPayloadSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new MobilePushEnvelopeError('envelope plaintext does not match the payload schema')
  }
  return parsed.data
}
