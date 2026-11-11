#if os(iOS)
import UIKit
import WebKit
import TesseraCore

/// Public responder-chain key commands; no private WebKit content-view hacks.
/// Ordinary Escape, text, IME, modifiers, function keys and Cmd+V still reach
/// WebKit's input system. Only the app's named commands claim priority.
final class IPadWebView: WKWebView {
    weak var nativeClipboard: NativeClipboard?
    var onCommand: ((String) -> Void)?

    override var keyCommands: [UIKeyCommand]? {
        let appCommands = AppShortcut.all.map { shortcut in
            let modifiers: UIKeyModifierFlags = shortcut.shifted ? [.command, .shift] : [.command]
            let command = UIKeyCommand(title: shortcut.title, action: #selector(runShortcut(_:)), input: shortcut.input, modifierFlags: modifiers)
            command.wantsPriorityOverSystemBehavior = true
            command.discoverabilityTitle = shortcut.title
            return command
        }
        return appCommands + (super.keyCommands ?? [])
    }

    @objc private func runShortcut(_ command: UIKeyCommand) {
        guard let shortcut = AppShortcut.all.first(where: { $0.input == command.input && $0.shifted == command.modifierFlags.contains(.shift) }) else { return }
        onCommand?(shortcut.command)
    }
}
#endif
