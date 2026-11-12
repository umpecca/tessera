import XCTest
import Network

final class FixtureHTTPServer: @unchecked Sendable {
    private let listener: NWListener
    let port: UInt16
    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in if case .ready = state { ready.signal() } }
        listener.newConnectionHandler = { connection in
            connection.start(queue: DispatchQueue.global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                let request = String(data: data ?? Data(), encoding: .utf8) ?? ""
                if request.hasPrefix("GET /download") {
                    let body = "Tessera download fixture\n"
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=test.txt\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                } else {
                    let body = Self.page
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                }
            }
        }
        listener.start(queue: DispatchQueue.global())
        guard ready.wait(timeout: .now() + 10) == .success, let port = listener.port else { throw NSError(domain: "Fixture", code: 1) }
        self.port = port.rawValue
    }
    deinit { listener.cancel() }
    static let page = """
    <!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font:20px sans-serif;padding:100px 20px">
    <p id="cookie"></p><p id="storage"></p><p id="load"></p><p id="command">command:none</p><a href="/download" download>Download test file</a>
    <script>
    const profile=new URLSearchParams(location.search).get('profile') || 'A';
    document.querySelector('#load').textContent='page-load:'+crypto.randomUUID();
    document.querySelector('#cookie').textContent='previous-cookie:'+(document.cookie || 'empty');
    document.querySelector('#storage').textContent='previous-storage:'+(localStorage.getItem('token') || 'empty');
    document.cookie='token='+profile+';path=/'; localStorage.setItem('token',profile);
    let focusRequests=0;
    if(profile==='Focus'){
      const input=document.createElement('input'); input.id='workspace-input'; input.setAttribute('aria-label','Workspace input'); document.body.append(input);
      const status=document.createElement('p'); status.id='focus-status'; status.textContent='focus-requests:0'; document.body.append(status);
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
        app.buttons["tessera-app-menu"].tap()
        let action = app.buttons[item]
        XCTAssertTrue(action.waitForExistence(timeout: 5), item)
        action.tap()
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
