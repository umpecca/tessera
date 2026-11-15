import Foundation
import Testing
@testable import TesseraCore

@Suite struct IPadServerAddressTests {
    func candidates(_ text: String) throws -> [String] { try IPadServerAddress.candidates(text).map(\.absoluteString) }

    @Test func bareHostsPreferHTTPSAndKeepPathsAndQueries() throws {
        #expect(try candidates(" studio/path?session=work#pane ") == ["https://studio:7332/path?session=work#pane", "http://studio:7331/path?session=work#pane"])
        #expect(try candidates("100.64.0.2") == ["https://100.64.0.2:7332/", "http://100.64.0.2:7331/"])
        #expect(try candidates("[fd7a:115c::1]") == ["https://[fd7a:115c::1]:7332/", "http://[fd7a:115c::1]:7331/"])
    }

    @Test func explicitSchemesAndPortsAreNeverSwitched() throws {
        #expect(try candidates("https://studio") == ["https://studio:7332/"])
        #expect(try candidates("http://studio") == ["http://studio:7331/"])
        #expect(try candidates("https://studio:443/proxy/") == ["https://studio:443/proxy/"])
        #expect(try candidates("studio:8080") == ["http://studio:8080/"])
        #expect(try candidates("https://[::1]:8443") == ["https://[::1]:8443/"])
        #expect(throws: ServerAddress.Problem.self) { try candidates("https://user:secret@studio") }
        #expect(throws: ServerAddress.Problem.self) { try candidates("studio:0") }
    }

    @Test func fallbackNeverMasksTLSCertificateOrCancellationErrors() {
        for code: URLError.Code in [.cannotConnectToHost, .timedOut, .networkConnectionLost, .cannotFindHost, .dnsLookupFailed] {
            #expect(IPadServerAddress.permitsHTTPFallback(URLError(code)))
        }
        for code: URLError.Code in [.serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
                                   .serverCertificateHasUnknownRoot, .secureConnectionFailed, .clientCertificateRejected,
                                   .cancelled, .userCancelledAuthentication, .badServerResponse, .httpTooManyRedirects] {
            #expect(!IPadServerAddress.permitsHTTPFallback(URLError(code)))
        }
        #expect(!IPadServerAddress.permitsHTTPFallback(CancellationError()))
    }

    /// The native connection check uses URLSession, which ATS covers. ATS only
    /// accepts system-trusted roots, so an approved Tessera CA or plain HTTP to
    /// a Tailscale name fails unless arbitrary loads are allowed, and any
    /// narrower ATS key makes iOS ignore that allowance.
    @Test func appTransportSecurityLeavesServerTrustToTheApp() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../Tessera-Info.plist").standardizedFileURL
        let plist = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        let ats = try #require(plist["NSAppTransportSecurity"] as? [String: Any])
        #expect(ats["NSAllowsArbitraryLoads"] as? Bool == true)
        #expect(Set(ats.keys) == ["NSAllowsArbitraryLoads"])
    }

    @Test func certificatePinsRequireExactHTTPSOriginAndFingerprint() throws {
        let url = URL(string: "https://Studio:7332/")!
        let sha = String(repeating: "ab", count: 32)
        let pin = try #require(ServerCertificatePin(url: url, sha256: sha.uppercased()))
        #expect(pin.accepts(url: URL(string: "https://studio:7332/api/health")!, sha256: sha))
        #expect(!pin.accepts(url: url, sha256: String(repeating: "cd", count: 32)))
        for other in ["https://studio:8443/", "https://other:7332/", "http://studio:7332/", "https://studio/"] {
            #expect(!pin.applies(to: URL(string: other)!))
        }
        #expect(ServerCertificatePin(url: URL(string: "http://studio:7332/")!, sha256: sha) == nil)
        #expect(ServerCertificatePin(url: url, sha256: "not a fingerprint") == nil)
        let ipv6 = try #require(ServerCertificatePin(url: URL(string: "https://[::1]:7332/")!, sha256: sha))
        #expect(ipv6.accepts(url: URL(string: "https://[::1]:7332/a")!, sha256: sha))
    }

    @Test func authorityPinsMatchTheirCertificateAndNeverAcceptALeafFingerprint() throws {
        let url = URL(string: "https://studio:7332/")!
        let authority = Data("tessera root".utf8)
        let sha = ServerCertificatePin.fingerprint(authority)
        let pin = try #require(ServerCertificatePin(url: url, sha256: sha.uppercased(), authority: authority))
        #expect(pin.sha256 == sha && pin.applies(to: url) && !pin.applies(to: URL(string: "https://studio:8443/")!))
        #expect(!pin.accepts(url: url, sha256: sha))
        #expect(ServerCertificatePin.formatted("ab01cd") == "AB:01:CD")
        #expect(ServerCertificatePin(url: url, sha256: String(repeating: "ab", count: 32), authority: authority) == nil)

        var library = ServerProfiles()
        library.save(name: "Studio", address: url, certificatePin: pin)
        let loaded = ServerProfiles.load(try JSONEncoder().encode(library), legacyAddress: "")
        #expect(loaded.selected?.certificatePin == pin)
        // A stored authority that no longer matches its approved fingerprint is dropped.
        let tampered = String(decoding: try JSONEncoder().encode(library), as: UTF8.self)
            .replacingOccurrences(of: authority.base64EncodedString(), with: Data("other root".utf8).base64EncodedString())
        #expect(ServerProfiles.load(Data(tampered.utf8), legacyAddress: "").selected?.certificatePin == nil)
    }

    @Test func rootProfileMatchesTheServersIdentifiersAndCarriesTheAuthority() throws {
        // internal/localhttps TestRootProfileCarriesTheRootWithFingerprintIdentifiers uses the same values.
        let ids = RootCertificateProfile.identifiers(Data("tessera root".utf8))
        #expect(ids.identifier == "org.tessera.local-https.f6085ea44df860f8")
        #expect(ids.profileUUID == "F6085EA4-4DF8-80F8-8382-1BC66279299C")
        #expect(ids.certificateUUID == "B09F7A32-7104-8DBC-8557-9C7737335650")
        let authority = Data("tessera root".utf8)
        let data = try RootCertificateProfile.data(authority: authority, name: "Tessera studio Root CA")
        let profile = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        #expect(profile["PayloadType"] as? String == "Configuration" && profile["PayloadUUID"] as? String == ids.profileUUID)
        let payload = try #require((profile["PayloadContent"] as? [[String: Any]])?.first)
        #expect(payload["PayloadType"] as? String == "com.apple.security.root")
        #expect(payload["PayloadContent"] as? Data == authority && payload["PayloadDisplayName"] as? String == "Tessera studio Root CA")
    }

    @Test func pinsPersistPerProfileAndForgetOrOriginChangeDoesNotReuseThem() throws {
        let url = URL(string: "https://studio:7332/")!
        let pin = try #require(ServerCertificatePin(url: url, sha256: String(repeating: "ab", count: 32)))
        var library = ServerProfiles()
        library.save(name: "Studio", address: url, certificatePin: pin)
        let first = try #require(library.selected)
        var loaded = ServerProfiles.load(try JSONEncoder().encode(library), legacyAddress: "")
        #expect(loaded.selected?.certificatePin == pin)
        loaded.save(name: "Renamed", address: url, editing: first.id)
        #expect(loaded.selected?.id == first.id && loaded.selected?.certificatePin == pin)
        loaded.forgetCertificate(first.id)
        #expect(loaded.selected?.certificatePin == nil)
        #expect(library.selected?.certificatePin == pin)
        library.save(name: "Other", address: URL(string: "https://studio:8443/")!, editing: first.id, certificatePin: pin)
        #expect(library.selected?.id != first.id && library.selected?.certificatePin == nil)
        // Old profiles have no pin, and their original 443/80 URLs are not rewritten.
        let old = """
        {"profiles":[{"id":"\(first.id.uuidString)","name":"Old","address":"https://studio/","usesLegacyDataStore":false}],"selectedID":"\(first.id.uuidString)"}
        """
        let migrated = ServerProfiles.load(Data(old.utf8), legacyAddress: "")
        #expect(migrated.selected?.address.absoluteString == "https://studio/")
        #expect(migrated.selected?.certificatePin == nil)
        #expect(try ServerAddress.parse("https://studio").get().port == nil)
        #expect(try IPadServerAddress.candidates("https://studio/", preserving: migrated.selected?.address).map(\.absoluteString) == ["https://studio/"])
        let oldHTTP = URL(string: "http://studio/")!
        #expect(try IPadServerAddress.candidates("http://studio/", preserving: oldHTTP) == [oldHTTP])
        #expect(try IPadServerAddress.candidates("studio", preserving: URL(string: "http://studio:7331/")!).first?.absoluteString == "https://studio:7332/")
    }
}
