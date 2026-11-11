import Foundation

public struct ServerProfile: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var name: String
    public var address: URL
    public var usesLegacyDataStore: Bool

    public init(id: UUID = UUID(), name: String, address: URL, usesLegacyDataStore: Bool = false) {
        self.id = id
        self.name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
        self.address = address
        self.usesLegacyDataStore = usesLegacyDataStore
    }

    public var displayName: String { name.isEmpty ? address.host ?? "Tessera server" : name }
}

public struct ServerProfiles: Codable, Equatable, Sendable {
    public var profiles: [ServerProfile]
    public var selectedID: UUID?

    public init(profiles: [ServerProfile] = [], selectedID: UUID? = nil) {
        self.profiles = profiles
        self.selectedID = selectedID
    }

    public var selected: ServerProfile? { profiles.first { $0.id == selectedID } }

    public static func load(_ data: Data?, legacyAddress: String) -> ServerProfiles {
        if let data, var library = try? JSONDecoder().decode(Self.self, from: data) {
            var seen = Set<UUID>()
            library.profiles = Array(library.profiles.filter {
                seen.insert($0.id).inserted && (try? ServerAddress.parse($0.address.absoluteString).get()) != nil
            }.prefix(32))
            var keptLegacyStore = false
            for index in library.profiles.indices {
                library.profiles[index].name = String(library.profiles[index].name.prefix(64))
                if library.profiles[index].usesLegacyDataStore {
                    library.profiles[index].usesLegacyDataStore = !keptLegacyStore
                    keptLegacyStore = true
                }
            }
            if library.selected == nil { library.selectedID = library.profiles.first?.id }
            return library
        }
        if !legacyAddress.isEmpty, let url = try? ServerAddress.parse(legacyAddress).get() {
            let profile = ServerProfile(name: url.host ?? "My server", address: url, usesLegacyDataStore: true)
            return ServerProfiles(profiles: [profile], selectedID: profile.id)
        }
        return ServerProfiles()
    }

    public mutating func save(name: String, address: URL, editing id: UUID? = nil) {
        guard (try? ServerAddress.parse(address.absoluteString).get()) != nil else { return }
        if let id, let index = profiles.firstIndex(where: { $0.id == id }) {
            // Changing the origin must not reuse an authenticated cookie store,
            // particularly cookies whose scope ignores the TCP port.
            if ServerAddress.sameOrigin(profiles[index].address, address) {
                profiles[index].name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
                profiles[index].address = address
                selectedID = id
                return
            }
            profiles.remove(at: index)
        }
        guard profiles.count < 32 else { return }
        let profile = ServerProfile(name: name, address: address)
        profiles.append(profile)
        selectedID = profile.id
    }

    public mutating func remove(_ id: UUID) {
        profiles.removeAll { $0.id == id }
        if selected == nil { selectedID = profiles.first?.id }
    }
}
