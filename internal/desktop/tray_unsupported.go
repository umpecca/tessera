//go:build !windows && !darwin

package desktop

// TraySupported reports whether this build includes a native notification-area
// implementation. Linux releases intentionally stay CGO-free and run as a
// server-only process.
func TraySupported() bool {
	return false
}

// RunTray is a no-op on server-only platforms.
func RunTray(_ *Controller, _ func()) {}

// QuitTray is a no-op on server-only platforms.
func QuitTray() {}
