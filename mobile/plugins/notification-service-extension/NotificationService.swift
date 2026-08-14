import UserNotifications

/// Replaces the placeholder alert with the decrypted notification text.
///
/// The push server and APNs only ever carry ciphertext, so the alert that
/// arrives says nothing about content. This extension opens the envelope with
/// the per-device key and rewrites the alert in place.
///
/// Everything here fails closed: if the key is missing, the phone was restored
/// from another device's backup, or the envelope does not authenticate, the
/// user sees the placeholder rather than anything derived from unverified
/// bytes.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let content = request.content.mutableCopy() as? UNMutableNotificationContent
        bestAttempt = content

        guard let content else {
            contentHandler(request.content)
            return
        }

        guard
            let envelope = content.userInfo[Self.envelopeKey] as? String,
            let hostId = Self.hostId(from: content.userInfo)
        else {
            // Not one of ours (or an older desktop that still sends plain
            // notifications) — pass it through untouched.
            contentHandler(content)
            return
        }

        guard let keyBase64 = OrcaPushKeychain.loadPushKey(hostId: hostId) else {
            // The usual cause is a phone that has never registered for push
            // with this host. Placeholder is the honest outcome.
            contentHandler(content)
            return
        }

        guard let payload = try? OrcaPushEnvelope.open(envelope: envelope, keyBase64: keyBase64)
        else {
            contentHandler(content)
            return
        }

        content.title = payload.title
        content.body = payload.body
        // The tap route reads these, and they must match what the local
        // notification path puts in its data so one routing implementation
        // serves both delivery paths.
        var userInfo = content.userInfo
        userInfo["source"] = payload.source
        userInfo["hostId"] = payload.hostId
        if let worktreeId = payload.worktreeId {
            userInfo["worktreeId"] = worktreeId
        }
        if let notificationId = payload.notificationId {
            userInfo["notificationId"] = notificationId
        }
        userInfo.removeValue(forKey: Self.envelopeKey)
        content.userInfo = userInfo

        contentHandler(content)
    }

    /// iOS is about to kill the extension. Deliver whatever we have — dropping
    /// it would lose the notification entirely.
    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttempt {
            contentHandler(bestAttempt)
        }
    }

    private static let envelopeKey = "orcaEnvelope"

    /// The host id travels outside the envelope so the extension knows which
    /// device key to load before it can decrypt anything. It names a pairing,
    /// not content.
    private static func hostId(from userInfo: [AnyHashable: Any]) -> String? {
        guard let hostId = userInfo["hostId"] as? String, !hostId.isEmpty else {
            return nil
        }
        return hostId
    }
}
