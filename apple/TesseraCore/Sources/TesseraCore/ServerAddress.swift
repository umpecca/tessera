import Foundation

/// The Tessera server the app shows, from what the user typed: a bare host
/// such as `studio` or `100.64.0.2:8080`, or a full http(s) URL.
public enum ServerAddress {
    /// The port `tessera` listens on unless started with `-addr`.
    public static let defaultPort = 7331

    public enum Problem: Error, Equatable, CustomStringConvertible {
        case empty
        case unsupportedScheme(String)
        case missingHost
        case invalid

        public var description: String {
            switch self {
            case .empty: "Enter the address of a Tessera server."
            case .unsupportedScheme(let scheme): "Tessera addresses use http or https, not \(scheme)."
            case .missingHost: "The address needs a host name or IP address."
            case .invalid: "That is not a valid address."
            }
        }
    }

    /// Without a scheme the address is plain HTTP, as Tessera serves by
    /// default, on port 7331 unless it names a port. With `http://` or
    /// `https://` it is used as written, so a reverse proxy on 443 works.
    public static func parse(_ text: String) -> Result<URL, Problem> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.empty) }
        // `studio:8080` would otherwise parse as scheme "studio".
        let hasScheme = trimmed.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) != nil
        guard var components = URLComponents(string: hasScheme ? trimmed : "http://" + trimmed) else {
            return .failure(.invalid)
        }
        let scheme = components.scheme?.lowercased() ?? ""
        guard scheme == "http" || scheme == "https" else { return .failure(.unsupportedScheme(scheme)) }
        guard let host = components.host, !host.isEmpty else { return .failure(.missingHost) }
        components.scheme = scheme
        if !hasScheme && components.port == nil { components.port = defaultPort }
        if components.path.isEmpty { components.path = "/" }
        guard let url = components.url else { return .failure(.invalid) }
        return .success(url)
    }

    /// Whether two URLs share scheme, host and port. Navigation that leaves
    /// the server's origin opens in the system browser instead of the app.
    public static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard let schemeA = a.scheme?.lowercased(), let schemeB = b.scheme?.lowercased(),
              let hostA = a.host?.lowercased(), let hostB = b.host?.lowercased()
        else { return false }
        return schemeA == schemeB && hostA == hostB && effectivePort(a) == effectivePort(b)
    }

    static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}
