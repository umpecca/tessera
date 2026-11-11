import Foundation
import Testing
@testable import TesseraCore

@Suite struct IPadFeaturesTests {
    @Test func distractionFreeDefaultsOnAndPreservesExplicitPreferences() {
        #expect(IPadPresentation.distractionFreePreference(saved: nil, legacyStatusBarHidden: nil))
        #expect(!IPadPresentation.distractionFreePreference(saved: false, legacyStatusBarHidden: true))
        #expect(IPadPresentation.distractionFreePreference(saved: true, legacyStatusBarHidden: false))
        #expect(!IPadPresentation.distractionFreePreference(saved: nil, legacyStatusBarHidden: false))
        #expect(IPadPresentation.distractionFreePreference(saved: nil, legacyStatusBarHidden: true))
    }

    @Test func fullScreenGeometryExcludesSplitViewAndStageManagerAndHandlesRotation() {
        #expect(IPadPresentation.isFullScreen(width: 834, height: 1210, screenWidth: 834, screenHeight: 1210))
        #expect(IPadPresentation.isFullScreen(width: 1210, height: 834, screenWidth: 834, screenHeight: 1210))
        #expect(!IPadPresentation.isFullScreen(width: 600, height: 1210, screenWidth: 834, screenHeight: 1210))
        #expect(!IPadPresentation.isFullScreen(width: 800, height: 1100, screenWidth: 834, screenHeight: 1210))
        #expect(!IPadPresentation.isFullScreen(width: 834, height: 1180, screenWidth: 834, screenHeight: 1210))
        #expect(!IPadPresentation.isFullScreen(width: 0, height: 0, screenWidth: 0, screenHeight: 0))
        #expect(!IPadPresentation.isFullScreen(width: .nan, height: 1210, screenWidth: 834, screenHeight: 1210))
    }

    @Test func immersionOnlyAppliesToAnActiveFullscreenWorkspaceWithoutNativeSheets() {
        #expect(IPadPresentation.hidesSystemUI(enabled: true, fullScreen: true, active: true, workspace: true, presentingNativeUI: false))
        #expect(!IPadPresentation.hidesSystemUI(enabled: false, fullScreen: true, active: true, workspace: true, presentingNativeUI: false))
        #expect(!IPadPresentation.hidesSystemUI(enabled: true, fullScreen: false, active: true, workspace: true, presentingNativeUI: false))
        #expect(!IPadPresentation.hidesSystemUI(enabled: true, fullScreen: true, active: false, workspace: true, presentingNativeUI: false))
        #expect(!IPadPresentation.hidesSystemUI(enabled: true, fullScreen: true, active: true, workspace: false, presentingNativeUI: false))
        #expect(!IPadPresentation.hidesSystemUI(enabled: true, fullScreen: true, active: true, workspace: true, presentingNativeUI: true))
    }

    @Test func migratesLegacyServerWithoutDroppingItsSignInStore() throws {
        let library = ServerProfiles.load(nil, legacyAddress: "http://studio:7331/")
        #expect(library.profiles.count == 1)
        #expect(library.selected?.usesLegacyDataStore == true)
        #expect(library.selected?.address.absoluteString == "http://studio:7331/")
        let reloaded = ServerProfiles.load(try JSONEncoder().encode(library), legacyAddress: "http://other:7331/")
        #expect(reloaded == library)
    }

    @Test func profilesIsolateSignInsAndOriginEditsGetANewStore() throws {
        var library = ServerProfiles()
        let firstURL = URL(string: "http://studio:7331/")!
        library.save(name: "Work", address: firstURL)
        let first = try #require(library.selected)
        library.save(name: "Other port", address: URL(string: "http://studio:8080/")!)
        let second = try #require(library.selected)
        #expect(first.id != second.id)
        #expect(!first.usesLegacyDataStore && !second.usesLegacyDataStore)
        library.save(name: "Renamed", address: firstURL, editing: first.id)
        #expect(library.selected?.id == first.id)
        library.save(name: "New server", address: URL(string: "https://studio/")!, editing: first.id)
        #expect(library.selected?.id != first.id)
        #expect(library.profiles.count == 2)
        library.remove(library.selectedID!)
        #expect(library.selected?.id == second.id)
        library.remove(second.id)
        #expect(library.selected == nil)
    }

    @Test func invalidProfilesAndCredentialsNeverBecomeConnections() throws {
        for address in ["http://user:secret@studio:7331/", "http://user@studio/", "http://studio:0/", "http://studio:65536/"] {
            #expect(throws: ServerAddress.Problem.self) { try ServerAddress.parse(address).get() }
        }
        let invalid = ServerProfile(name: "bad", address: URL(string: "file:///private/file")!)
        let duplicate = ServerProfile(name: "ok", address: URL(string: "http://studio:7331/")!)
        let library = ServerProfiles(profiles: [invalid, duplicate, duplicate], selectedID: invalid.id)
        let loaded = ServerProfiles.load(try JSONEncoder().encode(library), legacyAddress: "")
        #expect(loaded.profiles == [duplicate])
        #expect(loaded.selectedID == duplicate.id)
        #expect(ServerProfiles.load(Data("bad JSON".utf8), legacyAddress: "studio").selected?.usesLegacyDataStore == true)
    }

    @Test func healthyResumeDoesNotReloadButDeadBackgroundProcessReloadsOnce() {
        var state = AppRecovery()
        var reload = state.setActive(false)
        #expect(!reload)
        reload = state.processTerminated()
        #expect(!reload)
        #expect(state.reloadPending)
        reload = state.setActive(true)
        #expect(reload)
        #expect(!state.reloadPending)
        reload = state.setActive(true)
        #expect(!reload)
        reload = state.setActive(false)
        #expect(!reload)
        reload = state.setActive(true)
        #expect(!reload)
        reload = state.processTerminated()
        #expect(reload)
    }

    @Test func appShortcutsAreUniqueAndLeaveSystemAndPasteCommandsAlone() {
        let signatures = AppShortcut.all.map { "\($0.shifted):\($0.input)" }
        #expect(Set(signatures).count == signatures.count)
        #expect(AppShortcut.all.contains { $0.command == "servers" && $0.shifted })
        #expect(AppShortcut.all.contains { $0.command == "settings" && !$0.shifted })
        #expect(!AppShortcut.all.contains { ["v", "c", "h", " "].contains($0.input) })
    }

    @Test func connectionAdviceExplainsCertificateDNSAndLocalNetworkFailures() {
        #expect(ConnectionAdvice(errorCode: -1202, description: "TLS").guidance.contains("never bypasses"))
        #expect(ConnectionAdvice(errorCode: -1003, description: "DNS").guidance.contains("MagicDNS"))
        #expect(ConnectionAdvice(errorCode: -1009, description: "Offline").guidance.contains("Local Network"))
        #expect(ConnectionAdvice(errorCode: -1004, description: "Refused").guidance.contains("7331") == false)
    }

    @Test func concurrentDownloadNamesAreReservedBeforeFilesExist() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let first = DownloadDestination.url(in: directory, suggestedFilename: "test.txt")
        let next = DownloadDestination.url(in: directory, suggestedFilename: "test.txt", reservedPaths: [first.path])
        #expect(next.lastPathComponent == "test 2.txt")
        #expect(next.deletingLastPathComponent().path == directory.path)
    }
}
