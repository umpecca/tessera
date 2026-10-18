import Foundation

/// Where a download from the server is saved: in `directory`, under the name
/// the server suggested, numbered like Safari does rather than replacing a
/// file already there.
public enum DownloadDestination {
    public static func url(in directory: URL, suggestedFilename: String, fileManager: FileManager = .default) -> URL {
        // A name never leaves the directory, whatever the server sent.
        var name = (suggestedFilename as NSString).lastPathComponent
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == "." || name == ".." { name = "Download" }
        let candidate = directory.appendingPathComponent(name)
        guard fileManager.fileExists(atPath: candidate.path) else { return candidate }
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        for number in 2... {
            let numbered = ext.isEmpty ? "\(base) \(number)" : "\(base) \(number).\(ext)"
            let url = directory.appendingPathComponent(numbered)
            if !fileManager.fileExists(atPath: url.path) { return url }
        }
        return candidate
    }
}
