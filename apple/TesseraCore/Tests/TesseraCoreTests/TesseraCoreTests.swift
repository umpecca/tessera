import Foundation
import Testing
@testable import TesseraCore

@Suite struct ServerAddressTests {
    func parsed(_ text: String) -> String? {
        try? ServerAddress.parse(text).get().absoluteString
    }

    @Test func bareHostsAreHTTPOnTesserasPort() {
        #expect(parsed("studio") == "http://studio:7331/")
        #expect(parsed("  100.64.0.2 \n") == "http://100.64.0.2:7331/")
        #expect(parsed("studio.tail1234.ts.net") == "http://studio.tail1234.ts.net:7331/")
        #expect(parsed("[fd7a:115c::1]") == "http://[fd7a:115c::1]:7331/")
    }

    @Test func aGivenPortOrSchemeIsKept() {
        #expect(parsed("studio:8080") == "http://studio:8080/")
        #expect(parsed("https://tessera.example.com") == "https://tessera.example.com/")
        #expect(parsed("HTTP://Studio:7331/?session=work") == "http://Studio:7331/?session=work")
    }

    @Test func rejectsWhatIsNotATesseraAddress() {
        #expect(throws: ServerAddress.Problem.empty) { try ServerAddress.parse("   ").get() }
        #expect(throws: ServerAddress.Problem.unsupportedScheme("ftp")) { try ServerAddress.parse("ftp://studio").get() }
        #expect(throws: ServerAddress.Problem.missingHost) { try ServerAddress.parse("http://").get() }
        #expect(throws: ServerAddress.Problem.invalid) { try ServerAddress.parse("studio:port").get() }
    }

    @Test func comparesOriginsWithDefaultPorts() {
        let server = URL(string: "http://studio:7331/")!
        #expect(ServerAddress.sameOrigin(server, URL(string: "http://STUDIO:7331/api/x")!))
        #expect(!ServerAddress.sameOrigin(server, URL(string: "http://studio:8080/")!))
        #expect(!ServerAddress.sameOrigin(server, URL(string: "https://studio:7331/")!))
        #expect(ServerAddress.sameOrigin(URL(string: "https://a.example")!, URL(string: "https://a.example:443/x")!))
        #expect(!ServerAddress.sameOrigin(server, URL(string: "about:blank")!))
    }
}

@Suite struct DownloadDestinationTests {
    func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func numbersNamesThatAreTaken() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(DownloadDestination.url(in: directory, suggestedFilename: "log.txt").lastPathComponent == "log.txt")
        FileManager.default.createFile(atPath: directory.appendingPathComponent("log.txt").path, contents: Data())
        #expect(DownloadDestination.url(in: directory, suggestedFilename: "log.txt").lastPathComponent == "log 2.txt")
        FileManager.default.createFile(atPath: directory.appendingPathComponent("log 2.txt").path, contents: Data())
        #expect(DownloadDestination.url(in: directory, suggestedFilename: "log.txt").lastPathComponent == "log 3.txt")
        FileManager.default.createFile(atPath: directory.appendingPathComponent("Makefile").path, contents: Data())
        #expect(DownloadDestination.url(in: directory, suggestedFilename: "Makefile").lastPathComponent == "Makefile 2")
    }

    @Test func keepsNamesInsideTheDirectory() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let escaped = DownloadDestination.url(in: directory, suggestedFilename: "../../etc/passwd")
        #expect(escaped.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL)
        #expect(escaped.lastPathComponent == "passwd")
        #expect(DownloadDestination.url(in: directory, suggestedFilename: " ").lastPathComponent == "Download")
        #expect(DownloadDestination.url(in: directory, suggestedFilename: "..").lastPathComponent == "Download")
    }
}
