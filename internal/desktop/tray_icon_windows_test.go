//go:build windows

package desktop

import (
	"encoding/binary"
	"testing"
)

func TestTrayIconContainsWindowsResolutions(t *testing.T) {
	icon := trayIcon()
	if len(icon) < 6 || binary.LittleEndian.Uint16(icon[2:4]) != 1 {
		t.Fatal("tray icon is not a valid ICO file")
	}
	count := int(binary.LittleEndian.Uint16(icon[4:6]))
	if len(icon) < 6+count*16 {
		t.Fatalf("tray icon directory is truncated: %d entries, %d bytes", count, len(icon))
	}

	sizes := map[int]bool{}
	for index := 0; index < count; index++ {
		width := int(icon[6+index*16])
		if width == 0 {
			width = 256
		}
		sizes[width] = true
	}
	for _, size := range []int{16, 24, 32, 48, 64, 128, 256} {
		if !sizes[size] {
			t.Errorf("tray icon is missing %dx%d resolution", size, size)
		}
	}
}
