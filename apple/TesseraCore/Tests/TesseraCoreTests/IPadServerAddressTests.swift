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
