import Testing
@testable import TesseraCore

private func requireToken(_ token: Int?) throws -> Int { try #require(token) }

@Suite struct AppPrivacyTests {
    @Test func shieldDefaultsOnAndCoversTransientInactivityWithoutLocking() {
        var state = AppPrivacy()
        #expect(state.shieldEnabled && !state.lockEnabled && state.allowsAccess)
        #expect(!state.coversContent)
        state.setActive(false)
        #expect(state.coversContent && state.allowsAccess)
        state.setActive(true)
        #expect(!state.coversContent && state.beginAutomaticUnlock() == nil)
        state.setActive(false, background: true)
        state.setActive(true)
        #expect(!state.coversContent && state.allowsAccess)
    }

    @Test func aSavedLockPreventsColdLaunchAccessAndCannotBeDisabledWhileLocked() throws {
        var state = AppPrivacy(lockEnabled: true)
        #expect(state.coversContent && !state.allowsAccess && !state.unlockedThisLaunch)
        #expect(state.beginAuthentication(.setLock(false)) == nil)
        let token = try requireToken(state.beginAutomaticUnlock())
        #expect(state.beginAuthentication(.unlock) == nil)
        state.setActive(false) // Face ID/passcode sheet, not app backgrounding.
        let completed = state.finishAuthentication(token: token, success: true)
        #expect(completed)
        #expect(state.allowsAccess && state.unlockedThisLaunch && state.coversContent)
        state.setActive(true)
        #expect(!state.coversContent)
    }

    @Test func lockChangesRequireSuccessfulAuthenticationAndCancelledEnablingDoesNotLockOut() throws {
        var state = AppPrivacy()
        let denied = try requireToken(state.beginAuthentication(.setLock(true)))
        state.finishAuthentication(token: denied, success: false)
        #expect(!state.lockEnabled && state.allowsAccess)
        let accepted = try requireToken(state.beginAuthentication(.setLock(true)))
        state.finishAuthentication(token: accepted, success: true)
        #expect(state.lockEnabled && state.allowsAccess)
        let disable = try requireToken(state.beginAuthentication(.setLock(false)))
        state.finishAuthentication(token: disable, success: false)
        #expect(state.lockEnabled)
        let confirmedDisable = try requireToken(state.beginAuthentication(.setLock(false)))
        state.finishAuthentication(token: confirmedDisable, success: true)
        #expect(!state.lockEnabled && state.allowsAccess)
    }

    @Test func cancelledAutomaticUnlockStaysLockedWithoutPromptLoopsAndManualRetryWorks() throws {
        var state = AppPrivacy(lockEnabled: true)
        let token = try requireToken(state.beginAutomaticUnlock())
        state.setActive(false)
        state.setActive(true)
        #expect(state.beginAutomaticUnlock() == nil, "Do not stack prompts while one is in progress")
        state.finishAuthentication(token: token, success: false)
        state.setActive(false); state.setActive(true)
        #expect(state.beginAutomaticUnlock() == nil, "Cancellation is not a new app-return event")
        #expect(!state.allowsAccess && state.coversContent)
        let retry = try requireToken(state.beginAuthentication(.unlock))
        state.finishAuthentication(token: retry, success: true)
        #expect(state.allowsAccess)
        state.setActive(false, background: true)
        state.setActive(true)
        #expect(state.beginAutomaticUnlock() != nil, "A genuine background/return permits one automatic attempt")
    }

    @Test func backgroundingInvalidatesLateSuccessAndCannotChangeLockSettings() throws {
        var enabling = AppPrivacy()
        let old = try requireToken(enabling.beginAuthentication(.setLock(true)))
        enabling.setActive(false, background: true)
        let acceptedLateEnable = enabling.finishAuthentication(token: old, success: true)
        #expect(!acceptedLateEnable)
        #expect(!enabling.lockEnabled)
        var locked = AppPrivacy(lockEnabled: true)
        let first = try requireToken(locked.beginAutomaticUnlock())
        locked.setActive(false, background: true); locked.setActive(true)
        let second = try requireToken(locked.beginAutomaticUnlock())
        let acceptedLateUnlock = locked.finishAuthentication(token: first, success: true)
        #expect(!acceptedLateUnlock)
        #expect(locked.locked)
        #expect(locked.authenticationIsCurrent(second))
        locked.finishAuthentication(token: second, success: true)
        #expect(locked.allowsAccess)
    }

    @Test func aLockStillCoversContentWhenPreviewShieldIsDisabled() throws {
        var state = AppPrivacy(shieldEnabled: false, lockEnabled: true)
        let token = try requireToken(state.beginAutomaticUnlock())
        state.finishAuthentication(token: token, success: true)
        state.setActive(false)
        #expect(!state.coversContent)
        state.setActive(false, background: true)
        #expect(state.coversContent && !state.allowsAccess)
        state.applySavedLock(false)
        #expect(state.allowsAccess)
        state.applySavedLock(true)
        #expect(state.locked && !state.allowsAccess)
    }
}
