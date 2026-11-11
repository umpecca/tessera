import Foundation

/// Local presentation/access lock, not server authentication or encryption.
public struct AppPrivacy: Equatable, Sendable {
    public enum Authentication: Equatable, Sendable { case unlock, setLock(Bool) }
    public var shieldEnabled: Bool
    public private(set) var lockEnabled: Bool
    public private(set) var active = true
    public private(set) var locked: Bool
    public private(set) var unlockedThisLaunch: Bool
    public private(set) var authentication: Authentication?
    private var generation = 0
    private var automaticUnlockAvailable = true

    public init(shieldEnabled: Bool = true, lockEnabled: Bool = false) {
        self.shieldEnabled = shieldEnabled
        self.lockEnabled = lockEnabled
        locked = lockEnabled
        unlockedThisLaunch = !lockEnabled
    }

    public var coversContent: Bool { locked || (shieldEnabled && !active) }
    public var allowsAccess: Bool { !locked && unlockedThisLaunch }
    public func authenticationIsCurrent(_ token: Int) -> Bool { generation == token && authentication != nil }

    public mutating func setActive(_ value: Bool, background: Bool = false) {
        active = value
        if background {
            generation += 1
            authentication = nil
            if lockEnabled { locked = true }
            automaticUnlockAvailable = true
        }
    }

    /// Permission/authentication sheets cause inactivity, not backgrounding.
    /// Only a genuine background transition grants another automatic attempt.
    public mutating func beginAutomaticUnlock() -> Int? {
        guard automaticUnlockAvailable, let token = beginAuthentication(.unlock) else { return nil }
        automaticUnlockAvailable = false
        return token
    }

    public mutating func beginAuthentication(_ operation: Authentication) -> Int? {
        guard active, authentication == nil else { return nil }
        switch operation {
        case .unlock:
            guard locked && lockEnabled else { return nil }
            automaticUnlockAvailable = false
        case .setLock(let enabled): guard allowsAccess && enabled != lockEnabled else { return nil }
        }
        generation += 1
        authentication = operation
        return generation
    }

    @discardableResult public mutating func finishAuthentication(token: Int, success: Bool) -> Bool {
        guard token == generation, let operation = authentication else { return false }
        authentication = nil
        if success {
            switch operation { case .unlock: break; case .setLock(let enabled): lockEnabled = enabled }
            locked = false
            unlockedThisLaunch = true
        }
        return true
    }

    /// Respect device-local preference changes when another scene returns.
    public mutating func applySavedLock(_ enabled: Bool) {
        guard enabled != lockEnabled else { return }
        generation += 1
        authentication = nil
        lockEnabled = enabled
        locked = enabled
        if !enabled { unlockedThisLaunch = true }
        automaticUnlockAvailable = true
    }
}
