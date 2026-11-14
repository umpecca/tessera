import XCTest
import Network
import Security

final class FixtureHTTPServer: @unchecked Sendable {
    private let listener: NWListener
    private(set) var port: UInt16 = 0
    private let stopped = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var received: [String] = []
    var requests: [String] { lock.withLock { received } }
    init(port: UInt16 = 0, identity: SecIdentity? = nil, extraHTML: String = "") throws {
        let parameters: NWParameters
        if let identity {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tls.securityProtocolOptions, sec_identity_create(identity)!)
            parameters = NWParameters(tls: tls)
        } else { parameters = .tcp }
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters, on: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!)
        let ready = DispatchSemaphore(value: 0)
        let stopped = stopped
        listener.stateUpdateHandler = { state in
            switch state { case .ready, .failed: ready.signal(); case .cancelled: stopped.signal(); default: break }
        }
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: DispatchQueue.global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
                guard let data, !data.isEmpty else { connection.cancel(); return }
                let request = String(data: data, encoding: .utf8) ?? ""
                self?.lock.withLock { self?.received.append(request) }
                if request.hasPrefix("HEAD ") {
                    let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nSet-Cookie: probe-only=must-not-leak; Path=/\r\nConnection: close\r\n\r\n"
                    connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                } else if request.hasPrefix("GET /download") {
                    let body = "Tessera download fixture\n"
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=test.txt\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                } else {
                    let body = Self.page + extraHTML
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                }
            }
        }
        listener.start(queue: DispatchQueue.global())
        guard ready.wait(timeout: .now() + 10) == .success else {
            listener.cancel()
            throw NSError(domain: "Fixture listener not ready (requested port \(port))", code: 1)
        }
        if case .failed(let error) = listener.state { listener.cancel(); throw error }
        guard case .ready = listener.state, let boundPort = listener.port, port == 0 || boundPort.rawValue == port else {
            listener.cancel(); throw NSError(domain: "Fixture bound wrong port", code: 1)
        }
        self.port = boundPort.rawValue
    }
    deinit { listener.cancel() }
    func stop() { listener.cancel(); _ = stopped.wait(timeout: .now() + 10) }
    static func portIsReachable(_ port: UInt16) -> Bool {
        // A wildcard listener can coexist with this fixture's more-specific
        // loopback bind. Check before claiming the port, otherwise stopping a
        // temporary listener merely reveals the person's HTTPS server beneath it.
        let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        let changed = DispatchSemaphore(value: 0)
        connection.stateUpdateHandler = { state in
            switch state { case .ready, .failed, .cancelled: changed.signal(); default: break }
        }
        connection.start(queue: .global())
        let signalled = changed.wait(timeout: .now() + 2) == .success
        let reachable: Bool
        if signalled, case .ready = connection.state { reachable = true } else { reachable = false }
        connection.cancel()
        return reachable
    }
    static func identity(_ name: String) throws -> SecIdentity {
        let bundle = Bundle(for: IPadAppUITests.self)
        guard let url = bundle.url(forResource: "loopback-\(name)", withExtension: "p12", subdirectory: "Fixtures")
            ?? bundle.url(forResource: "loopback-\(name)", withExtension: "p12") else { throw NSError(domain: "Missing TLS fixture", code: 1) }
        let data = try Data(contentsOf: url)
        var items: CFArray?
        let result = SecPKCS12Import(data as CFData, [kSecImportExportPassphrase as String: "fixture-only"] as CFDictionary, &items)
        guard result == errSecSuccess, let first = (items as? [[String: Any]])?.first,
              let identity = first[kSecImportItemIdentity as String] else { throw NSError(domain: "TLS fixture identity", code: Int(result)) }
        return identity as! SecIdentity
    }
    static let page = """
    <!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font:20px sans-serif;padding:100px 20px">
    <p id="cookie"></p><p id="storage"></p><p id="load"></p><p id="command">command:none</p><a href="/download" download>Download test file</a>
    <script>
    const profile=new URLSearchParams(location.search).get('profile') || 'A';
    document.querySelector('#load').textContent='page-load:'+crypto.randomUUID();
    document.querySelector('#cookie').textContent='previous-cookie:'+(document.cookie || 'empty');
    document.querySelector('#storage').textContent='previous-storage:'+(localStorage.getItem('token') || 'empty');
    document.cookie='token='+profile+';path=/;max-age=3600'; localStorage.setItem('token',profile);
    let focusRequests=0;
    if(profile==='Focus'){
      const input=document.createElement('input'); input.id='workspace-input'; input.setAttribute('aria-label','Workspace input'); document.body.append(input);
      const status=document.createElement('p'); status.id='focus-status'; status.textContent='focus-requests:0'; document.body.append(status);
      const geometry=document.createElement('p'); geometry.id='geometry'; document.body.append(geometry);
      function size(){geometry.textContent='workspace-size:'+innerWidth+'x'+innerHeight;}size();addEventListener('resize',size);
    }
    window.tesseraNativeApp={
      perform(command,payload){
        document.querySelector('#command').textContent='command:'+command+(payload.key?':'+payload.key:'');
        if(profile==='Focus'){
          if(command==='suspend')document.activeElement?.blur();
          if(command==='resume'&&payload.restoreFocus===true){document.querySelector('#workspace-input').focus();document.querySelector('#focus-status').textContent='focus-requests:'+(++focusRequests);}
        }
        return {ok:true};
      },
      measureRefreshRate(duration){return new Promise(resolve=>{let first=null,frames=0;function sample(t){if(first===null)first=t;else frames++;if(t-first>=duration)resolve({fps:frames*1000/(t-first)});else requestAnimationFrame(sample)}requestAnimationFrame(sample)});}
    };
    </script></body></html>
    """
}

@MainActor
final class IPadAppUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func enterServer(_ app: XCUIApplication, address: String, name: String) {
        let nameField = app.textFields["server-profile-name"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 10))
        nameField.tap(); nameField.typeText(name)
        let addressField = app.textFields["server-profile-address"]
        addressField.tap(); addressField.typeText(address)
        app.buttons["server-profile-connect"].tap()
    }
    private func connect(_ app: XCUIApplication, server: FixtureHTTPServer, name: String = "Server A", profile: String = "A") {
        let nameField = app.textFields["server-profile-name"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 10))
        nameField.tap(); nameField.typeText(name)
        let address = app.textFields["server-profile-address"]
        address.tap(); address.typeText("http://127.0.0.1:\(server.port)/?profile=\(profile)")
        app.buttons["server-profile-connect"].tap()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:empty"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 5))
    }

    private func menu(_ app: XCUIApplication, _ item: String) {
        let button = app.buttons["tessera-app-menu"]
        if button.value as? String == "Hidden" { button.tap() }
        button.tap()
        let action = app.buttons[item]
        XCTAssertTrue(action.waitForExistence(timeout: 5), item)
        action.tap()
    }

    func testBareHostPrefersHTTPSAndCertificateCancellationNeverFallsBack() throws {
        let http: FixtureHTTPServer, https: FixtureHTTPServer
        do {
            http = try FixtureHTTPServer(port: 7331)
            https = try FixtureHTTPServer(port: 7332, identity: FixtureHTTPServer.identity("a"))
        } catch NWError.posix(.EADDRINUSE) { throw XCTSkip("Default loopback ports are already in use") }
        defer { http.stop(); https.stop() }
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch()
        enterServer(app, address: "127.0.0.1/?profile=TLS", name: "Default TLS")
        XCTAssertTrue(app.alerts["Server Certificate"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.alerts.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "SHA-256")).firstMatch.exists)
        app.alerts.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["server-profile-connect"].isEnabled)
        XCTAssertFalse(app.webViews.firstMatch.exists)
        XCTAssertTrue(http.requests.isEmpty, "Rejecting an HTTPS certificate must not probe HTTP")
        app.buttons["server-profile-connect"].tap()
        XCTAssertTrue(app.alerts["Server Certificate"].waitForExistence(timeout: 10))
        // Human certificate review must not be cut short by the network timeout.
        Thread.sleep(forTimeInterval: 10)
        XCTAssertTrue(app.alerts["Server Certificate"].exists)
        app.alerts.buttons["Accept Certificate"].tap()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:empty"].waitForExistence(timeout: 15))
        XCTAssertTrue(http.requests.isEmpty, "HTTPS must win when both listeners exist")
        let probes = https.requests.filter { $0.hasPrefix("HEAD ") }
        XCTAssertFalse(probes.isEmpty)
        XCTAssertTrue(probes.allSatisfy { !$0.lowercased().contains("\r\ncookie:") && !$0.lowercased().contains("\r\nauthorization:") && $0.hasPrefix("HEAD /api/health ") })
        menu(app, "Saved Servers…")
        XCTAssertTrue(app.staticTexts["https://127.0.0.1:7332/?profile=TLS"].exists)
        app.terminate()
    }

    func testBareHostUsesDefaultHTTPWhenHTTPSIsUnreachable() throws {
        guard !FixtureHTTPServer.portIsReachable(7332) else {
            throw XCTSkip("An existing HTTPS listener owns 7332; leave it running rather than testing downgrade against a live server")
        }
        let http: FixtureHTTPServer
        do {
            let availability = try FixtureHTTPServer(port: 7332)
            availability.stop()
            http = try FixtureHTTPServer(port: 7331)
        } catch NWError.posix(.EADDRINUSE) { throw XCTSkip("Default loopback ports are already in use") }
        defer { http.stop() }
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch()
        enterServer(app, address: "127.0.0.1", name: "Default HTTP")
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:empty"].waitForExistence(timeout: 15), "HTTP requests: \(http.requests)")
        XCTAssertFalse(app.alerts["Server Certificate"].exists)
        menu(app, "Saved Servers…")
        XCTAssertTrue(app.staticTexts["http://127.0.0.1:7331/"].exists)
        app.terminate()
    }

    func testAcceptedCertificatePersistsChangesRequireApprovalAndTrustCanBeForgotten() throws {
        let iframe = try FixtureHTTPServer(identity: FixtureHTTPServer.identity("a"))
        let first = try FixtureHTTPServer(identity: FixtureHTTPServer.identity("a"),
            extraHTML: "<iframe src='https://127.0.0.1:\(iframe.port)/unrelated'></iframe>")
        let port = first.port
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests", "--tessera-ui-tests-id=\(UUID().uuidString)"]
        app.launch()
        enterServer(app, address: "https://127.0.0.1:\(port)/?profile=A", name: "TLS Server")
        XCTAssertTrue(app.alerts["Server Certificate"].waitForExistence(timeout: 10))
        app.alerts.buttons["Accept Certificate"].tap()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:empty"].waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(iframe.requests.isEmpty, "An iframe on another port must not inherit even the identical accepted certificate")
        XCTAssertFalse(app.alerts["Server Certificate"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:token=A"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.alerts["Server Certificate"].exists, "Matching pin survives relaunch")
        let probes = first.requests.filter { $0.hasPrefix("HEAD ") }
        XCTAssertTrue(probes.allSatisfy { !$0.lowercased().contains("\r\ncookie:") && !$0.lowercased().contains("\r\nauthorization:") })
        app.terminate(); first.stop()
        let changed = try FixtureHTTPServer(port: port, identity: FixtureHTTPServer.identity("b"))
        defer { changed.stop(); iframe.stop() }
        app.launch()
        XCTAssertTrue(app.alerts["Certificate Changed"].waitForExistence(timeout: 15))
        app.alerts.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Try Again"].waitForExistence(timeout: 10))
        app.buttons["Try Again"].tap()
        XCTAssertTrue(app.alerts["Certificate Changed"].waitForExistence(timeout: 10), "Cancellation must not replace the saved pin")
        app.alerts.buttons["Accept Certificate"].tap()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:token=A"].waitForExistence(timeout: 15), "Certificate rotation must preserve profile cookies")
        app.terminate(); app.launch()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:token=A"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.alerts["Certificate Changed"].exists)
        menu(app, "Saved Servers…")
        app.buttons["Edit TLS Server"].tap()
        let forget = app.buttons["server-certificate-forget"]
        XCTAssertTrue(forget.waitForExistence(timeout: 5))
        if !forget.isHittable { app.swipeUp() }
        forget.tap()
        XCTAssertTrue(app.alerts["Server Certificate"].waitForExistence(timeout: 10), "Forget must force a fresh check despite WebKit TLS caching")
        app.alerts.buttons["Cancel"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.alerts["Server Certificate"].waitForExistence(timeout: 15), "Forget persists across relaunch")
        app.alerts.buttons["Cancel"].tap()
        app.terminate()
    }

    func testBackgroundCancelsCertificateReviewWithoutSavingAProfile() throws {
        let server = try FixtureHTTPServer(identity: FixtureHTTPServer.identity("a"))
        defer { server.stop() }
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch()
        enterServer(app, address: "https://127.0.0.1:\(server.port)", name: "Cancelled")
        XCTAssertTrue(app.alerts["Server Certificate"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.buttons["server-profile-connect"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.alerts["Server Certificate"].exists)
        XCTAssertFalse(app.webViews.firstMatch.exists, "Stale acceptance must never save/connect")
        app.buttons["server-profile-connect"].tap()
        XCTAssertTrue(app.alerts["Server Certificate"].waitForExistence(timeout: 10), "Cancellation must not persist approval")
        app.alerts.buttons["Cancel"].tap()
        app.terminate()
    }

    func testIdleAppMenuHidesRevealsAndKeepsOpenMenusAndWorkspaceUsable() throws {
        let server = try FixtureHTTPServer()
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch(); connect(app, server: server, profile: "Focus")
        let button = app.buttons["tessera-app-menu"]
        let input = app.webViews.textFields["Workspace input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        app.typeText("before")
        let load = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "page-load:")).firstMatch
        let geometry = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "workspace-size:")).firstMatch
        let focus = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "focus-requests:")).firstMatch
        let loadID = load.label, size = geometry.label, focusRequests = focus.label
        let hidden = NSPredicate(format: "value == %@", "Hidden")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: hidden, object: button)], timeout: 7), .completed)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Idle workspace without ellipsis decoration"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.typeText("hidden")
        XCTAssertEqual(input.value as? String, "beforehidden", "Hiding must not blur the workspace")
        input.tap()
        XCTAssertEqual(button.value as? String, "Hidden", "Normal workspace touches/typing must not reveal the menu")
        // WebKit may select existing text when an already-focused field is
        // tapped. Type once before measuring corner-reveal focus preservation.
        app.typeText("touched")
        let textBeforeReveal = input.value as? String ?? ""
        // Tap the actual corner coordinates, not just its accessibility action.
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(button.value as? String, "Visible")
        XCTAssertFalse(app.buttons["Saved Servers…"].exists, "First tap reveals without opening")
        app.typeText("revealed")
        XCTAssertEqual(input.value as? String, textBeforeReveal + "revealed", "Revealing must not steal keyboard focus")
        Thread.sleep(forTimeInterval: 3)
        app.typeText("typing")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: hidden, object: button)], timeout: 3), .completed, "Typing must not reset the five-second timeout")
        button.tap(); button.tap()
        let action = app.buttons["Command Palette"]
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 6)
        XCTAssertEqual(button.value as? String, "Visible", "An open menu cannot time out")
        XCTAssertTrue(action.isHittable)
        action.tap()
        XCTAssertTrue(app.webViews.staticTexts["command:palette"].waitForExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: hidden, object: button)], timeout: 7), .completed, "Selection starts another timeout")
        button.tap(); button.tap()
        XCTAssertTrue(app.buttons["Saved Servers…"].waitForExistence(timeout: 5))
        // Dismiss without selecting an action; the lifecycle callback must still
        // restart the timer rather than leaving the control visible forever.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.7)).tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: hidden, object: button)], timeout: 7), .completed)
        XCTAssertEqual(load.label, loadID)
        XCTAssertEqual(geometry.label, size, "Decoration must not resize the workspace")
        XCTAssertEqual(focus.label, focusRequests, "Decoration must not request native workspace focus")
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertEqual(button.value as? String, "Visible", "Foreground entry offers a fresh discovery period")
        app.terminate()
    }

    func testProfilesRetainIndependentCookiesAndWebsiteStorage() throws {
        let server = try FixtureHTTPServer()
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch()
        connect(app, server: server)
        menu(app, "Saved Servers…")
        connect(app, server: server, name: "Server B", profile: "B")
        XCTAssertTrue(app.webViews.staticTexts["previous-storage:empty"].exists)
        menu(app, "Saved Servers…")
        app.staticTexts["Server A"].tap()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:token=A"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.webViews.staticTexts["previous-storage:A"].exists)
        menu(app, "Saved Servers…")
        app.staticTexts["Server B"].tap()
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:token=B"].waitForExistence(timeout: 15))
        app.terminate()
    }

    func testTouchControlsKeyboardRowDownloadsDiagnosticsAndRotation() throws {
        let server = try FixtureHTTPServer()
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch()
        connect(app, server: server)
        menu(app, "Command Palette")
        XCTAssertTrue(app.webViews.staticTexts["command:palette"].waitForExistence(timeout: 5))
        menu(app, "Keyboard Shortcuts…")
        XCTAssertTrue(app.navigationBars["Keyboard Shortcuts"].waitForExistence(timeout: 5))
        app.swipeUp()
        let toggle = app.switches["Show terminal key row"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let keyboardHelp = XCTAttachment(screenshot: app.screenshot())
        keyboardHelp.name = "Keyboard shortcut help and toggle"
        keyboardHelp.lifetime = .keepAlways
        add(keyboardHelp)
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(toggle.value as? String, "1")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Terminal Escape"].waitForExistence(timeout: 5))
        app.buttons["Terminal Escape"].tap()
        XCTAssertTrue(app.webViews.staticTexts["command:key:Escape"].waitForExistence(timeout: 5))
        app.buttons["Terminal Control C"].tap()
        XCTAssertTrue(app.webViews.staticTexts["command:key:c"].waitForExistence(timeout: 5))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.buttons["tessera-app-menu"].isHittable)
        XCUIDevice.shared.orientation = .portrait
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["previous-cookie:empty"].exists, "Healthy resume reloaded the fixture")
        app.webViews.links["Download test file"].tap()
        menu(app, "Downloads…")
        XCTAssertTrue(app.staticTexts["test.txt"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Preview"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Share"].exists)
        XCTAssertTrue(app.buttons["Save to Files…"].exists)
        app.buttons["Preview"].tap()
        XCTAssertTrue(app.buttons["Close Preview"].waitForExistence(timeout: 10))
        app.buttons["Close Preview"].tap()
        XCTAssertTrue(app.navigationBars["Downloads"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        menu(app, "App Diagnostics…")
        app.buttons["Measure WebKit Frame Rate"].tap()
        let result = app.alerts.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "WebKit requestAnimationFrame:")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
        menu(app, "Connection & Installation Help…")
        XCTAssertTrue(app.navigationBars["Tessera Help"].waitForExistence(timeout: 5))
        app.terminate()
    }

    func testDistractionFreeDefaultsToFullscreenAndPersistsOverrides() throws {
        let server = try FixtureHTTPServer()
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests", "--tessera-ui-tests-id=\(UUID().uuidString)"]
        app.launch()
        connect(app, server: server)
        // Recent iPadOS exposes the system status bar through SpringBoard,
        // outside the app's accessibility hierarchy.
        let statusBar = XCUIApplication(bundleIdentifier: "com.apple.springboard").statusBars.firstMatch
        let defaultHidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: statusBar)
        XCTAssertEqual(XCTWaiter.wait(for: [defaultHidden], timeout: 5), .completed, "Fullscreen workspace is distraction-free by default")
        menu(app, "App Diagnostics…")
        let toggle = app.switches["distraction-free-setting"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "1")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(toggle.value as? String, "0")
        app.buttons["Done"].tap()
        XCTAssertTrue(statusBar.waitForExistence(timeout: 5), "An explicit opt-out restores the bar")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 15))
        XCTAssertTrue(statusBar.waitForExistence(timeout: 5), "Visible override survives relaunch")
        let pageLoad = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "page-load:")).firstMatch
        XCTAssertTrue(pageLoad.waitForExistence(timeout: 10))
        let loadID = pageLoad.label
        menu(app, "App Diagnostics…")
        XCTAssertEqual(toggle.value as? String, "0")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        app.buttons["Done"].tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: statusBar)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertTrue(app.buttons["tessera-app-menu"].isHittable, "The control to restore the bar must stay reachable")
        XCTAssertEqual(pageLoad.label, loadID, "Changing display preferences must not reload the workspace")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Default distraction-free native workspace"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertFalse(statusBar.exists)
        XCTAssertTrue(app.buttons["tessera-app-menu"].isHittable)
        XCUIDevice.shared.orientation = .portrait
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 10))
        let resumedHidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: statusBar)
        XCTAssertEqual(XCTWaiter.wait(for: [resumedHidden], timeout: 5), .completed, "Immersion returns when the app is focused again")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 15))
        XCTAssertFalse(statusBar.exists, "Hidden preference survives relaunch")
        app.terminate()
    }

    func testForegroundRequestsWorkspaceFocusButNotBehindNativeSheets() throws {
        let server = try FixtureHTTPServer()
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch(); connect(app, server: server, profile: "Focus")
        let input = app.webViews.textFields["Workspace input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let status = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "focus-requests:")).firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        let load = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "page-load:")).firstMatch.label
        let before = status.label
        XCUIDevice.shared.press(.home); app.activate()
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", before), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 10), .completed)
        app.typeText("foreground")
        XCTAssertEqual(input.value as? String, "foreground", "Typing after return must not require a field tap")
        XCTAssertEqual(app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "page-load:")).firstMatch.label, load)
        let focused = status.label
        menu(app, "Saved Servers…")
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.navigationBars["Saved Servers"].waitForExistence(timeout: 10))
        app.buttons["Done"].tap()
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertEqual(status.label, focused, "Native sheets must not request workspace text focus")
        app.terminate()
    }

    func testPrivacyShieldCoversNativeSheetsAndPreservesTheWorkspace() throws {
        let server = try FixtureHTTPServer()
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests"]
        app.launch(); connect(app, server: server)
        let pageLoad = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "page-load:")).firstMatch
        let loadID = pageLoad.label
        menu(app, "Privacy…")
        let shield = app.switches["privacy-shield-setting"]
        XCTAssertTrue(shield.waitForExistence(timeout: 5))
        XCTAssertEqual(shield.value as? String, "1", "Preview protection defaults on")
        XCTAssertEqual(app.switches["privacy-lock-setting"].value as? String, "0", "Device lock is opt-in")
        app.buttons["privacy-preview"].tap()
        XCTAssertTrue(app.buttons["privacy-dismiss-preview"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Privacy"].exists, "Opaque cover must hide native settings sheets too")
        XCTAssertFalse(app.webViews.firstMatch.exists, "Covered web contents must not remain accessible")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Opaque privacy shield over a native sheet"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["privacy-dismiss-preview"].tap()
        XCTAssertTrue(app.navigationBars["Privacy"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertEqual(pageLoad.label, loadID, "Preview must not replace/reload the workspace")
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["privacy-unlock"].exists, "A shield without a lock returns without authentication")
        XCTAssertEqual(pageLoad.label, loadID)
        app.terminate()
    }

    func testOptInDeviceLockRejectsCancellationAndProtectsBackgroundAndColdLaunch() throws {
        let server = try FixtureHTTPServer()
        let app = XCUIApplication()
        let suite = "--tessera-ui-tests-id=\(UUID().uuidString)"
        // Authentication responses are injected ONLY in DEBUG simulator UI tests.
        // Release builds always use LocalAuthentication and device-owner policy.
        app.launchArguments = ["--tessera-ui-tests", suite, "--tessera-ui-tests-auth=cancel,success,cancel,success"]
        app.launch(); connect(app, server: server)
        let pageLoad = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "page-load:")).firstMatch
        let loadID = pageLoad.label
        menu(app, "Privacy…")
        let toggle = app.switches["privacy-lock-setting"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts["privacy-auth-error"].waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "0", "Cancelled enabling must leave the lock disabled")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: toggle)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed)
        app.buttons["Done"].tap()
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.buttons["privacy-unlock"].waitForExistence(timeout: 10), "Cancelled automatic unlock must remain locked")
        XCTAssertFalse(app.webViews.firstMatch.exists)
        XCTAssertFalse(app.buttons["tessera-app-menu"].exists)
        app.buttons["privacy-unlock"].tap()
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 10))
        XCTAssertEqual(pageLoad.label, loadID, "Unlocking must retain the existing workspace")
        app.terminate()
        app.launchArguments = ["--tessera-ui-tests", suite, "--tessera-ui-tests-auth=cancel,success,success"]
        app.launch()
        XCTAssertTrue(app.buttons["privacy-unlock"].waitForExistence(timeout: 10), "Saved lock must protect cold launch")
        XCTAssertFalse(app.webViews.firstMatch.exists, "Do not load a saved workspace before initial unlock")
        app.buttons["privacy-unlock"].tap()
        XCTAssertTrue(app.webViews.staticTexts["previous-storage:A"].waitForExistence(timeout: 15))
        menu(app, "Privacy…")
        XCTAssertEqual(toggle.value as? String, "1")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let disabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0"), object: toggle)
        XCTAssertEqual(XCTWaiter.wait(for: [disabled], timeout: 5), .completed)
        app.buttons["Done"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tessera-app-menu"].waitForExistence(timeout: 15), "Disabling the lock is persisted too")
        XCTAssertFalse(app.buttons["privacy-unlock"].exists)
        app.terminate()
    }

    func testNativeFirstRunSupportsLargeTextAndAccessibleDescriptions() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--tessera-ui-tests", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Connect to Tessera"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["Server address"].exists)
        try app.performAccessibilityAudit(for: .sufficientElementDescription)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Native first run at accessibility XXXL"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.terminate()
    }
}
