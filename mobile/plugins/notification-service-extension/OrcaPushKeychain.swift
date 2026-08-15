import Foundation
import Security

/// Reads the per-device push key the app stored.
///
/// Why this can read it at all: the app writes the key with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. A push most often
/// arrives while the phone is locked, and an item stored at the WhenUnlocked
/// level — which the pairing credentials use — would be unreadable at exactly
/// that moment. See mobile/src/notifications/push-key-store.ts.
///
/// The service name and key layout must match that file. They are duplicated
/// rather than shared because nothing crosses the JS/Swift boundary here.
enum OrcaPushKeychain {
    /// Must match PUSH_KEY_OPTIONS.keychainService in push-key-store.ts.
    private static let service = "orca.push.v1"
    /// Must match the storageKey() prefix in push-key-store.ts.
    private static let accountPrefix = "orca:push-key:"

    /// What the extension needs to render and route one push.
    struct Identity: Decodable {
        let pushKeyB64: String
        /// The phone's own id for the paired desktop. The desktop cannot know
        /// it, so it is stored here rather than sealed into the envelope.
        let hostId: String
    }

    static func loadIdentity(deviceId: String) -> Identity? {
        guard let account = accountName(deviceId: deviceId) else {
            return nil
        }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        // The extension runs in its own process; the shared access group is
        // what lets it reach an item the app wrote.
        if let accessGroup = Self.accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let identity = try? JSONDecoder().decode(Identity.self, from: data)
        else {
            return nil
        }
        return identity
    }

    /// Mirrors `encodeURIComponent(deviceId)` on the JS side, so an exotic id
    /// resolves to the same account name on both sides.
    private static func accountName(deviceId: String) -> String? {
        // encodeURIComponent leaves these unescaped; everything else is
        // percent-encoded uppercase.
        let unreserved = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        )
        guard let encoded = deviceId.addingPercentEncoding(withAllowedCharacters: unreserved) else {
            return nil
        }
        return accountPrefix + encoded
    }

    /// Injected at build time by the config plugin, since the app group name
    /// depends on the bundle identifier the build is signed with.
    private static var accessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "OrcaPushKeychainAccessGroup") as? String
    }
}
