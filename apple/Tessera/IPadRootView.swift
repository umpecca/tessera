#if os(iOS)
import SwiftUI
import PhotosUI
import QuickLook
import UniformTypeIdentifiers
import TesseraCore

struct IPadRootView: View {
    @State private var app = IPadAppModel(defaults: IPadAppModel.initialDefaults)
    @Environment(\.scenePhase) private var scenePhase
    @State private var photos: [PhotosPickerItem] = []
    @State private var dropTarget = false

    var body: some View {
        presentedContent
            .background(IPadWindowGeometryObserver(onChange: app.updateFullScreen))
            .background(IPadPrivacyAnchor(privacy: app.privacy))
            .statusBarHidden(app.hidesSystemUI)
            .persistentSystemOverlays(app.hidesSystemUI ? .hidden : .automatic)
            .fileImporter(isPresented: $app.importFiles, allowedContentTypes: [.item], allowsMultipleSelection: true, onCompletion: importFiles)
            .photosPicker(isPresented: $app.importPhotos, selection: $photos, maxSelectionCount: 8, matching: .images)
            .onChange(of: photos) { _, selected in
                guard !selected.isEmpty else { return }
                Task { @MainActor in await loadPhotos(selected) }
            }
            .onChange(of: scenePhase, initial: true) { _, phase in app.setActive(phase == .active, background: phase == .background) }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in app.configureRendering() }
            .focusedSceneValue(\.serverActions, ServerActions(changeServer: { if app.privacy.allowsAccess { app.sheet = .servers } }, reload: { if app.privacy.allowsAccess { app.reload() } }))
    }

    @ViewBuilder private var mainContent: some View {
        if !app.privacy.state.unlockedThisLaunch { Color(uiColor: .systemBackground) }
        else if let profile = app.selected { workspace(profile) }
        else { ServerProfilesView(app: app, firstRun: true) }
    }

    private func workspace(_ profile: ServerProfile) -> some View {
        TesseraWebView(url: profile.address, reloadCount: app.reloadCount,
            onFailure: { _ in app.ready = false }, onLoad: { app.ready = true; app.failure = nil }, app: app)
            .id(profile.id)
            .ignoresSafeArea(.container)
            .overlay { if let failure = app.failure { connectionFailure(failure) } }
            .overlay(alignment: .topTrailing) { appMenu.padding(8) }
            .overlay(alignment: .bottomLeading) { downloadToast }
            .overlay { if dropTarget { RoundedRectangle(cornerRadius: 12).stroke(Color.accentColor, lineWidth: 4).padding(4).allowsHitTesting(false) } }
            .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier], isTargeted: $dropTarget, perform: receiveDrop)
            .safeAreaInset(edge: .bottom, spacing: 0) { if app.keyboardVisible { TerminalKeyBar(app: app) } }
    }

    @ViewBuilder private var downloadToast: some View {
        if let message = app.downloadNotice {
            Button { app.sheet = .downloads; app.downloadNotice = nil } label: {
                Label(message, systemImage: "arrow.down.circle.fill").padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }.padding(8).accessibilityHint("Open Downloads")
        }
    }

    private var presentedContent: some View {
        mainContent
        .sheet(item: $app.sheet) { sheet in
            switch sheet {
            case .servers: ServerProfilesView(app: app)
            case .downloads: DownloadsView(app: app)
            case .help: IPadHelpView()
            case .diagnostics: IPadDiagnosticsView(app: app)
            case .keyboard: ShortcutHelpView(app: app)
            case .privacy: IPadPrivacySettings(privacy: app.privacy)
            }
        }
        .alert("Tessera", isPresented: noticePresented) {
            Button("OK", role: .cancel) { app.notice = nil }
        } message: { Text(app.notice ?? "") }
    }

    private var noticePresented: Binding<Bool> {
        Binding(get: { app.notice != nil }, set: { if !$0 { app.notice = nil } })
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result { case .success(let urls): app.importURLs(urls); case .failure(let error): app.notice = error.localizedDescription }
    }

    private func loadPhotos(_ selected: [PhotosPickerItem]) async {
        let profileID = app.selected?.id
        do {
            var items: [[String: Any]] = []
            var total = 0
            for (index, photo) in selected.enumerated() {
                guard let data = try await photo.loadTransferable(type: Data.self), data.count <= 16 * 1024 * 1024 else { throw ImportFailure.tooLarge }
                guard let image = UIImage(data: data) else { throw ImportFailure.tooLarge }
                let pixels: CGFloat = (image.size.width * image.scale) * (image.size.height * image.scale)
                guard pixels <= 16_000_000, let png = image.pngData() else { throw ImportFailure.tooLarge }
                items.append(try app.importItem(data: png, name: "photo-\(index + 1).png", type: "image/png"))
                total += png.count
                guard total <= 32 * 1024 * 1024 else { throw ImportFailure.tooLarge }
            }
            if app.selected?.id == profileID { app.deliverImports(items) }
        } catch { app.notice = error.localizedDescription }
        photos = []
    }

    private var appMenu: some View {
        Menu {
            Text(app.selected?.displayName ?? "Tessera")
            Label(app.online ? "Network available" : "Network offline", systemImage: app.online ? "network" : "network.slash")
            Button("Saved Servers…", systemImage: "server.rack") { app.sheet = .servers }
            Button("Reload Page", systemImage: "arrow.clockwise", action: app.reload)
            Divider()
            Button("Command Palette", systemImage: "command") { app.perform("palette") }.disabled(!app.ready)
            Button("Window List", systemImage: "rectangle.on.rectangle") { app.perform("windows") }.disabled(!app.ready)
            Button("Session List", systemImage: "rectangle.stack") { app.perform("sessions") }.disabled(!app.ready)
            Button("Workspace Settings", systemImage: "gearshape") { app.perform("settings") }.disabled(!app.ready)
            Toggle("Terminal Key Row", isOn: $app.keyboardVisible)
            Toggle("Distraction-Free Full Screen", isOn: $app.distractionFree)
                .accessibilityIdentifier("distraction-free-menu")
            Button("Keyboard Shortcuts…", systemImage: "keyboard") { app.sheet = .keyboard }
            Divider()
            Button("Downloads…", systemImage: "arrow.down.circle") { app.sheet = .downloads }
            Button("Import from Files…", systemImage: "folder") { app.importFiles = true }.disabled(!app.ready)
            Button("Import Photos…", systemImage: "photo") { app.importPhotos = true }.disabled(!app.ready)
            Button("App Diagnostics…", systemImage: "waveform.path.ecg") { app.sheet = .diagnostics }
            Button("Privacy…", systemImage: "lock.shield") { app.sheet = .privacy }
            Button("Connection & Installation Help…", systemImage: "questionmark.circle") { app.sheet = .help }
        } label: {
            Image(systemName: "ellipsis.circle.fill").font(.title2).symbolRenderingMode(.palette)
                .foregroundStyle(.primary, .background).frame(minWidth: 44, minHeight: 44)
                .background(.regularMaterial, in: Circle())
        }
        .accessibilityLabel("Tessera app menu")
        .accessibilityHint("Server, reload, keyboard, downloads and app help")
        .accessibilityIdentifier("tessera-app-menu")
    }

    private func connectionFailure(_ advice: ConnectionAdvice) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Image(systemName: "network.slash").font(.largeTitle).accessibilityHidden(true)
                Text(advice.title).font(.title2.bold())
                Text(advice.detail).foregroundStyle(.secondary)
                Text(advice.guidance)
                ViewThatFits {
                    HStack { failureButtons }
                    VStack(alignment: .leading) { failureButtons }
                }
            }.padding(28).frame(maxWidth: 560)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
    }

    @ViewBuilder private var failureButtons: some View {
        Button("Try Again", action: app.reload).buttonStyle(.borderedProminent)
        Button("Saved Servers") { app.sheet = .servers }.buttonStyle(.bordered)
        Button("iPad Settings") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }.buttonStyle(.bordered)
    }

    private func receiveDrop(_ providers: [NSItemProvider]) -> Bool {
        guard providers.count <= 8, app.ready else { app.notice = "Load a workspace and drop at most eight files."; return false }
        let profile = app.selected?.id
        for provider in providers {
            let name = provider.suggestedName ?? "dropped-image.png"
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, error in
                    Task { @MainActor in
                        guard app.selected?.id == profile else { return }
                        if let data, let url = URL(dataRepresentation: data, relativeTo: nil), url.isFileURL { app.importURLs([url]) }
                        else { app.notice = error?.localizedDescription ?? "This dropped file could not be opened." }
                    }
                }
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
                provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                    Task { @MainActor in
                        guard app.selected?.id == profile else { return }
                        do {
                            guard let data else { throw error ?? ImportFailure.tooLarge }
                            let item = try app.importItem(data: data, name: name, type: UTType(type)?.preferredMIMEType ?? "image/png")
                            app.deliverImports([item])
                        } catch { app.notice = error.localizedDescription }
                    }
                }
            }
        }
        return true
    }
}

struct ServerProfilesView: View {
    @Bindable var app: IPadAppModel
    var firstRun = false
    @Environment(\.dismiss) private var dismiss
    @State private var editing: UUID?
    @State private var name = ""
    @State private var address = ""
    @State private var problem: String?
    @State private var removing: ServerProfile?

    var body: some View {
        NavigationStack {
            Form {
                if !app.library.profiles.isEmpty {
                    Section("Saved servers") {
                        ForEach(app.library.profiles) { profile in
                            HStack {
                                Button { app.select(profile.id); dismiss() } label: {
                                    VStack(alignment: .leading) {
                                        Text(profile.displayName).font(.headline)
                                        Text(profile.address.absoluteString).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.accessibilityHint(profile.id == app.selected?.id ? "Current server" : "Connect to this server")
                                if profile.id == app.selected?.id { Image(systemName: "checkmark").accessibilityLabel("Current server") }
                                Button { editing = profile.id; name = profile.name; address = profile.address.absoluteString } label: { Image(systemName: "pencil").frame(minWidth: 44, minHeight: 44) }
                                    .buttonStyle(.borderless).accessibilityLabel("Edit \(profile.displayName)")
                                Button(role: .destructive) { removing = profile } label: { Image(systemName: "trash").frame(minWidth: 44, minHeight: 44) }
                                    .buttonStyle(.borderless).accessibilityLabel("Remove \(profile.displayName)")
                            }
                        }
                    }
                }
                Section(editing == nil ? "Add a server" : "Edit server") {
                    TextField("Name (optional)", text: $name).accessibilityIdentifier("server-profile-name")
                    TextField("studio.tailnet.ts.net or 100.64.0.2:7331", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Server address").accessibilityIdentifier("server-profile-address").onSubmit(save)
                    if let problem { Text(problem).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
                    Button(editing == nil ? "Add and Connect" : "Save and Connect", action: save)
                        .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("server-profile-connect")
                    if editing != nil { Button("Cancel Editing") { editing = nil; name = ""; address = ""; problem = nil } }
                }
                Section("Privacy & connections") {
                    Text("Each new profile has its own sign-in cookies and website storage. Switching servers does not stop their running shells. The first migrated profile keeps the existing app's sign-in data.")
                    Text("A bare hostname uses HTTP on port 7331. Use HTTP only over a trusted network or VPN such as Tailscale. Use a full https:// address for HTTPS. Passwords in addresses are not accepted.")
                }.font(.callout)
            }
            .navigationTitle(firstRun ? "Connect to Tessera" : "Saved Servers")
            .toolbar { if !firstRun { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } } }
            .confirmationDialog("Remove this saved server? Its running shells will not be stopped.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Remove Server", role: .destructive) { if let removing { app.removeServer(removing.id) }; removing = nil }
            }
        }
    }

    private func save() {
        guard editing != nil || app.library.profiles.count < 32 else { problem = "At most 32 servers can be saved."; return }
        switch ServerAddress.parse(address) {
        case .success(let url): app.saveServer(name: name, address: url, editing: editing); dismiss()
        case .failure(let error): problem = error.description
        }
    }
}

struct TerminalKeyBar: View {
    @Bindable var app: IPadAppModel
    @ScaledMetric(relativeTo: .body) private var rowHeight = 68.0
    @State private var ctrl = false
    @State private var alt = false
    private let keys = ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Delete"] + (1...12).map { "F\($0)" }
    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                Toggle("Ctrl", isOn: $ctrl).toggleStyle(.button).accessibilityLabel("Control modifier for next terminal key")
                Toggle("Alt", isOn: $alt).toggleStyle(.button).accessibilityLabel("Alt modifier for next terminal key")
                ForEach(["c", "d", "z", "r"], id: \.self) { letter in
                    Button("^\(letter.uppercased())") { app.sendKey(letter, ctrl: true); ctrl = false; alt = false }
                        .frame(minWidth: 44, minHeight: 44).accessibilityLabel("Terminal Control \(letter.uppercased())")
                }
                ForEach(keys, id: \.self) { key in
                    Button(label(key)) { app.sendKey(key, ctrl: ctrl, alt: alt); ctrl = false; alt = false }
                        .frame(minWidth: 44, minHeight: 44).accessibilityLabel("Terminal \(key)")
                }
                Button("Hide") { app.keyboardVisible = false }.frame(minWidth: 44, minHeight: 44).accessibilityLabel("Hide terminal key row")
            }.buttonStyle(.bordered).padding(8)
        }.frame(height: rowHeight).background(.regularMaterial).accessibilityElement(children: .contain)
    }
    private func label(_ key: String) -> String {
        ["Escape": "Esc", "ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→", "PageUp": "PgUp", "PageDown": "PgDn" ][key] ?? key
    }
}

struct DownloadsView: View {
    @Bindable var app: IPadAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var preview: URL?
    @State private var exporting: URL?
    var body: some View {
        NavigationStack {
            List {
                if app.downloads.isEmpty { Text("No downloads yet. Terminal file transfers will appear here and in Files → On My iPad → Tessera.") }
                ForEach(app.downloads) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.name).font(.headline).textSelection(.enabled)
                        Text(item.error ?? item.status).foregroundStyle(item.error == nil ? Color.secondary : .red)
                        if let file = item.file {
                            ViewThatFits {
                                HStack { fileActions(file) }
                                VStack(alignment: .leading) { fileActions(file) }
                            }
                        } else if let cancel = item.cancel {
                            ProgressView(value: item.total > 0 ? item.fraction : nil)
                                .accessibilityLabel("Download progress").accessibilityValue(item.total > 0 ? "\(Int(item.fraction * 100)) percent" : "Size unknown")
                            Text(ByteCountFormatter.string(fromByteCount: item.received, countStyle: .file)).font(.caption)
                            Button("Cancel Download", role: .cancel, action: cancel)
                        }
                    }.padding(.vertical, 4)
                }
            }.navigationTitle("Downloads")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .sheet(item: Binding(get: { preview.map(ExportFile.init) }, set: { preview = $0?.url })) { file in
                    NavigationStack {
                        DownloadPreviewView(url: file.url)
                            .navigationTitle(file.url.lastPathComponent)
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close Preview") { preview = nil } } }
                    }
                }
                .sheet(item: Binding(get: { exporting.map(ExportFile.init) }, set: { exporting = $0?.url })) { file in FileExportView(url: file.url) }
        }
    }
    @ViewBuilder private func fileActions(_ file: URL) -> some View {
        Button("Preview") { preview = file }.buttonStyle(.bordered)
        ShareLink("Share", item: file).buttonStyle(.bordered)
        Button("Save to Files…") { exporting = file }.buttonStyle(.bordered)
    }
}

private struct ExportFile: Identifiable { let url: URL; var id: String { url.path } }
private struct DownloadPreviewView: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url { context.coordinator.url = url; controller.reloadData() }
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
private struct FileExportView: UIViewControllerRepresentable {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator { dismiss() } }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let close: () -> Void
        init(close: @escaping () -> Void) { self.close = close }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { close() }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { close() }
    }
}

struct ShortcutHelpView: View {
    @Bindable var app: IPadAppModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Hardware keyboard") {
                    ForEach(AppShortcut.all, id: \.command) { shortcut in
                        LabeledContent(shortcut.title, value: "⌘\(shortcut.shifted ? "⇧" : "")\(shortcut.input.uppercased())")
                    }
                    Text("Hold Command to discover supported app shortcuts. iPadOS keeps system combinations such as Command-H, Command-Space and Globe shortcuts. Ordinary Escape, modifiers, function keys and Command-V use WebKit's normal keyboard handling.")
                }
                Section("Terminal controls") {
                    Toggle("Show terminal key row", isOn: $app.keyboardVisible)
                    Text("The key row provides Escape, Tab, arrows, navigation and F1–F12. Ctrl and Alt apply to the next key only. Native app shortcuts never synthesize ordinary text into a terminal or steal keys from native server forms.")
                }
            }.navigationTitle("Keyboard Shortcuts")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct IPadDiagnosticsView: View {
    @Bindable var app: IPadAppModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Display") {
                    Toggle("Distraction-free full screen", isOn: $app.distractionFree)
                        .accessibilityIdentifier("distraction-free-setting")
                    Text("On by default. In an active full-screen workspace, hides the clock/date/battery bar and requests auto-hiding of the Home indicator. Windowed mode and native sheets keep normal system controls. iPadOS may reveal controls for system gestures or alerts. Your choice is saved on this device; Tessera's app menu remains available.")
                }
                Section("Rendering") {
                    Toggle("Prefer high refresh rate", isOn: $app.highRefresh)
                    Text("Allows Tessera terminal rendering above 60 FPS where WebKit and the display permit it. Low Power Mode and the workspace's Older Mac profile retain their limits. It does not force 120 Hz or override iPadOS.")
                    LabeledContent("Display maximum", value: "\(app.webView?.window?.screen.maximumFramesPerSecond ?? 60) Hz")
                    LabeledContent("Low Power Mode", value: ProcessInfo.processInfo.isLowPowerModeEnabled ? "On" : "Off")
                    Button(app.measuring ? "Measuring…" : "Measure WebKit Frame Rate") {
                        dismiss()
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(350))
                            app.measureRefresh()
                        }
                    }.disabled(app.measuring || !app.ready)
                    Text(app.refreshReport).textSelection(.enabled)
                }
                Section("Compare with Safari") {
                    Text("Use the same server, terminal font/grid, workload and network. In each client open workspace Settings → Diagnostics and compare echo and paint timings. Run this frame-rate check with the page visible. Simulator FPS is not evidence of a physical ProMotion rate; callback FPS is not input-to-screen latency.")
                    Button("Open Workspace Diagnostics") { dismiss(); app.perform("settings") }
                }
                Section("App") {
                    LabeledContent("Version", value: Bundle.main.shortVersion)
                    LabeledContent("Network", value: app.online ? "Available" : "Offline")
                    Text("Native clipboard reads require confirmation. Website sign-ins are isolated per saved profile. Diagnostics do not include clipboard contents or authentication cookies.")
                }
            }.navigationTitle("App Diagnostics")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct IPadHelpView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Connect safely") {
                    Text("HTTP is allowed for trusted LAN/VPN connections, including Tailscale; it is not encrypted by Tessera. Use HTTPS on other networks. Keep Tailscale connected and allow Tessera Local Network access in iPad Settings when using a LAN address.")
                    Text("For Local HTTPS, use the exact server hostname, install the server's CA profile, then explicitly enable trust in Settings → General → About → Certificate Trust Settings. Do not trust an unknown CA. Certificate errors are never silently bypassed by this app.")
                    Button("Open iPad App Settings") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
                }
                Section("iPad windows & input") {
                    Text("Distraction-Free Full Screen is enabled by default in the app menu and App Diagnostics → Display. It hides the status bar and requests auto-hiding of the Home indicator only while the workspace fills the display and is active. Windowed multitasking keeps its normal system controls. You can turn it off; this native preference does not change Home Screen web apps.")
                    Text("The workspace stays in tablet/desktop layout in Split View and Stage Manager. The native menu is always reachable by touch. Rotate or resize normally; the app does not reload the workspace or focus a text field. A floating or hardware keyboard does not force the phone layout.")
                    Text("Use a trackpad's secondary click for terminal menus. Native controls support VoiceOver and Dynamic Type; workspace text is independently configured in Settings → Font. File and photo imports open a review/save dialog and never execute a shell command automatically.")
                }
                Section("Install & update") {
                    Text("Install from Xcode with your Apple ID and Developer Mode, or sign the unsigned IPA with SideStore/AltStore. A free Apple ID signature normally needs renewal after seven days. Sideloading tools may temporarily replace Tailscale's VPN while renewing; reconnect it afterward.")
                    Text("To update, install a newly signed build with the same bundle identifier and signing identity without deleting the app. Deleting the app can remove profiles, downloads and sign-ins. Update the Tessera server too for new native integrations. This app does not install updates or privileged certificates in the background.")
                }
            }.navigationTitle("Tessera Help")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
#endif
