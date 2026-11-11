import Foundation
import Testing
@testable import TesseraCore

@Suite struct ClipboardPolicyTests {
    let server = URL(string: "http://studio:7331/")!

    @Test func limitsAccessToActiveSelectedOriginAndMainAppFrame() {
        func allowed(document: String = "http://studio:7331/", frame: String = "http://studio:7331/",
                     origin: String = "http://studio:7331/", main: Bool = true, active: Bool = true) -> Bool {
            ClipboardPolicy.allows(server: server, document: URL(string: document)!, frame: URL(string: frame)!,
                origin: URL(string: origin)!, isMainFrame: main, isActive: active)
        }
        #expect(allowed())
        #expect(allowed(document: "http://studio:7331/users/alice/sessions/session-1"))
        #expect(!allowed(main: false))
        #expect(!allowed(active: false))
        #expect(!allowed(origin: "http://other:7331/"))
        #expect(!allowed(origin: "https://studio:7331/"))
        #expect(!allowed(origin: "http://studio:8080/"))
        #expect(!allowed(document: "http://other:7331/"))
        #expect(!allowed(frame: "http://other:7331/"))
        #expect(!allowed(document: "http://studio:7331/api/browser-proxy/page"))
        #expect(!allowed(frame: "http://studio:7331/api/browser-proxy/page"))
        #expect(!allowed(document: "about:blank"))
    }

    @Test func appRoutesExcludeSameOriginProxiedAndDownloadedContent() {
        for path in ["/", "/m", "/m/", "/index.html", "/users/alice/sessions/id", "/users/alice/sessions/id/"] {
            #expect(ClipboardPolicy.isAppDocument(URL(string: "http://studio:7331\(path)")!))
        }
        for path in ["/browser-proxy/session/page", "/api/browser-proxy", "/api/host/files", "/extensions/help.html", "/assets/file.html",
                     "/users//sessions/id", "/users/alice/sessions/", "/users/alice/sessions/id/extra"] {
            #expect(!ClipboardPolicy.isAppDocument(URL(string: "http://studio:7331\(path)")!))
        }
    }

    @Test func rejectsInvalidAndOversizedImagePayloads() {
        #expect(ClipboardPolicy.imageData(Data([137, 80, 78, 71]).base64EncodedString()) == Data([137, 80, 78, 71]))
        #expect(ClipboardPolicy.imageData("") == nil)
        #expect(ClipboardPolicy.imageData("not base64!") == nil)
        #expect(ClipboardPolicy.imageData(String(repeating: "A", count: ((ClipboardPolicy.maxImageBytes + 2) / 3) * 4 + 4)) == nil)
    }
}
