#if os(iOS)
import SwiftUI
import WebKit
import Network
import UniformTypeIdentifiers
import TesseraCore

enum IPadSheet: String, Identifiable {
    case servers, downloads, help, diagnostics, keyboard, privacy
    var id: String { rawValue }
}

@Observable @MainActor
final class IPadDownload: Identifiable {
    let id = UUID()
    var name: String
    var file: URL?
    var fraction = 0.0
    var received: Int64 = 0
    var total: Int64 = 0
    var status = "Downloading"
    var error: String?
    @ObservationIgnored var observation: NSKeyValueObservation?
    @ObservationIgnored var cancel: (() -> Void)?
    init(name: String, file: URL? = nil) { self.name = name; self.file = file }
}

@Observable @MainActor
final class IPadAppModel {
    static var initialDefaults: UserDefaults {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--tessera-ui-tests") {
            // An explicit test UUID permits relaunch/persistence checks while
            // staying isolated from real app preferences and other test runs.
            let prefix = "--tessera-ui-tests-id="
            let argument = ProcessInfo.processInfo.arguments.first { $0.hasPrefix(prefix) }
            let id = argument.flatMap { UUID(uuidString: String($0.dropFirst(prefix.count))) } ?? UUID()
            return UserDefaults(suiteName: "com.jaxdad.tessera.ui-tests.\(id.uuidString)")!
        }
        #endif
        return .standard
    }
    var library: ServerProfiles
    let privacy: IPadPrivacy
    var sheet: IPadSheet? { didSet { if sheet != nil { perform("holdSize") } } }
    var failure: ConnectionAdvice?
    var notice: String? { didSet { if notice != nil { perform("holdSize") } } }
    var downloadNotice: String?
    var ready = false
    var online = true
    var reloadCount = 0
    var keyboardVisible: Bool { didSet { perform("holdSize"); defaults.set(keyboardVisible, forKey: "ipad.keyboard-controls") } }
    var distractionFree: Bool {
        didSet {
            perform("holdSize")
            defaults.set(distractionFree, forKey: "ipad.distraction-free")
            defaults.set(distractionFree, forKey: "ipad.hide-status-bar") // Preserve the choice on downgrade.
        }
    }
    var fullScreen = false
    var highRefresh: Bool { didSet { defaults.set(highRefresh, forKey: "ipad.high-refresh"); configureRendering() } }
    var downloads: [IPadDownload] = []
    var importFiles = false { didSet { if importFiles { perform("holdSize") } } }
    var importPhotos = false { didSet { if importPhotos { perform("holdSize") } } }
    var measuring = false
    var refreshReport = "Not measured. Measure while the workspace is visible."
    var recovery = AppRecovery()
    @ObservationIgnored weak var webView: IPadWebView?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var receivedNetworkPath = false
    @ObservationIgnored private var reloadAfterUnlock = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        privacy = IPadPrivacy(defaults: defaults)
        library = ServerProfiles.load(defaults.data(forKey: "tessera.server-profiles.v1"), legacyAddress: defaults.string(forKey: "serverURL") ?? "")
        keyboardVisible = defaults.bool(forKey: "ipad.keyboard-controls")
        distractionFree = IPadPresentation.distractionFreePreference(saved: defaults.object(forKey: "ipad.distraction-free") as? Bool,
            legacyStatusBarHidden: defaults.object(forKey: "ipad.hide-status-bar") as? Bool)
        highRefresh = defaults.object(forKey: "ipad.high-refresh") as? Bool ?? true
        persistProfiles()
        loadFinishedDownloads()
        privacy.onAccessChanged = { [weak self] in self?.privacyAccessChanged() }
        monitor.pathUpdateHandler = { [weak self] path in
            let connected = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let recovered = self.receivedNetworkPath && connected
                self.receivedNetworkPath = true
                self.online = connected
                if recovered && self.recovery.active { self.perform("resume") }
            }
        }
        monitor.start(queue: DispatchQueue(label: "tessera.network-state"))
    }

    deinit { monitor.cancel() }
    var selected: ServerProfile? { library.selected }

    var hidesSystemUI: Bool {
        IPadPresentation.hidesSystemUI(enabled: distractionFree, fullScreen: fullScreen, active: recovery.active,
            workspace: selected != nil && privacy.allowsAccess, presentingNativeUI: sheet != nil || importFiles || importPhotos || notice != nil || privacy.covered)
    }

    func updateFullScreen(_ value: Bool) {
        guard fullScreen != value else { return }
        perform("holdSize")
        fullScreen = value
    }

    func persistProfiles() {
        if let data = try? JSONEncoder().encode(library) { defaults.set(data, forKey: "tessera.server-profiles.v1") }
        // Keep older app versions pointing at the selected address on downgrade.
        defaults.set(selected?.address.absoluteString ?? "", forKey: "serverURL")
    }

    func select(_ id: UUID) {
        guard library.profiles.contains(where: { $0.id == id }), selected?.id != id else { sheet = nil; return }
        suspend()
        library.selectedID = id
        persistProfiles()
        failure = nil; ready = false; sheet = nil
    }

    func saveServer(name: String, address: URL, editing id: UUID?) {
        let previous = selected
        suspend()
        library.save(name: name, address: address, editing: id)
        persistProfiles()
        failure = nil; sheet = nil
        if selected?.id != previous?.id || selected?.address != previous?.address { ready = false }
        else { perform("resume") }
    }

    func removeServer(_ id: UUID) {
        if id == selected?.id { suspend(); ready = false; failure = nil }
        library.remove(id)
        persistProfiles()
    }

    func reload() {
        suspend()
        failure = nil; ready = false; reloadCount += 1
    }

    func suspend() {
        webView?.nativeClipboard?.invalidate()
        perform("suspend")
        webView?.endEditing(true)
    }

    func setActive(_ active: Bool, background: Bool = false) {
        let wasActive = recovery.active
        privacy.setActive(active, background: background)
        // System permission sheets can make the scene briefly inactive. Keep
        // pending paste consent intact; only real backgrounding revokes it.
        // A newly engaged privacy lock already suspends through its access
        // callback. Do not replace the same background snapshot a second time.
        if background { if privacy.allowsAccess { suspend() } }
        else if !active { perform("holdSize") }
        let reload = recovery.setActive(active)
        configureRendering()
        if reload { self.reload() }
        else if active { resumeWorkspace(restoringFocus: !wasActive) }
    }

    // Public responder APIs only. Resuming a socket or changing layout does not
    // request text focus; only foreground entry/unlock or a completed page load.
    func resumeWorkspace(restoringFocus: Bool) {
        var restore = false
        if restoringFocus, recovery.active, privacy.allowsAccess, !privacy.covered,
           sheet == nil, !importFiles, !importPhotos, notice == nil, ready,
           let webView, let profile = selected, let url = webView.url,
           webView.window?.windowScene?.activationState == .foregroundActive,
           ServerAddress.sameOrigin(profile.address, url), ClipboardPolicy.isAppDocument(url) {
            webView.becomeFirstResponder()
            restore = true
        }
        perform("resume", payload: ["restoreFocus": restore])
    }

    func processTerminated() {
        ready = false
        if !privacy.allowsAccess { reloadAfterUnlock = true; return }
        if recovery.processTerminated() { reload() }
    }

    func configureRendering() {
        perform("refreshPreference", payload: ["highRefresh": highRefresh && recovery.active && !ProcessInfo.processInfo.isLowPowerModeEnabled])
    }

    func perform(_ command: String, payload: [String: Any] = [:]) {
        guard privacy.allowsAccess || ["suspend", "holdSize", "refreshPreference"].contains(command) else { return }
        guard let webView, let profile = selected, let url = webView.url,
              ServerAddress.sameOrigin(profile.address, url), ClipboardPolicy.isAppDocument(url) else { return }
        webView.callAsyncJavaScript("return await window.tesseraNativeApp?.perform(command, payload)",
            arguments: ["command": command, "payload": payload], in: nil, in: .page) { [weak self] result in
                guard self?.webView === webView else { return }
                let interactive = !["suspend", "resume", "holdSize", "refreshPreference"].contains(command)
                guard interactive else { return }
                switch result {
                case .failure(let error): self?.notice = "Action unavailable: \(error.localizedDescription)"
                case .success(let value):
                    if (value as? [String: Any])?["ok"] as? Bool != true {
                        self?.notice = "This action needs the updated Tessera server, a loaded workspace and (for terminal keys) an active terminal without a dialog."
                    }
                }
            }
    }

    func shortcut(_ command: String) {
        guard privacy.allowsAccess else { return }
        switch command {
        case "servers": sheet = .servers
        case "reload": reload()
        case "keyboard": keyboardVisible.toggle()
        default: perform(command)
        }
    }

    private func privacyAccessChanged() {
        webView?.isUserInteractionEnabled = privacy.allowsAccess
        if !privacy.allowsAccess {
            suspend()
        } else if recovery.active {
            if reloadAfterUnlock { reloadAfterUnlock = false; reload() }
            else { resumeWorkspace(restoringFocus: true) }
        }
    }

    func sendKey(_ key: String, ctrl: Bool = false, alt: Bool = false) {
        perform("key", payload: ["key": key, "ctrlKey": ctrl, "altKey": alt])
    }

    func measureRefresh() {
        guard let webView, ready, !measuring, let url = webView.url, let profile = selected,
              ServerAddress.sameOrigin(profile.address, url), ClipboardPolicy.isAppDocument(url) else { return }
        measuring = true
        webView.callAsyncJavaScript("return await window.tesseraNativeApp?.measureRefreshRate(3000)", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            self.measuring = false
            if case .success(let value) = result, let report = value as? [String: Any], let fps = report["fps"] as? Double {
                self.refreshReport = String(format: "WebKit requestAnimationFrame: %.1f FPS over 3 seconds. Display maximum: %d Hz. This measures callbacks, not physical presentation or keyboard latency.", fps, webView.window?.screen.maximumFramesPerSecond ?? 60)
            } else { self.refreshReport = "Measurement unavailable. Load the updated Tessera workspace and try again." }
            self.notice = self.refreshReport
        }
    }

    func loadFinishedDownloads() {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: Platform.downloadsDirectory, includingPropertiesForKeys: Array(keys), options: .skipsHiddenFiles)) ?? []
        downloads = files.filter { url in
            guard let values = try? url.resourceValues(forKeys: keys) else { return false }
            return values.isRegularFile == true && values.isSymbolicLink != true
        }.prefix(100).map { url in
            let item = IPadDownload(name: url.lastPathComponent, file: url)
            item.fraction = 1; item.status = "Saved"
            return item
        }
    }

    func notifyDownload(_ name: String) {
        let message = "Saved \(name). Available in Downloads."
        downloadNotice = message
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(5))
            if self?.downloadNotice == message { self?.downloadNotice = nil }
        }
    }

    func importURLs(_ urls: [URL]) {
        guard urls.count <= 8 else { notice = "Import at most eight files at a time."; return }
        let profile = selected?.id
        Task {
            do {
                var items: [[String: Any]] = []
                var total = 0
                for url in urls {
                    let accessed = url.startAccessingSecurityScopedResource()
                    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                    guard values.isRegularFile == true, let count = values.fileSize, count <= 16 * 1024 * 1024 else { throw ImportFailure.tooLarge }
                    total += count
                    guard total <= 32 * 1024 * 1024 else { throw ImportFailure.tooLarge }
                    let data = try Data(contentsOf: url)
                    items.append(try importItem(data: data, name: url.lastPathComponent, type: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"))
                }
                guard selected?.id == profile else { return }
                deliverImports(items)
            } catch { notice = error.localizedDescription }
        }
    }

    func importItem(data: Data, name: String, type: String) throws -> [String: Any] {
        guard !data.isEmpty, data.count <= 16 * 1024 * 1024 else { throw ImportFailure.tooLarge }
        return ["name": URL(fileURLWithPath: name).lastPathComponent, "type": type, "data": data.base64EncodedString()]
    }

    func deliverImports(_ items: [[String: Any]]) {
        guard ready, !items.isEmpty else { notice = "Load a Tessera workspace before importing files."; return }
        perform("files", payload: ["items": items])
    }
}

enum ImportFailure: LocalizedError {
    case tooLarge
    var errorDescription: String? { "Choose non-empty regular files up to 16 MiB each (eight at a time). Folders are not imported." }
}
#endif
