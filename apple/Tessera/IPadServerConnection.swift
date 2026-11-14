#if os(iOS)
import SwiftUI
import WebKit
import Security
import TesseraCore

/// A native, scene-local decision. No system trust settings are modified.
@Observable @MainActor
final class IPadCertificateConsent {
    @ObservationIgnored weak var window: UIWindow?
    private(set) var presenting = false
    @ObservationIgnored var onPresent: (() -> Void)?
    private var alert: UIAlertController?
    private var reply: CheckedContinuation<Bool, Never>?
    private var owner: UUID?

    func cancel(owner: UUID? = nil) {
        guard owner == nil || self.owner == owner else { return }
        finish(false)
    }

    private func finish(_ accepted: Bool) {
        let reply = reply
        self.reply = nil; owner = nil
        alert?.dismiss(animated: false); alert = nil
        presenting = false
        reply?.resume(returning: accepted)
    }

    private func ask(url: URL, fingerprint: String, previous: String?, authority: String?, reason: String, owner: UUID,
                     current: @escaping @MainActor () -> Bool) async -> Bool {
        guard !Task.isCancelled, current(), reply == nil,
              let window, window.windowScene?.activationState == .foregroundActive,
              var presenter = window.rootViewController else { return false }
        while let presented = presenter.presentedViewController { presenter = presented }
        guard !presenter.isBeingDismissed else { return false }
        let changed = previous != nil && previous != fingerprint
        let formatted = ServerCertificatePin.formatted(fingerprint)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled, current() else { continuation.resume(returning: false); return }
                self.owner = owner; reply = continuation
                onPresent?(); presenting = true
                let place = "\(url.host ?? "Server"):\(url.port ?? 443)\n\n\(reason)"
                let differs = changed ? "This differs from the certificate you accepted. " : ""
                let alert = authority.map { name in
                    UIAlertController(title: changed ? "Certificate Authority Changed" : "Server Certificate Authority",
                        message: "\(place)\n\nThe server offers its certificate authority:\n\(name)\n\nSHA-256\n\(formatted)\n\n\(differs)Verify this fingerprint against the server's Local HTTPS settings before trusting it. Tessera then accepts certificates this authority issues for this server profile only, not for other sites or apps.", preferredStyle: .alert)
                } ?? UIAlertController(title: changed ? "Certificate Changed" : "Server Certificate",
                    message: "\(place)\n\nSHA-256\n\(formatted)\n\n\(differs)Verify this fingerprint with the server owner before accepting. Acceptance is saved only for this server profile, not for other sites or apps.", preferredStyle: .alert)
                alert.view.accessibilityIdentifier = "certificate-review"
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.finish(false) })
                alert.addAction(UIAlertAction(title: authority == nil ? "Accept Certificate" : "Trust Certificate Authority",
                    style: .default) { [weak self] _ in self?.finish(current()) })
                self.alert = alert
                presenter.present(alert, animated: true)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(owner: owner) }
        }
    }

    func answer(_ challenge: URLAuthenticationChallenge, url: URL, pin: ServerCertificatePin?, owner: UUID, allowPrompt: Bool = true,
                current: @escaping @MainActor () -> Bool) async -> (URLSession.AuthChallengeDisposition, URLCredential?, ServerCertificatePin?) {
        let space = challenge.protectionSpace
        func normalized(_ host: String) -> String { host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")) }
        guard current(), !Task.isCancelled, challenge.previousFailureCount == 0,
              space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              url.scheme == "https", space.protocol == "https",
              normalized(space.host) == normalized(url.host ?? ""), space.port == (url.port ?? 443),
              let trust = space.serverTrust else {
            return (.cancelAuthenticationChallenge, nil, nil)
        }
        let certificates = await Self.certificateData(challenge)
        guard let leaf = certificates.first, current(), !Task.isCancelled else { return (.cancelAuthenticationChallenge, nil, nil) }
        let fingerprint = ServerCertificatePin.fingerprint(leaf)
        let scopedPin = pin?.applies(to: url) == true ? pin : nil
        if let authority = scopedPin?.authority {
            // Only the saved authority counts, not system roots, and the
            // usual hostname and validity checks still apply.
            if await Self.evaluate(certificates, host: space.host, anchor: authority).0 {
                guard current(), !Task.isCancelled else { return (.cancelAuthenticationChallenge, nil, nil) }
                return (.useCredential, URLCredential(trust: trust), scopedPin)
            }
        } else if scopedPin?.accepts(url: url, sha256: fingerprint) == true {
            return (.useCredential, URLCredential(trust: trust), scopedPin)
        }
        // Use a fresh trust object: a framework's cached exception must not
        // accidentally approve the same certificate for another profile/port.
        let (trusted, validationProblem) = await Self.evaluate(certificates, host: space.host)
        guard current(), !Task.isCancelled else { return (.cancelAuthenticationChallenge, nil, nil) }
        if trusted && scopedPin == nil { return (.performDefaultHandling, nil, nil) }
        guard allowPrompt else { return (.cancelAuthenticationChallenge, nil, nil) }
        // Tessera's Local HTTPS sends its root after the leaf. Trusting that
        // authority survives the leaf's monthly renewal; servers that send no
        // issuer keep the leaf approval.
        var authority: Data?
        for candidate in certificates.dropFirst().reversed() where authority == nil {
            if await Self.evaluate(certificates, host: space.host, anchor: candidate).0 { authority = candidate }
        }
        guard current(), !Task.isCancelled else { return (.cancelAuthenticationChallenge, nil, nil) }
        let approvedFingerprint = authority.map(ServerCertificatePin.fingerprint) ?? fingerprint
        let reason = scopedPin != nil
            ? "This server is presenting a different certificate. " + (trusted ? "It passes system validation but does not match what you accepted." : validationProblem)
            : validationProblem
        let accepted = await ask(url: url, fingerprint: approvedFingerprint, previous: scopedPin?.sha256,
            authority: authority.flatMap(Self.subject), reason: reason, owner: owner, current: current)
        guard accepted, current(), !Task.isCancelled,
              let approved = ServerCertificatePin(url: url, sha256: approvedFingerprint, authority: authority) else {
            return (.cancelAuthenticationChallenge, nil, nil)
        }
        return (.useCredential, URLCredential(trust: trust), approved)
    }

    nonisolated private static func certificateData(_ challenge: URLAuthenticationChallenge) async -> [Data] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let trust = challenge.protectionSpace.serverTrust,
                      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else {
                    continuation.resume(returning: []); return
                }
                continuation.resume(returning: chain.map { SecCertificateCopyData($0) as Data })
            }
        }
    }

    nonisolated static func subject(_ der: Data) -> String? {
        SecCertificateCreateWithData(nil, der as CFData).flatMap { SecCertificateCopySubjectSummary($0) as String? }
    }

    /// Evaluates against system trust, or against `anchor` alone when given.
    nonisolated private static func evaluate(_ certificates: [Data], host: String, anchor: Data? = nil) async -> (Bool, String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let chain = certificates.compactMap { SecCertificateCreateWithData(nil, $0 as CFData) }
                var trust: SecTrust?
                let policy = SecPolicyCreateSSL(true, host as CFString)
                guard SecTrustCreateWithCertificates(chain as CFArray, policy, &trust) == errSecSuccess, let trust else {
                    continuation.resume(returning: (false, "iPadOS could not verify this certificate.")); return
                }
                if let anchor {
                    guard let root = SecCertificateCreateWithData(nil, anchor as CFData),
                          SecTrustSetAnchorCertificates(trust, [root] as CFArray) == errSecSuccess,
                          SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else {
                        continuation.resume(returning: (false, "iPadOS could not verify this certificate.")); return
                    }
                }
                var error: CFError?
                let valid = SecTrustEvaluateWithError(trust, &error)
                continuation.resume(returning: (valid, (error as Error?)?.localizedDescription ?? "iPadOS could not verify this certificate."))
            }
        }
    }
}

struct IPadCertificateAnchor: UIViewRepresentable {
    let consent: IPadCertificateConsent
    func makeUIView(context: Context) -> Anchor { Anchor(consent: consent) }
    func updateUIView(_ view: Anchor, context: Context) {}
    final class Anchor: UIView {
        let consent: IPadCertificateConsent
        init(consent: IPadCertificateConsent) { self.consent = consent; super.init(frame: .zero); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() { super.didMoveToWindow(); if let window { consent.window = window } }
    }
}

/// Each attempt owns an ephemeral, cookie/credential/cache-free session.
/// HEAD probes establish transport availability without loading a login page.
@MainActor
final class IPadConnectionAttempt: NSObject, @preconcurrency URLSessionTaskDelegate {
    let id = UUID()
    private let consent: IPadCertificateConsent
    private var session: URLSession?
    private var url: URL?
    private var pin: ServerCertificatePin?
    private(set) var cancelled = false
    private var certificateSeen = false
    private var pendingChallenge: URLAuthenticationChallenge?
    private let current: @MainActor () -> Bool

    init(consent: IPadCertificateConsent, current: @escaping @MainActor () -> Bool) {
        self.consent = consent; self.current = current
    }

    func cancel() { cancelled = true; session?.invalidateAndCancel(); consent.cancel(owner: id) }

    func resolve(_ candidates: [URL], pin: ServerCertificatePin?) async throws -> (URL, ServerCertificatePin?) {
        guard !candidates.isEmpty else { throw URLError(.badURL) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 4; configuration.timeoutIntervalForResource = 8
        configuration.waitsForConnectivity = false
        defer { self.session = nil; consent.cancel(owner: id) }
        candidatesLoop: for (index, candidate) in candidates.enumerated() {
            try Task.checkCancellation()
            guard !cancelled, current() else { throw CancellationError() }
            url = candidate; self.pin = pin?.applies(to: candidate) == true ? pin : nil
            var parts = URLComponents(url: candidate, resolvingAgainstBaseURL: false)!
            parts.path = "/api/health"; parts.query = nil; parts.fragment = nil
            var request = URLRequest(url: parts.url!, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 4)
            request.httpMethod = "HEAD"; request.httpShouldHandleCookies = false
            var decisions = 0
            while true {
                certificateSeen = false; pendingChallenge = nil
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
                self.session = session
                defer { session.invalidateAndCancel() }
                do {
                    let (_, response) = try await session.data(for: request)
                    try Task.checkCancellation()
                    guard !cancelled, current(), response is HTTPURLResponse else { throw CancellationError() }
                    return (candidate, self.pin)
                } catch {
                    guard !cancelled, current(), !Task.isCancelled else { throw CancellationError() }
                    if let challenge = pendingChallenge, decisions < 2 {
                        // End the failed network request before asking a person.
                        // Network deadlines must not time out certificate review.
                        session.invalidateAndCancel(); self.session = nil
                        let result = await consent.answer(challenge, url: candidate, pin: self.pin, owner: id,
                            current: { [weak self = self] in self.map { !$0.cancelled && $0.current() } ?? false })
                        guard !cancelled, current(), !Task.isCancelled else { throw CancellationError() }
                        guard result.0 != .cancelAuthenticationChallenge else { throw URLError(.userCancelledAuthentication) }
                        if let approved = result.2 { self.pin = approved }
                        decisions += 1
                        continue // Fresh TLS connection checks the approved pin again.
                    }
                    if index + 1 < candidates.count && !certificateSeen && IPadServerAddress.permitsHTTPFallback(error) { continue candidatesLoop }
                    let failure = error as NSError
                    throw NSError(domain: failure.domain, code: failure.code, userInfo: [
                        NSLocalizedDescriptionKey: "Could not reach \(candidate.scheme ?? "server")://\(candidate.host ?? "server"):\(candidate.port ?? 0): \(failure.localizedDescription)",
                        NSUnderlyingErrorKey: failure,
                    ])
                }
            }
        }
        throw URLError(.cannotConnectToHost)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil) // No redirects, including same-origin login redirects, during discovery.
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        answer(challenge, from: session, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        answer(challenge, from: session, completionHandler: completionHandler)
    }

    private func answer(_ challenge: URLAuthenticationChallenge, from session: URLSession,
                        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        certificateSeen = true
        guard let url, self.session === session, !cancelled, current() else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        Task { @MainActor [self] in
            let result = await consent.answer(challenge, url: url, pin: pin, owner: id,
                allowPrompt: false,
                current: { [weak self] in self.map { $0.session === session && !$0.cancelled && $0.current() } ?? false })
            guard self.session === session, !cancelled, current() else { completionHandler(.cancelAuthenticationChallenge, nil); return }
            if result.0 == .cancelAuthenticationChallenge && challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
                pendingChallenge = challenge
            }
            if let approved = result.2 { pin = approved }
            completionHandler(result.0, result.1)
        }
    }
}
#endif
