//go:build windows

package desktop

import (
	"io/fs"

	"tessera/web"
)

func trayIcon() []byte {
	icon, err := fs.ReadFile(web.Files, "assets/tessera-tray-icon.ico")
	if err != nil {
		return nil
	}
	return icon
}
