import CryptoKit
import Foundation

/// Opens the envelope the publisher sealed for this channel.
///
/// The publisher frames as nonce(12) || ciphertext || tag(16), which is exactly
/// what `AES.GCM.SealedBox(combined:)` expects — so there is no framing code
/// here and no dependency beyond CryptoKit. The framing is pinned by
/// push-envelope-swift-interop.test.ts, which compiles this very file; the
/// publisher lives in another repository, so a change there that is not made
/// here breaks decryption on the phone while both sides' own tests pass.
enum OrcaPushEnvelope {
    struct Payload: Decodable {
        let source: String
        // No hostId: the publisher cannot know the phone's id for the host, so
        // it never seals one in. It comes from the stored identity instead.
        // Declaring it here made every real envelope fail to decode, while
        // hand-written fixtures that included it kept passing.
        let title: String
        let body: String
        let worktreeId: String?
        /// A publisher that is not the desktop cannot know a worktree id — it
        /// knows the directory the agent ran in. The app resolves the path
        /// against the worktrees it already lists, at tap time.
        let worktreePath: String?
        let notificationId: String?
    }

    enum OpenError: Error {
        case malformedEnvelope
        case malformedKey
        case authenticationFailed
        case malformedPayload
    }

    /// - Parameters:
    ///   - envelope: base64 of nonce || ciphertext || tag.
    ///   - keyBase64: the 32-byte per-device push key, base64 encoded.
    static func open(envelope: String, keyBase64: String) throws -> Payload {
        guard let sealedData = Data(base64Encoded: envelope) else {
            throw OpenError.malformedEnvelope
        }
        guard let keyData = Data(base64Encoded: keyBase64), keyData.count == 32 else {
            throw OpenError.malformedKey
        }

        let plaintext: Data
        do {
            let box = try AES.GCM.SealedBox(combined: sealedData)
            plaintext = try AES.GCM.open(box, using: SymmetricKey(data: keyData))
        } catch {
            // A wrong key, a tampered envelope, and a truncated one are
            // indistinguishable on purpose: the extension shows its fallback
            // text rather than anything derived from unverified bytes.
            throw OpenError.authenticationFailed
        }

        // Unknown fields are ignored rather than rejected: a newer desktop may
        // add an optional field, and an older phone must still show the
        // notification instead of falling back to placeholder text.
        // See docs/reference/remote-wire-compatibility.md, Rule 1.
        guard let payload = try? JSONDecoder().decode(Payload.self, from: plaintext) else {
            throw OpenError.malformedPayload
        }
        return payload
    }
}
