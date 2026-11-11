import Foundation

/// Native presentation policy, independent of UIKit and any particular screen.
public enum IPadPresentation {
    public static func distractionFreePreference(saved: Bool?, legacyStatusBarHidden: Bool?) -> Bool {
        saved ?? legacyStatusBarHidden ?? true
    }

    public static func isFullScreen(width: Double, height: Double, screenWidth: Double, screenHeight: Double) -> Bool {
        guard [width, height, screenWidth, screenHeight].allSatisfy({ $0.isFinite && $0 > 0 }) else { return false }
        // Compare both axes independent of rotation. Use the scene/screen, not
        // the content viewport, which shrinks when a software keyboard appears.
        return abs(min(width, height) - min(screenWidth, screenHeight)) <= 1
            && abs(max(width, height) - max(screenWidth, screenHeight)) <= 1
    }

    public static func hidesSystemUI(enabled: Bool, fullScreen: Bool, active: Bool, workspace: Bool, presentingNativeUI: Bool) -> Bool {
        enabled && fullScreen && active && workspace && !presentingNativeUI
    }
}

public struct AppShortcut: Equatable, Sendable {
    public let command: String
    public let input: String
    public let title: String
    public let shifted: Bool
    public init(_ command: String, _ input: String, _ title: String, shifted: Bool = false) {
        self.command = command; self.input = input; self.title = title; self.shifted = shifted
    }
    public static let all: [AppShortcut] = [
        .init("palette", "k", "Command Palette"), .init("windows", "l", "Window List"),
        .init("sessions", ";", "Session List"), .init("settings", ",", "Workspace Settings"),
        .init("servers", ",", "Saved Servers", shifted: true),
        .init("reload", "r", "Reload Tessera", shifted: true),
        .init("keyboard", "k", "Terminal Keys", shifted: true),
    ]
}

public struct AppRecovery: Equatable, Sendable {
    public private(set) var active = true
    public private(set) var reloadPending = false
    public init() {}
    /// Returns whether a visible, dead web process needs one reload. A healthy
    /// foreground transition reconnects the existing page instead of replacing it.
    public mutating func setActive(_ value: Bool) -> Bool {
        active = value
        if value && reloadPending { reloadPending = false; return true }
        return false
    }
    public mutating func processTerminated() -> Bool {
        reloadPending = !active
        return active
    }
}

public struct ConnectionAdvice: Equatable, Sendable {
    public let title: String
    public let detail: String
    public let guidance: String
    public init(errorCode: Int, description: String) {
        switch errorCode {
        case -1200, -1201, -1202, -1203, -1204, -1205, -1206:
            title = "HTTPS certificate could not be verified"
            detail = description
            guidance = "Use the server's correct HTTPS hostname and a trusted, unexpired certificate. For Tessera Local HTTPS, install its CA profile and explicitly enable certificate trust in iPad Settings. The app never bypasses certificate validation."
        case -1003, -1006:
            title = "Server name could not be found"
            detail = description
            guidance = "Check the hostname, Tailscale connection and MagicDNS. Try the server's Tailscale IP address with its port (usually 7331)."
        case -1009, -1020:
            title = "Network access is unavailable"
            detail = description
            guidance = "Check Wi-Fi or Tailscale. In Settings → Apps → Tessera, allow Local Network access when connecting to a LAN server. iPadOS can report a denied local-network permission as an offline connection."
        default:
            title = "Can't connect to Tessera"
            detail = description
            guidance = "Check that the server is running, the address and port are correct, and Wi-Fi/Tailscale can reach it. HTTP is appropriate only on a trusted network or VPN; otherwise use HTTPS."
        }
    }
}
