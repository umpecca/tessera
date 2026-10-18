import SwiftUI
import TesseraCore

struct ContentView: View {
    /// The parsed server URL, shared by every window.
    @AppStorage("serverURL") private var serverURL = ""
    @State private var editingServer = false
    @State private var failure: String?
    @State private var reloadCount = 0

    var body: some View {
        Group {
            if let url = URL(string: serverURL), !serverURL.isEmpty {
                TesseraWebView(
                    url: url,
                    reloadCount: reloadCount,
                    onFailure: { failure = $0 },
                    onLoad: { failure = nil }
                )
                // The page uses viewport-fit=cover and places its own chrome.
                .ignoresSafeArea()
                .overlay {
                    if let failure {
                        ConnectionFailureView(
                            server: url,
                            message: failure,
                            retry: reload,
                            changeServer: { editingServer = true }
                        )
                    }
                }
            } else {
                ServerAddressForm(initialText: "", onConnect: connect)
            }
        }
        .sheet(isPresented: $editingServer) {
            ServerAddressForm(
                initialText: serverURL,
                onConnect: { url in
                    connect(url)
                    editingServer = false
                },
                onCancel: { editingServer = false }
            )
        }
        .focusedSceneValue(\.serverActions, ServerActions(changeServer: { editingServer = true }, reload: reload))
    }

    private func connect(_ url: URL) {
        failure = nil
        if serverURL == url.absoluteString { reload() } else { serverURL = url.absoluteString }
    }

    private func reload() {
        failure = nil
        reloadCount += 1
    }
}

/// Asks for the server's address: on first launch, and from Change Server.
struct ServerAddressForm: View {
    let initialText: String
    let onConnect: (URL) -> Void
    var onCancel: (() -> Void)?
    @State private var text = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Connect to Tessera")
                .font(.title2.bold())
            Text("Enter the address of a running Tessera server, such as a Tailscale name or IP address. Without a port, Tessera's default 7331 is used.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("studio.tailnet.ts.net or 100.64.0.2:7331", text: $text)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                #endif
                .focused($focused)
                .onSubmit(submit)
            if let problem {
                Text(problem)
                    .foregroundStyle(.red)
                    .font(.callout)
            }
            HStack {
                Spacer()
                if let onCancel {
                    Button("Cancel", role: .cancel, action: onCancel)
                        .keyboardShortcut(.cancelAction)
                }
                Button("Connect", action: submit)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(24)
        .frame(maxWidth: 480)
        .onAppear {
            text = initialText
            focused = true
        }
    }

    private func submit() {
        switch ServerAddress.parse(text) {
        case .success(let url):
            problem = nil
            onConnect(url)
        case .failure(let error):
            problem = error.description
        }
    }
}

/// Shown over the page when the server cannot be reached. Once the page has
/// loaded, Tessera reconnects to the server by itself; this covers the first
/// load and reloads.
struct ConnectionFailureView: View {
    let server: URL
    let message: String
    let retry: () -> Void
    let changeServer: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "network.slash")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Can't reach \(server.host ?? server.absoluteString)")
                .font(.title3.bold())
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack {
                Button("Change Server…", action: changeServer)
                Button("Try Again", action: retry)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
            .padding(.top, 4)
        }
        .padding(28)
        .frame(maxWidth: 440)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}
