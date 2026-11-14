#if os(iOS)
import SwiftUI
import Network
import os
import TesseraCore

/// Hands a configuration profile to Safari, the only app that offers to
/// install one it downloads. A short-lived loopback listener serves the
/// profile built from the CA this profile already trusts, so no HTTP request
/// to the server is needed, and a background task keeps it up while Safari
/// fetches it. The app never installs or trusts the CA itself.
@MainActor
final class IPadProfileHandoff {
    private var listener: NWListener?
    private var background = UIBackgroundTaskIdentifier.invalid
    private var expiry: Task<Void, Never>?

    func open(_ profile: Data) async throws {
        stop()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        let path = "/\(UUID().uuidString)/tessera-local-ca.mobileconfig"
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global(qos: .userInitiated))
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { data, _, _, _ in
                let line = data.flatMap { String(data: $0, encoding: .utf8) }?.prefix { $0 != "\r" } ?? ""
                let found = line.hasPrefix("GET \(path) ") || line.hasPrefix("HEAD \(path) ")
                let body = found && line.hasPrefix("GET") ? profile : Data()
                let head = found
                    ? "HTTP/1.1 200 OK\r\nContent-Type: application/x-apple-aspen-config\r\nContent-Disposition: attachment; filename=\"tessera-local-ca.mobileconfig\"\r\nContent-Length: \(profile.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
                    : "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let port = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            let pending = OSAllocatedUnfairLock<CheckedContinuation<UInt16, Error>?>(initialState: continuation)
            listener.stateUpdateHandler = { [weak listener] state in
                let result: Result<UInt16, Error>
                switch state {
                case .ready: result = (listener?.port?.rawValue).map { .success($0) } ?? .failure(URLError(.cannotConnectToHost))
                case .failed(let error): result = .failure(error)
                case .cancelled: result = .failure(CancellationError())
                default: return
                }
                pending.withLock { pending in defer { pending = nil }; return pending }?.resume(with: result)
            }
            listener.start(queue: .global(qos: .userInitiated))
        }
        guard self.listener === listener else { throw CancellationError() }
        background = UIApplication.shared.beginBackgroundTask(withName: "Tessera profile download") { [weak self] in
            MainActor.assumeIsolated { self?.stop() }
        }
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            if !Task.isCancelled { self?.stop() }
        }
        let address = URL(string: "http://127.0.0.1:\(port)\(path)")!
        // x-safari- picks Safari when another browser is the default; older
        // systems without it get the default browser.
        if !(await UIApplication.shared.open(URL(string: "x-safari-" + address.absoluteString)!)) {
            await UIApplication.shared.open(address)
        }
    }

    func stop() {
        expiry?.cancel(); expiry = nil
        listener?.cancel(); listener = nil
        if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
    }

    /// Whether iPadOS itself trusts the server, as Safari would: nil when the
    /// server can't be reached at all.
    static func systemTrusts(_ address: URL) async -> Bool? {
        var parts = URLComponents(url: address, resolvingAgainstBaseURL: false)!
        parts.path = "/api/health"; parts.query = nil; parts.fragment = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 4; configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: parts.url!, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 4)
        request.httpMethod = "HEAD"
        do {
            _ = try await session.data(for: request)
            return true
        } catch let error as URLError where [.serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateHasBadDate,
                                              .serverCertificateNotYetValid, .secureConnectionFailed].contains(error.code) {
            return false
        } catch {
            return nil
        }
    }
}

struct IPadSystemTrustView: View {
    let profile: ServerProfile
    let authority: Data
    @Environment(\.scenePhase) private var scenePhase
    @State private var handoff = IPadProfileHandoff()
    @State private var trusted: Bool??
    @State private var checking = false
    @State private var problem: String?

    private var name: String { IPadCertificateConsent.subject(authority) ?? "Tessera Root CA" }

    var body: some View {
        Form {
            Section {
                Text("Tessera already trusts this certificate authority for \(profile.displayName). Installing it in iPad Settings lets Safari and other apps open the server over HTTPS too.")
            }
            Section("Certificate authority") {
                Text(name).font(.headline)
                Text(ServerCertificatePin.formatted(ServerCertificatePin.fingerprint(authority)))
                    .font(.caption.monospaced()).textSelection(.enabled).accessibilityLabel("SHA-256 fingerprint")
                Text("This SHA-256 matches Tessera's Local HTTPS settings and the certificate's details in iPad Settings.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section("Steps") {
                Button("Download Profile in Safari", action: download).accessibilityIdentifier("system-trust-download")
                if let problem { Text(problem).foregroundStyle(.red) }
                Text("1. In Safari, allow the download, then come back to Tessera.")
                Text("2. In Settings → General → VPN & Device Management, choose \(name) and tap Install.")
                Text("3. In Settings → General → About → Certificate Trust Settings, turn on full trust for \(name). Installing alone is not enough.")
            }.font(.callout)
            Section("Status") {
                Group {
                    if checking { ProgressView("Checking…") }
                    else if trusted == true { Label("iPadOS trusts this server", systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
                    else if trusted == false { Label("Not trusted yet. If you installed the profile, turn on full trust (step 3).", systemImage: "exclamationmark.triangle") }
                    else if trusted != nil { Label("Could not reach the server to check.", systemImage: "wifi.exclamationmark") }
                }.accessibilityIdentifier("system-trust-status")
                Button("Check Again") { Task { await check() } }.disabled(checking)
            }
        }
        .navigationTitle("Trust in Safari & Other Apps")
        .task { await check() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await check() } } }
        .onDisappear { handoff.stop() }
    }

    private func download() {
        problem = nil
        Task {
            do { try await handoff.open(RootCertificateProfile.data(authority: authority, name: name)) }
            catch is CancellationError {}
            catch { problem = "Could not prepare the profile: \(error.localizedDescription)" }
        }
    }

    private func check() async {
        guard !checking else { return }
        checking = true
        trusted = .some(await IPadProfileHandoff.systemTrusts(profile.address))
        checking = false
    }
}
#endif
