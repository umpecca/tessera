import Foundation

#if os(iOS)
import UIKit

/// The few things the web view needs that UIKit and AppKit do differently.
enum Platform {
    static func openExternally(_ url: URL) {
        UIApplication.shared.open(url)
    }

    /// The app's Documents folder, shown in Files under On My iPad › Tessera.
    static var downloadsDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    /// An alert with OK, or with Cancel and `confirm`. Reports whether it
    /// was accepted.
    static func ask(_ message: String, in view: UIView, confirm: String?) async -> Bool {
        guard let presenter = presenter(for: view) else { return false }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            if let confirm {
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
                alert.addAction(UIAlertAction(title: confirm, style: .default) { _ in continuation.resume(returning: true) })
            } else {
                alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: true) })
            }
            presenter.present(alert, animated: true)
        }
    }

    static func prompt(_ message: String, defaultText: String, in view: UIView) async -> String? {
        guard let presenter = presenter(for: view) else { return nil }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                continuation.resume(returning: alert?.textFields?.first?.text ?? "")
            })
            presenter.present(alert, animated: true)
        }
    }

    static func downloadFinished(_ file: URL, in view: UIView?) {
        guard let view else { return }
        Task { _ = await ask("Saved “\(file.lastPathComponent)” to Files › On My iPad › Tessera.", in: view, confirm: nil) }
    }

    private static func presenter(for view: UIView) -> UIViewController? {
        var controller = view.window?.rootViewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }
}

#else
import AppKit

/// The few things the web view needs that UIKit and AppKit do differently.
enum Platform {
    static func openExternally(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    /// The user's Downloads folder, reached through the sandbox's
    /// Downloads entitlement.
    static var downloadsDirectory: URL {
        FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    }

    /// A sheet with OK, or with `confirm` and Cancel. Reports whether it was
    /// accepted.
    static func ask(_ message: String, in view: NSView, confirm: String?) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: confirm ?? "OK")
        if confirm != nil { alert.addButton(withTitle: "Cancel") }
        guard let window = view.window else { return alert.runModal() == .alertFirstButtonReturn }
        return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
    }

    static func prompt(_ message: String, defaultText: String, in view: NSView) async -> String? {
        let alert = NSAlert()
        alert.messageText = message
        let field = NSTextField(string: defaultText)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        let response: NSApplication.ModalResponse
        if let window = view.window { response = await alert.beginSheetModal(for: window) } else { response = alert.runModal() }
        return response == .alertFirstButtonReturn ? field.stringValue : nil
    }

    static func chooseFiles(multiple: Bool, directories: Bool, in view: NSView) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = directories
        panel.allowsMultipleSelection = multiple
        let response: NSApplication.ModalResponse
        if let window = view.window { response = await panel.beginSheetModal(for: window) } else { response = panel.runModal() }
        return response == .OK ? panel.urls : nil
    }

    /// Bounces the Downloads stack in the Dock, as Safari does.
    static func downloadFinished(_ file: URL, in view: NSView?) {
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: file.path)
    }
}
#endif
