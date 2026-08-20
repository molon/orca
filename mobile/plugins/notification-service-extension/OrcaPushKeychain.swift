import Foundation
import Security
/// Reads the channel push key the app stored.
///
/// Why this can read it at all: the app writes the key with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. A push most often
/// arrives while the phone is locked, and an item stored at the WhenUnlocked
/// level — which the pairing credentials use — would be unreadable at exactly
/// that moment. See mobile/src/notifications/push-channel-store.ts.
///
/// The service name and key layout must match that file. They are duplicated
/// rather than shared because nothing crosses the JS/Swift boundary here.
enum OrcaPushKeychain {
    /// The service names expo-secure-store may have stored the entry under.
    ///
    /// It does not use the configured name verbatim: it appends `:no-auth` or
    /// `:auth` depending on requireAuthentication, and older versions wrote the
    /// bare name. Its own reader tries all three, so the JS side never notices
    /// — only a second process querying by hand does, and it finds nothing with
    /// no error to explain why.
    ///
    /// Ordered by what this app actually writes: it never requires
    /// authentication, so `:no-auth` is the hit; the bare name is a fallback
    /// for entries written before that suffix existed.
    private static let services = ["orca.push.v1:no-auth", "orca.push.v1"]
    /// Must match the storageKey() prefix in push-channel-store.ts.
    private static let channelPrefix = "orca.push-channel."

    /// What the extension needs to render and route one push.
    struct Identity: Decodable {
        let pushKeyB64: String
        /// The phone's own id for the host whose page this channel was pasted
        /// into. The publisher cannot know it, so it is stored here rather than
        /// sealed into the envelope.
        let hostId: String
    }

    static func loadChannelIdentity(channelId: String) -> Identity? {
        return loadIdentity(account: channelPrefix + channelId)
    }

    private static func loadIdentity(account: String) -> Identity? {
        for service in Self.services {
            if let identity = loadIdentity(account: account, service: service) {
                return identity
            }
        }
        return nil
    }

    private static func loadIdentity(account: String, service: String) -> Identity? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            // Data, not String: expo-secure-store stores the account as raw
            // UTF-8 bytes, and the keychain will not match a String attribute
            // against a Data one. A String here finds nothing, reports no
            // error, and every push renders as placeholder text.
            kSecAttrAccount as String: Data(account.utf8),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        // The extension runs in its own process; the shared access group is
        // what lets it reach an item the app wrote.
        if let accessGroup = Self.accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let identity = try? JSONDecoder().decode(Identity.self, from: data)
        else {
            return nil
        }
        return identity
    }

    /// Injected at build time by the config plugin, since the app group name
    /// depends on the bundle identifier the build is signed with.
    private static var accessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "OrcaPushKeychainAccessGroup") as? String
    }
}
