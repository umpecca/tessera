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
        #endif

        init(_ parent: TesseraWebView) {
            self.parent = parent
        }

        /// Loads a new server, or reloads when asked to.
        func show(_ view: TesseraWebView, in webView: WKWebView) {
            parent = view
            if shownURL != view.url {
                shownURL = view.url
                shownReloadCount = view.reloadCount
                webView.load(URLRequest(url: view.url))
            } else if shownReloadCount != view.reloadCount {
                shownReloadCount = view.reloadCount
                // A first load that failed has nothing to reload.
                if webView.url == nil { webView.load(URLRequest(url: view.url)) } else { webView.reload() }
            }
        }

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
            parent.onLoad()
            #if os(iOS)
            parent.app?.configureRendering()
            parent.app?.perform("resume")
            #endif
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            let error = error as NSError
            // A cancelled load, or one that turned into a download, is not a
            // failure to reach the server.
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
            if error.domain == WKError.errorDomain && error.code == 102 { return } // frame load interrupted
            #if os(iOS)
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
