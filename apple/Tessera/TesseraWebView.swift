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

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    fileprivate func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Keeps Tessera's sign-in cookie and settings between launches.
        configuration.websiteDataStore = .default()
        // Terminal audio plays as it arrives, as it does once Safari has
        // seen a tap.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Lets the page tell the app from Safari (Settings → Diagnostics).
        configuration.applicationNameForUserAgent = "TesseraApp/\(Bundle.main.shortVersion)"
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        #endif
        let webView = WKWebView(frame: .zero, configuration: configuration)
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
            parent.onFailure(error.localizedDescription)
        }

        /// WebKit ended the page's process (memory pressure, a crash). Tessera
        /// restores terminals from the server on reload.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
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

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String) async -> URL? {
            webView = download.webView ?? webView
            let destination = DownloadDestination.url(in: Platform.downloadsDirectory, suggestedFilename: suggestedFilename)
            destinations[ObjectIdentifier(download)] = destination
            return destination
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
            Platform.downloadFinished(destination, in: download.webView ?? webView)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            destinations.removeValue(forKey: ObjectIdentifier(download))
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
