#if os(iOS)
import UIKit
import WebKit
import UniformTypeIdentifiers
import TesseraCore

/// No injected Clipboard API and no clipboard polling. The page explicitly
/// requests each operation; reads require a native confirmation as well as any
/// iPadOS paste permission. An approved page's own scripts share its trust.
@MainActor
final class NativeClipboard: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "tesseraClipboard"
    private let server: () -> URL?
    private let isUnlocked: () -> Bool
    private var reading = false
    private var generation = 0
    private weak var consentAlert: UIAlertController?
    private var consentContinuation: CheckedContinuation<Bool, Never>?
    private var consentTimeout: Task<Void, Never>?

    init(server: @escaping () -> URL?, isUnlocked: @escaping () -> Bool = { true }) {
        self.server = server; self.isUnlocked = isUnlocked
    }

    func invalidate() {
        generation += 1
        finishConsent(false)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any],
              let operation = body["operation"] as? String,
              let webView = message.webView, let selectedServer = server(),
              authorized(message, in: webView, server: selectedServer) else {
            replyHandler(nil, "Clipboard access is restricted to the active Tessera server page.")
            return
        }
        switch operation {
        case "hello":
            // Capability checks must never inspect or prompt for clipboard data.
            replyHandler(["version": "1.0.0", "native": true, "images": true, "terminal": false], nil)
        case "writeText":
            guard body["terminal"] as? Bool != true,
                  let text = body["text"] as? String,
                  text.utf8.count <= ClipboardPolicy.maxTextBytes else {
                replyHandler(nil, "Invalid or disallowed clipboard text write.")
                return
            }
            UIPasteboard.general.string = text
            replyHandler(["ok": true], nil)
        case "writeImage":
            guard body["terminal"] as? Bool != true,
                  let encoded = body["data"] as? String,
                  let data = ClipboardPolicy.imageData(encoded),
                  let image = UIImage(data: data), validDimensions(image),
                  let png = image.pngData(), png.count <= ClipboardPolicy.maxImageBytes else {
                replyHandler(nil, "Clipboard image is invalid or too large (16 MiB / 16 megapixels maximum).")
                return
            }
            UIPasteboard.general.setData(png, forPasteboardType: UTType.png.identifier)
            replyHandler(["ok": true], nil)
        case "readText", "read":
            guard !reading else {
                replyHandler(nil, "Another clipboard paste is already waiting for permission.")
                return
            }
            reading = true
            let requestedGeneration = generation
            Task { @MainActor in
                defer { reading = false }
                guard generation == requestedGeneration, server() == selectedServer,
                      authorized(message, in: webView, server: selectedServer) else {
                    replyHandler(nil, "The Tessera page changed before paste could start.")
                    return
                }
                let accepted = await confirmRead(in: webView, server: selectedServer)
                // The selected server, visible document or foreground state may
                // have changed while a permission dialog was on screen.
                guard accepted else {
                    replyHandler(nil, "Paste cancelled. No clipboard data was read.")
                    return
                }
                guard generation == requestedGeneration, server() == selectedServer,
                      authorized(message, in: webView, server: selectedServer) else {
                    replyHandler(nil, "The Tessera page changed before paste was approved.")
                    return
                }
                let board = UIPasteboard.general
                let text = board.string ?? ""
                guard text.utf8.count <= ClipboardPolicy.maxTextBytes else {
                    replyHandler(nil, "Clipboard text exceeds the 1 MiB limit.")
                    return
                }
                if operation == "readText" {
                    guard generation == requestedGeneration,
                          authorized(message, in: webView, server: selectedServer) else {
                        replyHandler(nil, "The Tessera page changed during paste.")
                        return
                    }
                    replyHandler(["text": text], nil)
                    return
                }
                var result: [String: Any] = ["text": text]
                if let image = board.image {
                    guard validDimensions(image), let data = image.pngData(),
                          data.count <= ClipboardPolicy.maxImageBytes else {
                        replyHandler(nil, "Clipboard image exceeds the 16 MiB / 16 megapixel limit.")
                        return
                    }
                    result["image"] = ["type": "image/png", "data": data.base64EncodedString()]
                }
                guard generation == requestedGeneration,
                      authorized(message, in: webView, server: selectedServer) else {
                    replyHandler(nil, "The Tessera page changed during paste.")
                    return
                }
                replyHandler(result, nil)
            }
        default:
            replyHandler(nil, "Unsupported native clipboard operation.")
        }
    }

    private func confirmRead(in webView: WKWebView, server: URL) async -> Bool {
        guard var presenter = webView.window?.rootViewController else { return false }
        while let presented = presenter.presentedViewController { presenter = presented }
        // Do not stack clipboard consent over an existing modal alert.
        guard !(presenter is UIAlertController), !presenter.isBeingDismissed else { return false }
        return await withCheckedContinuation { continuation in
            consentContinuation = continuation
            let alert = UIAlertController(title: "Paste into Tessera?",
                message: "Allow \(server.host ?? "this server") to receive text or an image from your iPad clipboard?",
                preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.finishConsent(false) })
            alert.addAction(UIAlertAction(title: "Paste", style: .default) { [weak self] _ in self?.finishConsent(true) })
            consentAlert = alert
            consentTimeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(90))
                if !Task.isCancelled { self?.finishConsent(false) }
            }
            presenter.present(alert, animated: true)
        }
    }

    private func finishConsent(_ accepted: Bool) {
        guard let continuation = consentContinuation else { return }
        consentContinuation = nil
        consentTimeout?.cancel()
        consentTimeout = nil
        consentAlert?.dismiss(animated: false)
        consentAlert = nil
        continuation.resume(returning: accepted)
    }

    private func validDimensions(_ image: UIImage) -> Bool {
        let width = image.size.width * image.scale, height = image.size.height * image.scale
        return width > 0 && height > 0 && width * height <= CGFloat(ClipboardPolicy.maxImagePixels)
    }

    private func authorized(_ message: WKScriptMessage, in webView: WKWebView, server: URL) -> Bool {
        guard isUnlocked() else { return false }
        guard let document = webView.url, let frame = message.frameInfo.request.url else { return false }
        let securityOrigin = message.frameInfo.securityOrigin
        var components = URLComponents()
        components.scheme = securityOrigin.protocol
        components.host = securityOrigin.host
        if securityOrigin.port > 0 { components.port = securityOrigin.port }
        guard let origin = components.url else { return false }
        return ClipboardPolicy.allows(server: server, document: document, frame: frame, origin: origin,
            isMainFrame: message.frameInfo.isMainFrame,
            isActive: webView.window?.windowScene?.activationState == .foregroundActive)
    }
}
#endif
