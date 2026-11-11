import Foundation

/// Privileged clipboard access belongs to Tessera's selected top-level app,
/// never to its embedded browser/proxy content (even on the same origin).
public enum ClipboardPolicy {
    public static let maxTextBytes = 1_048_576
    public static let maxImageBytes = 16 * 1_024 * 1_024
    public static let maxImagePixels = 16_000_000

    public static func isAppDocument(_ url: URL) -> Bool {
        let path = url.path
        if ["/", "", "/m", "/m/", "/index.html"].contains(path) { return true }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        let route = path.hasSuffix("/") ? Array(parts.dropLast()) : parts
        return route.count == 5 && route[0].isEmpty && route[1] == "users"
            && !route[2].isEmpty && route[3] == "sessions" && !route[4].isEmpty
    }

    public static func allows(server: URL, document: URL, frame: URL, origin: URL,
                              isMainFrame: Bool, isActive: Bool) -> Bool {
        isMainFrame && isActive && isAppDocument(document) && isAppDocument(frame)
            && ServerAddress.sameOrigin(server, document)
            && ServerAddress.sameOrigin(server, frame)
            && ServerAddress.sameOrigin(server, origin)
    }

    public static func imageData(_ base64: String) -> Data? {
        guard base64.utf8.count <= ((maxImageBytes + 2) / 3) * 4,
              let data = Data(base64Encoded: base64), !data.isEmpty,
              data.count <= maxImageBytes else { return nil }
        return data
    }
}
