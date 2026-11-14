#if os(iOS)
import SwiftUI
import TesseraCore

/// UIKit's public menu lifecycle keeps an open menu from expiring, including
/// cancellation by tapping outside it. Only the 44-point corner owns touches.
struct IPadAppMenu: UIViewRepresentable {
    var menu: UIMenu
    var active: Bool

    func makeUIView(context: Context) -> IdleAppMenuButton { IdleAppMenuButton() }
    func updateUIView(_ button: IdleAppMenuButton, context: Context) {
        button.menu = menu
        button.setActive(active)
    }
    static func dismantleUIView(_ button: IdleAppMenuButton, coordinator: ()) { button.setActive(false) }
}

final class IdleAppMenuButton: UIButton {
    private var idle = IdleAppMenu()
    private var hideTimer: Timer?
    private let backdrop = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))

    init() {
        super.init(frame: .zero)
        setImage(UIImage(systemName: "ellipsis.circle.fill", withConfiguration: UIImage.SymbolConfiguration(textStyle: .title2)), for: .normal)
        tintColor = .label
        backdrop.isUserInteractionEnabled = false
        backdrop.translatesAutoresizingMaskIntoConstraints = false
        insertSubview(backdrop, at: 0)
        NSLayoutConstraint.activate([
            backdrop.leadingAnchor.constraint(equalTo: leadingAnchor), backdrop.trailingAnchor.constraint(equalTo: trailingAnchor),
            backdrop.topAnchor.constraint(equalTo: topAnchor), backdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        accessibilityLabel = "Tessera app menu"
        accessibilityIdentifier = "tessera-app-menu"
        addAction(UIAction { [weak self] _ in self?.reveal() }, for: .touchUpInside)
        NotificationCenter.default.addObserver(self, selector: #selector(accessibilityChanged), name: UIAccessibility.voiceOverStatusDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(accessibilityChanged), name: UIAccessibility.switchControlStatusDidChangeNotification, object: nil)
        accessibilityChanged()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { NotificationCenter.default.removeObserver(self) }

    override func layoutSubviews() {
        super.layoutSubviews()
        backdrop.layer.cornerRadius = min(bounds.width, bounds.height) / 2
        backdrop.clipsToBounds = true
    }

    func setActive(_ value: Bool) {
        guard idle.active != value else { return }
        idle.setActive(value)
        updateVisibility()
    }

    @objc private func accessibilityChanged() {
        idle.setAccessibilityActive(UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning)
        updateVisibility()
    }

    private func reveal() {
        idle.reveal()
        updateVisibility()
    }

    private func updateVisibility(animated: Bool = false) {
        hideTimer?.invalidate()
        hideTimer = nil
        // Keep UIButton itself opaque and hit-testable even when its decoration
        // is gone. The first tap reveals it; the next opens the native menu.
        showsMenuAsPrimaryAction = idle.visible
        accessibilityValue = idle.visible ? "Visible" : "Hidden"
        accessibilityHint = idle.visible ? "Server, reload, keyboard, downloads and app help" : "Reveal the app menu"
        let alpha: CGFloat = idle.visible ? 1 : 0
        UIView.animate(withDuration: animated && !UIAccessibility.isReduceMotionEnabled ? 0.25 : 0) {
            self.imageView?.alpha = alpha
            self.backdrop.alpha = alpha
        }
        if idle.canAutoHide {
            let timer = Timer(timeInterval: IdleAppMenu.delay, repeats: false) { [weak self] _ in
                // This timer is installed exclusively on the main run loop.
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.idle.expire()
                    self.updateVisibility(animated: true)
                }
            }
            hideTimer = timer
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        idle.setOpen(true)
        updateVisibility()
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        idle.setOpen(false)
        updateVisibility()
    }
}
#endif
