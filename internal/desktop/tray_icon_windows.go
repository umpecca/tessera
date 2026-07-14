//go:build windows

package desktop

import (
	"io/fs"

	"tessera/web"
)

func trayIcon() []byte {
	icon, err := fs.ReadFile(web.Files, "assets/icon-192.ico")
	if err != nil {
		return nil
	}
	return icon
}
