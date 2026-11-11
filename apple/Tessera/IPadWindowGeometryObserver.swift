#if os(iOS)
import SwiftUI
import TesseraCore

/// Observe the actual scene, not SwiftUI's keyboard/safe-area-reduced content.
/// No fullscreen requirement or private window-manager APIs: multitasking stays enabled.
struct IPadWindowGeometryObserver: UIViewRepresentable {
    let onChange: (Bool) -> Void

    func makeUIView(context: Context) -> Probe {
        let view = Probe()
        view.isUserInteractionEnabled = false
        view.onChange = onChange
        return view
    }

    func updateUIView(_ view: Probe, context: Context) {
        view.onChange = onChange
        view.reportGeometry()
    }

    final class Probe: UIView {
        var onChange: ((Bool) -> Void)?
        private var lastReported: Bool?
        private var scheduled = false

        override func didMoveToWindow() { super.didMoveToWindow(); reportGeometry() }
        override func layoutSubviews() { super.layoutSubviews(); reportGeometry() }
        override func safeAreaInsetsDidChange() { super.safeAreaInsetsDidChange(); reportGeometry() }

        func reportGeometry() {
            guard !scheduled else { return }
            scheduled = true
            // Deliver after layout, avoiding state mutation during SwiftUI updates.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scheduled = false
                guard let scene = self.window?.windowScene else { return }
                let size: CGSize
                if #available(iOS 26, *) { size = scene.effectiveGeometry.coordinateSpace.bounds.size }
                else { size = scene.coordinateSpace.bounds.size }
                let screen = scene.screen.bounds.size
                let fullScreen = IPadPresentation.isFullScreen(width: size.width, height: size.height,
                    screenWidth: screen.width, screenHeight: screen.height)
                guard self.lastReported != fullScreen else { return }
                self.lastReported = fullScreen
                self.onChange?(fullScreen)
            }
        }
    }
}
#endif
