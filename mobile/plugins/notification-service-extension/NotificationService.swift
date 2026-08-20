import UserNotifications

// Compiled in only when ORCA_PUSH_DIAG is set at prebuild time. It stays out
// of shipping builds on purpose: a Darwin notification is readable by any
// process on the device, so broadcasting that a push just decrypted would leak
// exactly what the envelope exists to hide. Behind the flag it is the only way
// to observe an extension from another machine — os_log needs a cable, and the
// notification itself is the thing under test.
#if ORCA_PUSH_DIAG
    import Foundation

    func orcaPushDiag(_ step: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName("orca.diag.\(step)" as CFString),
            nil, nil, true)
    }
#else
    @inline(__always) func orcaPushDiag(_: String) {}
#endif

/// Replaces the placeholder alert with the decrypted notification text.
///
/// The push server and APNs only ever carry ciphertext, so the alert that
/// arrives says nothing about content. This extension opens the envelope with
/// the channel key and rewrites the alert in place.
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
        orcaPushDiag("entered")
        self.contentHandler = contentHandler
        let content = request.content.mutableCopy() as? UNMutableNotificationContent
        bestAttempt = content

        guard let content else {
            contentHandler(request.content)
            return
        }

        guard
            let envelope = content.userInfo[Self.envelopeKey] as? String,
            let channelId = content.userInfo[Self.channelIdKey] as? String,
            !channelId.isEmpty
        else {
            // Not one of ours — pass it through untouched.
            orcaPushDiag("nopayload")
            contentHandler(content)
            return
        }

        guard let identity = OrcaPushKeychain.loadChannelIdentity(channelId: channelId) else {
            // The usual cause is a channel string that was never pasted into a
            // host page on this phone. Placeholder is the honest outcome.
            orcaPushDiag("nokey")
            contentHandler(content)
            return
        }

        guard
            let payload = try? OrcaPushEnvelope.open(envelope: envelope, keyBase64: identity.pushKeyB64)
        else {
            orcaPushDiag("openfail")
            contentHandler(content)
            return
        }

        orcaPushDiag("ok")
        content.title = payload.title
        content.body = payload.body
        // The tap route reads these, so one routing implementation serves both
        // delivery paths.
        //
        // Why nested under "body" rather than set at the top level: for a
        // remote notification expo-notifications exposes `content.data` as
        // userInfo["body"], while for a local one it exposes the whole
        // dictionary. Writing these flat leaves data empty on the tap route,
        // so the notification opens the app and goes nowhere — with nothing
        // to distinguish it from a routing bug.
        var userInfo = content.userInfo
        var routing: [String: Any] = [
            "source": payload.source,
            // From the stored identity, not the envelope: the publisher has no
            // way to know the phone's id for the host.
            "hostId": identity.hostId
        ]
        if let worktreeId = payload.worktreeId {
            routing["worktreeId"] = worktreeId
        }
        if let worktreePath = payload.worktreePath {
            routing["worktreePath"] = worktreePath
        }
        if let notificationId = payload.notificationId {
            routing["notificationId"] = notificationId
        }
        userInfo["body"] = routing
        userInfo.removeValue(forKey: Self.envelopeKey)
        userInfo.removeValue(forKey: Self.channelIdKey)
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
    /// Travels outside the envelope because the extension needs it before it
    /// can decrypt anything. It names one channel, not content.
    private static let channelIdKey = "orcaChannelId"

}
