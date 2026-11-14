import CryptoKit
import Foundation

/// An unsigned configuration profile offering iPadOS a root CA, so Safari and
/// other apps can trust it. Identifiers and text match the server's
/// (internal/localhttps RootProfile), so installing from either replaces the other.
public enum RootCertificateProfile {
    public static let description = "Lets Safari and other apps trust this Tessera server's Local HTTPS. After installing, turn on full trust in Settings → General → About → Certificate Trust Settings."

    public static func identifiers(_ der: Data) -> (identifier: String, profileUUID: String, certificateUUID: String) {
        let digest = Array(SHA256.hash(data: der))
        let prefix = digest[..<8].map { String(format: "%02x", $0) }.joined()
        return ("org.tessera.local-https." + prefix, uuid(digest[..<16]), uuid(digest[16...]))
    }

    public static func data(authority der: Data, name: String) throws -> Data {
        let (identifier, profileUUID, certificateUUID) = identifiers(der)
        let certificate: [String: Any] = [
            "PayloadCertificateFileName": "tessera-local-ca.cer",
            "PayloadContent": der,
            "PayloadDisplayName": name,
            "PayloadIdentifier": identifier + ".root",
            "PayloadType": "com.apple.security.root",
            "PayloadUUID": certificateUUID,
            "PayloadVersion": 1,
        ]
        let profile: [String: Any] = [
            "PayloadContent": [certificate],
            "PayloadDescription": description,
            "PayloadDisplayName": name,
            "PayloadIdentifier": identifier,
            "PayloadOrganization": "Tessera",
            "PayloadRemovalDisallowed": false,
            "PayloadType": "Configuration",
            "PayloadUUID": profileUUID,
            "PayloadVersion": 1,
        ]
        return try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
    }

    private static func uuid(_ bytes: ArraySlice<UInt8>) -> String {
        var value = Array(bytes)
        value[6] = value[6] & 0x0f | 0x80 // version 8: custom
        value[8] = value[8] & 0x3f | 0x80
        let text = value.map { String(format: "%02X", $0) }.joined()
        let parts = [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { range in
            String(text[text.index(text.startIndex, offsetBy: range.lowerBound)..<text.index(text.startIndex, offsetBy: range.upperBound)])
        }
        return parts.joined(separator: "-")
    }
}
