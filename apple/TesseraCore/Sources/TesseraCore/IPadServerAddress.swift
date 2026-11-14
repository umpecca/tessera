import Foundation

/// New iPad input only: stored URLs and the shared Mac parser stay unchanged.
public enum IPadServerAddress {
    public static let httpsPort = 7332

    public static func candidates(_ text: String, preserving existing: URL? = nil) throws -> [URL] {
        let url = try ServerAddress.parse(text).get()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Renaming an older profile must not turn its implicit 443/80 into
        // Tessera's new-entry defaults and replace its authenticated origin.
        if let existing, trimmed == existing.absoluteString { return [existing] }
        let explicitScheme = trimmed.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) != nil
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let typed = URLComponents(string: explicitScheme ? trimmed : "http://" + trimmed)!
        if typed.port != nil { return [url] }
        if explicitScheme {
            parts.port = parts.scheme == "https" ? httpsPort : ServerAddress.defaultPort
            return [parts.url!]
        }
        parts.scheme = "https"; parts.port = httpsPort
        return [parts.url!, url]
    }

    /// Only absence/connectivity failures permit automatic HTTP fallback.
    /// TLS, certificate, cancellation and application errors do not.
    public static func permitsHTTPFallback(_ error: Error) -> Bool {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        return [URLError.cannotConnectToHost, .timedOut, .networkConnectionLost,
                .cannotFindHost, .dnsLookupFailed].contains(URLError.Code(rawValue: error.code))
    }
}

public struct ServerCertificatePin: Codable, Equatable, Sendable {
    public let host: String
    public let port: Int
    public let sha256: String

    public init?(url: URL, sha256: String) {
        guard url.scheme?.lowercased() == "https", let host = url.host,
              sha256.count == 64, sha256.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
        self.host = Self.normalizedHost(host)
        self.port = url.port ?? 443
        self.sha256 = sha256.lowercased()
    }

    public func applies(to url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host.map(Self.normalizedHost) == host && (url.port ?? 443) == port
    }

    public func accepts(url: URL, sha256: String) -> Bool {
        applies(to: url) && self.sha256 == sha256.lowercased()
    }

    private static func normalizedHost(_ host: String) -> String {
        host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }
}
