import SwiftUI

/// A native window around the Tessera web client on a server the user
/// names. The server and its web app are unchanged; see apple/README.md.
@main
struct TesseraApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
        .defaultSize(width: 1280, height: 820)
        #endif
        .commands { ServerCommands() }
    }
}

extension FocusedValues {
    /// The focused window's server actions, for the menu bar.
    @Entry var serverActions: ServerActions?
}

struct ServerActions {
    let changeServer: () -> Void
    let reload: () -> Void
}

struct ServerCommands: Commands {
    @FocusedValue(\.serverActions) private var actions

    var body: some Commands {
        CommandGroup(after: .appSettings) {
            // Not Cmd+, alone: that is the app's Settings on the Mac.
            Button("Change Server…") { actions?.changeServer() }
                .keyboardShortcut(",", modifiers: [.command, .shift])
                .disabled(actions == nil)
        }
        CommandGroup(after: .toolbar) {
            // There is no browser toolbar; this replaces Safari's reload.
            Button("Reload Page") { actions?.reload() }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(actions == nil)
        }
    }
}
