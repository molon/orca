import * as Crypto from 'expo-crypto'

/**
 * What a machine hands this phone so it can receive that machine's pushes.
 *
 * Why a single pasted string rather than fields: the two values have to agree
 * exactly and are useless apart, so typing them separately only creates ways to
 * get them wrong.
 */
export type PushChannel = {
  readonly provider: string
  readonly keyB64: string
  readonly channelId: string
  /** The server's own credential, not the channel secret. It rides along
   *  because subscribing is a call to that server, and everyone holding one of
   *  these strings was already given the credential to produce it. */
  readonly authToken: string
}

// A provider URL and a base64 key; anything larger was not produced by setup.
const MAX_BLOB_LENGTH = 2048
const KEY_BYTES = 32

/**
 * Parses the string setup printed, or null if it is not one.
 *
 * Why null rather than an error message per failure mode: every failure has the
 * same fix — copy the string again — and naming which byte was wrong invites
 * the reader to try to repair it by hand.
 */
/**
 * The scheme setup encodes into the QR code.
 *
 * Why a scheme rather than the bare string in the code: one scanner reads both
 * this and a host pairing offer, and it has to tell them apart before it can
 * decide what to do — a bare base64 blob only announces what it is once it has
 * been decoded and guessed at.
 */
const CHANNEL_URL_PREFIX = 'orca://push-channel?code='

/** The string from the QR code, or the bare blob a paste supplies. */
function extractBlob(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.toLowerCase().startsWith(CHANNEL_URL_PREFIX)) {
    return trimmed
  }
  // Not `new URL`: the code is base64url and Hermes' URL parser percent-escapes
  // and reorders query strings, which corrupts it on the way back out.
  return trimmed.slice(CHANNEL_URL_PREFIX.length)
}

export async function parsePushChannelBlob(input: string): Promise<PushChannel | null> {
  const trimmed = extractBlob(input)
  if (trimmed.length === 0 || trimmed.length > MAX_BLOB_LENGTH) {
    return null
  }
  let decoded: string
  try {
    decoded = atob(trimmed.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const { provider, key, authToken } = parsed as {
    provider?: unknown
    key?: unknown
    authToken?: unknown
  }
  if (typeof provider !== 'string' || typeof key !== 'string') {
    return null
  }
  if (!/^https?:\/\//.test(provider) || decodedKeyLength(key) !== KEY_BYTES) {
    return null
  }
  return {
    provider: provider.replace(/\/+$/, ''),
    keyB64: key,
    channelId: await channelIdFor(key),
    authToken: typeof authToken === 'string' ? authToken : ''
  }
}

/**
 * The address the publisher sends to, derived from the key on both sides.
 *
 * Why derived rather than carried: one secret to move instead of two values
 * that can disagree, and the server ends up holding an id it cannot reverse
 * into the key it would need to read anything.
 */
export async function channelIdFor(keyB64: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, keyB64, {
    encoding: Crypto.CryptoEncoding.HEX
  })
  return digest.slice(0, 32)
}

function decodedKeyLength(keyB64: string): number {
  try {
    return atob(keyB64).length
  } catch {
    return -1
  }
}
