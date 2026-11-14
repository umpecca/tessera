import SwiftUI
import TesseraCore
import WebKit

/// The Tessera web client in a WKWebView. A web view in an app leaves to the
/// app what Safari would do itself: JavaScript dialogs (Tessera confirms
/// before closing a terminal), file pickers on the Mac, downloads (terminal
/// file transfers), and links that leave the server.
struct TesseraWebView {
    let url: URL
    let reloadCount: Int
    let onFailure: (String) -> Void
    let onLoad: () -> Void
    #if os(iOS)
    var app: IPadAppModel? = nil
    var connectionActive = true
    #endif

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    fileprivate func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Keeps Tessera's sign-in cookie and settings between launches.
        configuration.websiteDataStore = .default()
        #if os(iOS)
        if let profile = app?.selected, !profile.usesLegacyDataStore {
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profile.id)
        }
        #endif
        // Terminal audio plays as it arrives, as it does once Safari has
        // seen a tap.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Lets the page tell the app from Safari (Settings → Diagnostics).
        configuration.applicationNameForUserAgent = "TesseraApp/\(Bundle.main.shortVersion)"
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop
        configuration.userContentController.addUserScript(WKUserScript(source: "window.tesseraNativeDevice = 'ipad';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let hasAppModel = app != nil
        let clipboard = NativeClipboard(server: { [weak coordinator] in coordinator?.clipboardServerURL },
            isUnlocked: { [weak app] in !hasAppModel || app?.privacy.allowsAccess == true })
        coordinator.nativeClipboard = clipboard
        configuration.userContentController.addScriptMessageHandler(clipboard, contentWorld: .page, name: NativeClipboard.handlerName)
        #endif
        #if os(iOS)
        let webView = IPadWebView(frame: .zero, configuration: configuration)
        webView.nativeClipboard = coordinator.nativeClipboard
        webView.onCommand = { [weak app] command in app?.shortcut(command) }
        app?.webView = webView
        webView.isUserInteractionEnabled = app?.privacy.allowsAccess ?? true
        #else
        let webView = WKWebView(frame: .zero, configuration: configuration)
        #endif
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        // Safari's Develop menu can inspect the page, as with Safari itself.
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = false
        #if os(iOS)
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        coordinator.show(self, in: webView)
        return webView
    }

    fileprivate func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.show(self, in: webView)
    }
}

#if os(iOS)
extension TesseraWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
    func updateUIView(_ webView: WKWebView, context: Context) { updateWebView(webView, coordinator: context.coordinator) }
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.cancelConnection()
        coordinator.nativeClipboard?.invalidate()
        coordinator.cancelNativeDownloads()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: NativeClipboard.handlerName, contentWorld: .page)
        webView.stopLoading()
    }
}
#else
extension TesseraWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
    func updateNSView(_ webView: WKWebView, context: Context) { updateWebView(webView, coordinator: context.coordinator) }
}
#endif

extension TesseraWebView {
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        private var parent: TesseraWebView
        private var shownURL: URL?
        private var shownReloadCount = 0
        var clipboardServerURL: URL { parent.url }
        #if os(iOS)
        var nativeClipboard: NativeClipboard?
        private var connectionTask: Task<Void, Never>?
        private var connectionAttempt: IPadConnectionAttempt?
        private var trustOwner = UUID()
        private var mainTrustURL: URL?
        private var pendingCertificatePin: (profileID: UUID, pin: ServerCertificatePin, previous: ServerCertificatePin?, owner: UUID)?
        #endif

        init(_ parent: TesseraWebView) {
            self.parent = parent
        }

        /// Loads a new server, or reloads when asked to.
        func show(_ view: TesseraWebView, in webView: WKWebView) {
            parent = view
            let newURL = shownURL != view.url
            #if os(iOS)
            guard view.connectionActive else { return }
            let interrupted = connectionAttempt?.cancelled == true
            #else
            let interrupted = false
            #endif
            guard newURL || shownReloadCount != view.reloadCount || interrupted else { return }
            shownURL = view.url; shownReloadCount = view.reloadCount
            #if os(iOS)
            cancelConnection()
            trustOwner = UUID()
            if let app = view.app, view.url.scheme == "https", let profile = app.selected {
                let owner = trustOwner, reload = view.reloadCount
                let current: @MainActor () -> Bool = { [weak self, weak app, weak webView] in
                    guard let self, let app, webView != nil else { return false }
                    return self.trustOwner == owner && self.shownReloadCount == reload
                        && app.selected?.id == profile.id && app.selected?.address == view.url
                        && app.recovery.active && app.privacy.allowsAccess && !app.privacy.covered
                }
                let attempt = app.connectionAttempt(current: current)
                connectionAttempt = attempt
                connectionTask = Task { @MainActor [weak self, weak webView] in
                    defer { app.finishConnection(attempt) }
                    do {
                        // A fresh ephemeral preflight checks pins even if WebKit
                        // has a cached TLS session after forgetting an approval.
                        let (_, pin) = try await attempt.resolve([view.url], pin: profile.certificatePin)
                        guard current(), !Task.isCancelled, let self, let webView else { return }
                        if let pin { app.rememberCertificate(pin, profileID: profile.id) }
                        self.mainTrustURL = view.url
                        self.load(view, in: webView, newURL: newURL)
                    } catch {
                        guard current(), !Task.isCancelled else { return }
                        self?.report(error, includingCancellation: true)
                    }
                }
                return
            }
            mainTrustURL = view.url
            #endif
            load(view, in: webView, newURL: newURL)
        }

        private func load(_ view: TesseraWebView, in webView: WKWebView, newURL: Bool) {
            if newURL || webView.url == nil { webView.load(URLRequest(url: view.url)) }
            else { webView.reload() }
        }

        #if os(iOS)
        func cancelConnection() {
            connectionTask?.cancel(); connectionTask = nil
            if let connectionAttempt { connectionAttempt.cancel(); parent.app?.finishConnection(connectionAttempt) }
            connectionAttempt = nil
            parent.app?.certificateConsent.cancel(owner: trustOwner)
            mainTrustURL = nil
            pendingCertificatePin = nil
        }

        func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let app = parent.app, let profile = app.selected,
                  profile.address == parent.url else { return (.performDefaultHandling, nil) }
            let host = challenge.protectionSpace.host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
            guard parent.url.scheme == "https", host == parent.url.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased(),
                  challenge.protectionSpace.port == (parent.url.port ?? 443) else {
                return (.performDefaultHandling, nil)
            }
            let owner = trustOwner, savedPin = profile.certificatePin
            let pin = pendingCertificatePin.flatMap { $0.owner == owner && $0.profileID == profile.id ? $0.pin : nil } ?? savedPin
            let current: @MainActor () -> Bool = { [weak self, weak app] in
                guard let self, let app else { return false }
                return self.trustOwner == owner && app.selected?.id == profile.id
                    && app.selected?.address == profile.address && app.selected?.certificatePin == savedPin
                    && app.recovery.active && app.privacy.allowsAccess && !app.privacy.covered
            }
            let result = await app.certificateConsent.answer(challenge, url: profile.address, pin: pin,
                owner: owner, allowPrompt: mainTrustURL != nil, current: current)
            guard current() else { return (.cancelAuthenticationChallenge, nil) }
            if let approved = result.2, approved != profile.certificatePin {
                pendingCertificatePin = (profile.id, approved, savedPin, owner)
            }
            return (result.0, result.1)
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { mainTrustURL = nil }
        #endif

        // MARK: Navigation

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            #if os(iOS)
            nativeClipboard?.invalidate()
            #endif
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.shouldPerformDownload { return .download }
            guard let url = action.request.url else { return .cancel }
            // Frames inside the page (browser panes, download targets) load
            // whatever the page gives them.
            guard action.targetFrame?.isMainFrame ?? true else { return .allow }
            #if os(iOS)
            // Only a selected server's top-level entry/app/login navigation may
            // trigger a new consent prompt. Other origins use platform trust.
            mainTrustURL = ServerAddress.sameOrigin(url, parent.url)
                && (url == parent.url || ClipboardPolicy.isAppDocument(url) || url.path == "/login" || url.path == "/login/link") ? url : nil
            #endif
            if ServerAddress.sameOrigin(url, parent.url) || url.scheme == "about" { return .allow }
            Platform.openExternally(url)
            return .cancel
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
            let attachment = disposition?.lowercased().hasPrefix("attachment") ?? false
            return attachment || !response.canShowMIMEType ? .download : .allow
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            #if os(iOS)
            if let pending = pendingCertificatePin, let app = parent.app, pending.owner == trustOwner,
               app.selected?.id == pending.profileID, app.selected?.certificatePin == pending.previous,
               app.recovery.active, app.privacy.allowsAccess, !app.privacy.covered {
                app.rememberCertificate(pending.pin, profileID: pending.profileID)
            }
            pendingCertificatePin = nil
            #endif
            parent.onLoad()
            #if os(iOS)
            parent.app?.configureRendering()
            parent.app?.resumeWorkspace(restoringFocus: true)
            #endif
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error, includingCancellation: Bool = false) {
            let error = error as NSError
            // A cancelled load, or one that turned into a download, is not a
            // failure to reach the server.
            if !includingCancellation && error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
            if error.domain == WKError.errorDomain && error.code == 102 { return } // frame load interrupted
            #if os(iOS)
            pendingCertificatePin = nil; mainTrustURL = nil
            parent.app?.failure = ConnectionAdvice(errorCode: error.code, description: error.localizedDescription)
            #endif
            parent.onFailure(error.localizedDescription)
        }

        /// WebKit ended the page's process (memory pressure, a crash). Tessera
        /// restores terminals from the server on reload.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            #if os(iOS)
            if let app = parent.app { app.processTerminated(); return }
            #endif
            webView.reload()
        }

        // MARK: Windows and dialogs

        /// `window.open` and target=_blank: Tessera opens other sites there,
        /// such as a browser pane's page, so they go to the system browser.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased()) {
                Platform.openExternally(url)
            }
            return nil
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo) async {
            _ = await Platform.ask(message, in: webView, confirm: nil)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo) async -> Bool {
            await Platform.ask(message, in: webView, confirm: "OK")
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
            await Platform.prompt(prompt, defaultText: defaultText ?? "", in: webView)
        }

        #if os(macOS)
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                     initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
            await Platform.chooseFiles(multiple: parameters.allowsMultipleSelection,
                                       directories: parameters.allowsDirectories, in: webView)
        }
        #endif

        // MARK: Downloads

        private weak var webView: WKWebView?
        private var destinations: [ObjectIdentifier: URL] = [:]
        #if os(iOS)
        private var downloadItems: [ObjectIdentifier: IPadDownload] = [:]
        func cancelNativeDownloads() {
            for item in Array(downloadItems.values) { item.cancel?() }
        }
        #endif

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String) async -> URL? {
            webView = download.webView ?? webView
            let destination = DownloadDestination.url(in: Platform.downloadsDirectory, suggestedFilename: suggestedFilename, reservedPaths: Set(destinations.values.map(\.path)))
            destinations[ObjectIdentifier(download)] = destination
            #if os(iOS)
            if let app = parent.app {
                let item = IPadDownload(name: destination.lastPathComponent)
                let downloadID = ObjectIdentifier(download)
                item.cancel = { [weak self, weak download, weak item] in
                    download?.cancel { _ in }
                    item?.status = "Cancelled"
                    item?.cancel = nil
                    item?.observation = nil
                    self?.downloadItems.removeValue(forKey: downloadID)
                    if let file = self?.destinations.removeValue(forKey: downloadID) { try? FileManager.default.removeItem(at: file) }
                }
                item.observation = download.progress.observe(\.fractionCompleted, options: [.initial, .new]) { [weak item] progress, _ in
                    let fraction = progress.fractionCompleted, received = progress.completedUnitCount, total = progress.totalUnitCount
                    Task { @MainActor in item?.fraction = fraction; item?.received = received; item?.total = total }
                }
                downloadItems[ObjectIdentifier(download)] = item
                app.downloads.insert(item, at: 0)
            }
            #endif
            return destination
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
            #if os(iOS)
            if let item = downloadItems.removeValue(forKey: ObjectIdentifier(download)) {
                item.observation = nil; item.cancel = nil; item.file = destination
                item.fraction = 1; item.status = "Saved"
                parent.app?.notifyDownload(destination.lastPathComponent)
                return
            }
            if parent.app != nil { return }
            #endif
            Platform.downloadFinished(destination, in: download.webView ?? webView)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            let destination = destinations.removeValue(forKey: ObjectIdentifier(download))
            #if os(iOS)
            if let item = downloadItems.removeValue(forKey: ObjectIdentifier(download)) {
                item.observation = nil; item.cancel = nil
                let cancelled = (error as NSError).code == NSURLErrorCancelled
                item.status = cancelled ? "Cancelled" : "Failed"
                item.error = cancelled ? nil : error.localizedDescription
                if let destination { try? FileManager.default.removeItem(at: destination) }
                return
            }
            if parent.app != nil { return }
            #endif
            guard let webView = download.webView ?? webView else { return }
            Task { _ = await Platform.ask("Download failed: \(error.localizedDescription)", in: webView, confirm: nil) }
        }
    }
}

extension Bundle {
    var shortVersion: String {
        object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
