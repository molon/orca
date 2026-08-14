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
//
// Why AES-256-GCM rather than the NaCl secretbox the E2EE channel uses: the
// reader is a Swift Notification Service Extension. CryptoKit has AES-GCM
// built in but no XSalsa20, so a secretbox would force libsodium into an
// extension that runs under a ~24 MB memory cap. The framing below is exactly
// CryptoKit's `AES.GCM.SealedBox(combined:)` layout, so the extension opens it
// with no framing code and no dependency.
//
// Desktop-side only: this uses node:crypto and must never be imported by the
// React Native app. The phone reads envelopes in the extension, not in JS.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'

export const MOBILE_PUSH_ENVELOPE_VERSION = 1

// Why bounded: APNs rejects payloads over 4 KiB, and the envelope is only one
// field of the notification body. Sealing something larger cannot be delivered,
// so it fails here rather than at Apple.
export const MOBILE_PUSH_PLAINTEXT_MAX_BYTES = 2 * 1024

const PUSH_KEY_BYTES = 32
// GCM's standard nonce length; CryptoKit's combined layout assumes 12.
const PUSH_NONCE_BYTES = 12
const PUSH_TAG_BYTES = 16

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

function assertKeyLength(key: Buffer): void {
  if (key.length !== PUSH_KEY_BYTES) {
    throw new MobilePushEnvelopeError(`push key must be ${PUSH_KEY_BYTES} bytes, got ${key.length}`)
  }
}

/** A fresh per-device push key. One device unpairing takes only its own key. */
export function generateMobilePushKey(): Buffer {
  return randomBytes(PUSH_KEY_BYTES)
}

export function mobilePushKeyToBase64(key: Buffer): string {
  assertKeyLength(key)
  return key.toString('base64')
}

export function mobilePushKeyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, 'base64')
  assertKeyLength(key)
  return key
}

/** base64([12-byte nonce][ciphertext][16-byte tag]) — CryptoKit's combined
 *  sealed-box layout, so the extension needs no framing code of its own. */
export function sealMobilePushEnvelope(payload: MobilePushPayload, key: Buffer): string {
  const parsed = MobilePushPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new MobilePushEnvelopeError('push payload does not match the payload schema')
  }
  assertKeyLength(key)
  const plaintext = Buffer.from(JSON.stringify(parsed.data), 'utf8')
  if (plaintext.byteLength > MOBILE_PUSH_PLAINTEXT_MAX_BYTES) {
    throw new MobilePushEnvelopeError(
      `push payload is ${plaintext.byteLength} bytes, over the ${MOBILE_PUSH_PLAINTEXT_MAX_BYTES} limit`
    )
  }
  const nonce = randomBytes(PUSH_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
}

/** Opens a sealed envelope. Throws on any tampering, wrong key, or malformed
 *  input — the extension shows its fallback text rather than trusting it. */
export function openMobilePushEnvelope(envelope: string, key: Buffer): MobilePushPayload {
  assertKeyLength(key)
  const framed = Buffer.from(envelope, 'base64')
  if (framed.length <= PUSH_NONCE_BYTES + PUSH_TAG_BYTES) {
    throw new MobilePushEnvelopeError('envelope is too short to contain a nonce, body, and tag')
  }
  const nonce = framed.subarray(0, PUSH_NONCE_BYTES)
  const ciphertext = framed.subarray(PUSH_NONCE_BYTES, framed.length - PUSH_TAG_BYTES)
  const tag = framed.subarray(framed.length - PUSH_TAG_BYTES)

  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new MobilePushEnvelopeError('envelope failed authentication')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new MobilePushEnvelopeError('envelope plaintext is not valid JSON')
  }
  const parsed = MobilePushPayloadSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new MobilePushEnvelopeError('envelope plaintext does not match the payload schema')
  }
  return parsed.data
}
