//go:build windows || darwin

package desktop

import (
	"context"
	"time"

	"github.com/getlantern/systray"
)

// TraySupported reports whether this build includes a native notification-area
// implementation.
func TraySupported() bool {
	return true
}

// RunTray runs the native notification-area menu. It blocks until QuitTray is
// called. The exit callback should begin the application's normal shutdown.
func RunTray(controller *Controller, exit func()) {
	systray.Run(func() { setupTray(controller, exit) }, func() {})
}

// QuitTray ends the native event loop. It is safe to call after an Exit click,
// an interrupt signal, or a self-update request.
func QuitTray() {
	systray.Quit()
}

func setupTray(controller *Controller, exit func()) {
	if icon := trayIcon(); len(icon) > 0 {
		systray.SetIcon(icon)
	}
	systray.SetTitle("Tessera")
	systray.SetTooltip("Tessera local workspace")

	status := systray.AddMenuItem("Tessera is running", "Current server status")
	status.Disable()
	start := systray.AddMenuItem("Start", "Start the Tessera server")
	stop := systray.AddMenuItem("Stop", "Stop the Tessera server")
	configure := systray.AddMenuItem("Configure...", "Open Tessera in your browser")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Exit", "Stop Tessera and exit")

	refresh := func() {
		if controller.Running() {
			status.SetTitle("Tessera is running")
			start.Disable()
			stop.Enable()
			configure.Enable()
			return
		}
		status.SetTitle("Tessera is stopped")
		start.Enable()
		stop.Disable()
		configure.Enable()
	}
	refresh()

	go func() {
		for range start.ClickedCh {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = controller.Start(ctx)
			cancel()
			refresh()
		}
	}()
	go func() {
		for range stop.ClickedCh {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = controller.Stop(ctx)
			cancel()
			refresh()
		}
	}()
	go func() {
		for range configure.ClickedCh {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = controller.Configure(ctx)
			cancel()
			refresh()
		}
	}()
	go func() {
		for range quit.ClickedCh {
			exit()
		}
	}()
}
