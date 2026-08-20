import { execFileSync } from 'node:child_process'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why this exists: the publisher seals in JavaScript and the extension opens in
// Swift, and nothing else checks that the two agree. Every mismatch found so
// far was invisible to both sides' own tests — a field the Swift struct
// required that the sealer never writes decodes as a plain failure, and the
// extension's only visible symptom is a notification that says nothing.
const EXTENSION_DIR = join(__dirname, '../../plugins/notification-service-extension')

// GCM's standard nonce length; CryptoKit's combined layout assumes 12.
const NONCE_BYTES = 12

/**
 * Mirrors sealEnvelope() in orca-push/scripts/envelope.mjs — base64 of
 * [12-byte nonce][ciphertext][16-byte tag], CryptoKit's combined sealed-box
 * layout.
 *
 * Why mirrored instead of imported: the only publisher is the orca-push
 * plugin, which is a separate repository nothing here can import from. So this
 * cannot assert against the real sealer, only against the format both sides
 * froze — keep it byte-identical to that file, because a drift shows up as a
 * notification rendering placeholder text and nothing else.
 */
function sealEnvelope(payload: unknown, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final()
  ])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
}

function swiftAvailable(): boolean {
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' })
    return process.platform === 'darwin'
  } catch {
    return false
  }
}

/** Opens the envelope with the extension's own Swift source and prints the
 *  decoded payload as JSON, so the assertions below compare real output. */
function openWithSwift(envelope: string, keyBase64: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'orca-envelope-'))
  try {
    const main = join(dir, 'main.swift')
    writeFileSync(
      main,
      `
import Foundation
let payload = try OrcaPushEnvelope.open(
  envelope: CommandLine.arguments[1], keyBase64: CommandLine.arguments[2])
let out: [String: Any?] = [
  "source": payload.source, "title": payload.title, "body": payload.body,
  "worktreeId": payload.worktreeId, "worktreePath": payload.worktreePath,
  "notificationId": payload.notificationId
]
print(String(data: try JSONSerialization.data(
  withJSONObject: out.compactMapValues { $0 }), encoding: .utf8)!)
`,
      'utf8'
    )
    const binary = join(dir, 'probe')
    execFileSync('swiftc', [
      '-O',
      '-o',
      binary,
      join(EXTENSION_DIR, 'OrcaPushEnvelope.swift'),
      main
    ])
    return JSON.parse(execFileSync(binary, [envelope, keyBase64], { encoding: 'utf8' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!swiftAvailable())('push envelope crosses the TS/Swift boundary', () => {
  const key = Buffer.alloc(32, 7)

  it('opens what the publisher actually seals', () => {
    const envelope = sealEnvelope(
      { source: 'claude', title: 'Agent waiting', body: 'Confirm the next step' },
      key
    )
    expect(openWithSwift(envelope, key.toString('base64'))).toEqual({
      source: 'claude',
      title: 'Agent waiting',
      body: 'Confirm the next step'
    })
  })

  // The optional fields are the ones a payload may legitimately omit, and a
  // Swift struct that demands them fails on exactly the pushes that do.
  it('opens a payload carrying every optional field', () => {
    const envelope = sealEnvelope(
      {
        source: 'codex',
        title: '需要确认',
        body: '下一步操作',
        worktreeId: 'wt-42',
        worktreePath: '/Users/me/code/orca',
        notificationId: 'n-1'
      },
      key
    )
    expect(openWithSwift(envelope, key.toString('base64'))).toEqual({
      source: 'codex',
      title: '需要确认',
      body: '下一步操作',
      worktreeId: 'wt-42',
      worktreePath: '/Users/me/code/orca',
      notificationId: 'n-1'
    })
  })

  // What the hook actually sends: it knows the directory the agent ran in, not
  // a worktree id, so this is the shape every real push takes.
  it('opens a payload addressed by worktree path alone', () => {
    const envelope = sealEnvelope(
      {
        source: 'claude',
        title: 'Agent finished',
        body: 'Done',
        worktreePath: '/Users/me/code/orca'
      },
      key
    )
    expect(openWithSwift(envelope, key.toString('base64'))).toEqual({
      source: 'claude',
      title: 'Agent finished',
      body: 'Done',
      worktreePath: '/Users/me/code/orca'
    })
  })

  it('refuses an envelope sealed for another channel', () => {
    const envelope = sealEnvelope({ source: 'claude', title: 't', body: 'b' }, key)
    expect(() => openWithSwift(envelope, Buffer.alloc(32, 9).toString('base64'))).toThrow()
  })

  it('refuses a tampered envelope', () => {
    const envelope = sealEnvelope({ source: 'claude', title: 't', body: 'b' }, key)
    const raw = Buffer.from(envelope, 'base64')
    raw[raw.length - 1] ^= 0xff
    expect(() => openWithSwift(raw.toString('base64'), key.toString('base64'))).toThrow()
  })
})
