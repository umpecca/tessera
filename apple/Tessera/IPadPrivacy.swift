#if os(iOS)
import SwiftUI
import LocalAuthentication
import TesseraCore

@Observable @MainActor
final class IPadPrivacy {
    private(set) var state: AppPrivacy
    var error: String?
    private(set) var previewing = false
    @ObservationIgnored var onAccessChanged: (() -> Void)?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var context: LAContext?
    @ObservationIgnored private var coverWindow: UIWindow?
    @ObservationIgnored private weak var previousKeyWindow: UIWindow?
    @ObservationIgnored private var hiddenAccessibility: [(UIWindow, Bool)] = []
    @ObservationIgnored private var snapshotCovers: [UIView] = []
    #if DEBUG && targetEnvironment(simulator)
    @ObservationIgnored private var testResponses: [String] = []
    #endif

    init(defaults: UserDefaults) {
        self.defaults = defaults
        state = AppPrivacy(shieldEnabled: defaults.object(forKey: "ipad.privacy-shield") as? Bool ?? true,
            lockEnabled: defaults.bool(forKey: "ipad.privacy-lock"))
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--tessera-ui-tests") {
            let prefix = "--tessera-ui-tests-auth="
            if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }) {
                testResponses = String(argument.dropFirst(prefix.count)).split(separator: ",").map(String.init)
            }
        }
        #endif
    }

    var shieldEnabled: Bool {
        get { state.shieldEnabled }
        set { state.shieldEnabled = newValue; defaults.set(newValue, forKey: "ipad.privacy-shield"); refreshCover() }
    }
    var lockEnabled: Bool { state.lockEnabled }
    var allowsAccess: Bool { state.allowsAccess }
    var covered: Bool { state.coversContent || previewing }

    func setActive(_ active: Bool, background: Bool = false) {
        let previouslyAllowed = state.allowsAccess
        if active {
            state.shieldEnabled = defaults.object(forKey: "ipad.privacy-shield") as? Bool ?? true
            let savedLock = defaults.bool(forKey: "ipad.privacy-lock")
            if savedLock != state.lockEnabled { context?.invalidate(); context = nil; state.applySavedLock(savedLock) }
        }
        if background { context?.invalidate(); context = nil; previewing = false }
        state.setActive(active, background: background)
        refreshCover()
        if previouslyAllowed != state.allowsAccess { onAccessChanged?() }
        if active, let token = state.beginAutomaticUnlock() { authenticate(token: token) }
    }

    func unlock() {
        guard let token = state.beginAuthentication(.unlock) else { return }
        authenticate(token: token)
    }

    func requestLock(_ enabled: Bool) {
        guard let token = state.beginAuthentication(.setLock(enabled)) else { return }
        authenticate(token: token)
    }

    func preview() { previewing = true; refreshCover() }
    func dismissPreview() { guard !state.locked else { return }; previewing = false; refreshCover() }

    func attach(to scene: UIWindowScene) {
        if coverWindow?.windowScene !== scene {
            removeCover()
            let window = UIWindow(windowScene: scene)
            window.windowLevel = .alert + 1
            window.backgroundColor = .systemBackground
            window.rootViewController = UIHostingController(rootView: PrivacyScreen(privacy: self))
            window.rootViewController?.view.accessibilityViewIsModal = true
            coverWindow = window
        }
        refreshCover()
    }

    func detach() { removeCover(); coverWindow = nil }

    private func refreshCover() {
        guard let coverWindow, let scene = coverWindow.windowScene else { return }
        if #available(iOS 26, *) { coverWindow.frame = scene.effectiveGeometry.coordinateSpace.bounds }
        else { coverWindow.frame = scene.coordinateSpace.bounds }
        if covered {
            if coverWindow.isHidden {
                previousKeyWindow = scene.keyWindow
            }
            for window in scene.windows where window !== coverWindow && !hiddenAccessibility.contains(where: { $0.0 === window }) {
                hiddenAccessibility.append((window, window.accessibilityElementsHidden))
                window.accessibilityElementsHidden = true
                // Protect each original window's own snapshot too, even if the
                // system omits the separate lock/control window from a preview.
                let cover = UIView(frame: window.bounds)
                cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                cover.backgroundColor = .systemBackground
                cover.isOpaque = true
                cover.accessibilityElementsHidden = true
                let label = UILabel()
                label.text = "Tessera"
                label.font = .preferredFont(forTextStyle: .largeTitle)
                label.textColor = .label
                label.translatesAutoresizingMaskIntoConstraints = false
                cover.addSubview(label)
                NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: cover.centerXAnchor), label.centerYAnchor.constraint(equalTo: cover.centerYAnchor)])
                window.addSubview(cover)
                snapshotCovers.append(cover)
            }
            coverWindow.isHidden = false
            // Locked/preview UI owns input; never leave a terminal responder
            // behind an opaque curtain receiving hardware keyboard events.
            if state.locked || previewing { coverWindow.makeKey() }
        } else { removeCover() }
    }

    private func removeCover() {
        let wasKey = coverWindow?.isKeyWindow == true
        coverWindow?.isHidden = true
        for cover in snapshotCovers { cover.removeFromSuperview() }
        snapshotCovers = []
        for (window, value) in hiddenAccessibility { window.accessibilityElementsHidden = value }
        hiddenAccessibility = []
        if wasKey {
            let previous = previousKeyWindow.flatMap { $0.isHidden ? nil : $0 }
            let fallback = coverWindow?.windowScene?.windows.first { $0 !== coverWindow && !$0.isHidden }
            (previous ?? fallback)?.makeKey() // Does not focus a text field.
        }
        previousKeyWindow = nil
    }

    private func authenticate(token: Int) {
        error = nil
        let enabling = state.authentication != .unlock
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard self.state.authenticationIsCurrent(token) else { return }
            guard self.state.active else {
                self.state.finishAuthentication(token: token, success: false)
                self.error = "Return to Tessera, then try authentication again."
                return
            }
            let success: Bool
            var message: String?
            #if DEBUG && targetEnvironment(simulator)
            if !self.testResponses.isEmpty {
                success = self.testResponses.removeFirst() == "success"
                message = success ? nil : "Authentication cancelled. Tap Unlock to try again."
            } else {
                (success, message) = await self.authenticateDevice(enabling: enabling)
            }
            #else
            (success, message) = await self.authenticateDevice(enabling: enabling)
            #endif
            let previouslyAllowed = self.state.allowsAccess
            guard self.state.finishAuthentication(token: token, success: success) else { return }
            self.context = nil
            if success { self.defaults.set(self.state.lockEnabled, forKey: "ipad.privacy-lock") }
            self.error = message
            self.refreshCover()
            if previouslyAllowed != self.state.allowsAccess { self.onAccessChanged?() }
        }
    }

    private func authenticateDevice(enabling: Bool) async -> (Bool, String?) {
        let context = LAContext()
        self.context = context
        context.localizedCancelTitle = "Cancel"
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else {
            return (false, "Device authentication is unavailable. Set an iPad passcode in Settings before enabling the app lock.")
        }
        do {
            let success = try await context.evaluatePolicy(.deviceOwnerAuthentication,
                localizedReason: enabling ? "Confirm this change to Tessera's privacy lock." : "Unlock your Tessera workspace.")
            return (success, success ? nil : "Authentication was not completed. Try again.")
        } catch {
            return (false, "Authentication was not completed. Use Face ID, Touch ID or your iPad passcode to try again.")
        }
    }
}

/// A separate opaque native window covers web content AND presented sheets in
/// the app-switcher snapshot. No blur silhouettes, server names or terminal text.
private struct PrivacyScreen: View {
    @Bindable var privacy: IPadPrivacy
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.shield.fill").font(.system(size: 52)).accessibilityHidden(true)
            Text("Tessera").font(.largeTitle.bold())
            if privacy.state.locked {
                Text("Workspace locked").foregroundStyle(.secondary)
                if privacy.state.authentication != nil { ProgressView("Authenticating…") }
                else { Button("Unlock Tessera", action: privacy.unlock).buttonStyle(.borderedProminent).accessibilityIdentifier("privacy-unlock") }
                if let error = privacy.error { Text(error).font(.callout).foregroundStyle(.secondary) }
            } else if privacy.previewing {
                Text("App-switcher previews show this screen instead of your workspace.").foregroundStyle(.secondary)
                Button("Back to Tessera", action: privacy.dismissPreview).buttonStyle(.borderedProminent).accessibilityIdentifier("privacy-dismiss-preview")
            }
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
    }
}

struct IPadPrivacyAnchor: UIViewRepresentable {
    let privacy: IPadPrivacy
    func makeUIView(context: Context) -> Anchor { let view = Anchor(); view.privacy = privacy; view.isUserInteractionEnabled = false; return view }
    func updateUIView(_ view: Anchor, context: Context) { view.privacy = privacy; if let scene = view.window?.windowScene { privacy.attach(to: scene) } }
    static func dismantleUIView(_ view: Anchor, coordinator: ()) { view.stopObserving(); view.privacy?.detach() }
    final class Anchor: UIView {
        weak var privacy: IPadPrivacy?
        private weak var observedScene: UIWindowScene?
        private var observers: [NSObjectProtocol] = []
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let scene = window?.windowScene { observe(scene); privacy?.attach(to: scene) }
            else { stopObserving() }
        }
        override func layoutSubviews() { super.layoutSubviews(); if let scene = window?.windowScene { privacy?.attach(to: scene) } }

        private func observe(_ scene: UIWindowScene) {
            guard observedScene !== scene else { return }
            stopObserving(); observedScene = scene
            for (name, active, background) in [(UIScene.willDeactivateNotification, false, false),
                (UIScene.didEnterBackgroundNotification, false, true), (UIScene.didActivateNotification, true, false)] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: scene, queue: .main) { [weak self] _ in
                    // Synchronous on the main thread: install the opaque cover
                    // before iPadOS captures the app-switcher snapshot.
                    MainActor.assumeIsolated { self?.privacy?.setActive(active, background: background) }
                })
            }
        }

        func stopObserving() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []; observedScene = nil
        }
    }
}

struct IPadPrivacySettings: View {
    @Bindable var privacy: IPadPrivacy
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("App-switcher privacy") {
                    Toggle("Hide app-switcher preview", isOn: $privacy.shieldEnabled)
                        .accessibilityIdentifier("privacy-shield-setting")
                    Text("On by default. Covers this app's windows, including native sheets, with an opaque Tessera screen while inactive or in the background. No terminal text, server addresses or download names are shown in that preview.")
                    Button("Preview Privacy Shield", action: privacy.preview).accessibilityIdentifier("privacy-preview")
                }
                Section("Device authentication") {
                    Toggle("Require device unlock", isOn: Binding(get: { privacy.lockEnabled }, set: privacy.requestLock))
                        .disabled(privacy.state.authentication != nil).accessibilityIdentifier("privacy-lock-setting")
                    Text("Optional. Uses Face ID, Touch ID or your iPad passcode on launch and after backgrounding. Enabling or disabling it requires device authentication. Cancelling an unlock keeps the workspace locked; cancelling a setting change leaves the preference unchanged. You can retry or use your device passcode. An iPad passcode must be configured first.")
                    if privacy.state.authentication != nil { ProgressView("Authenticating…") }
                    if let error = privacy.error { Text(error).foregroundStyle(.secondary).accessibilityIdentifier("privacy-auth-error") }
                }
                Section("What this protects") {
                    Text("This is a local app privacy lock, not server authentication or encryption. It does not stop host terminals, erase server data, clear the shared clipboard, hide system notifications or block screenshots while you are unlocked. Keep your iPad passcode and server sign-in secure.")
                }
            }.navigationTitle("Privacy")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
#endif
