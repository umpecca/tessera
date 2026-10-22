package hostclipboard

import (
	"encoding/binary"
	"image"
	"image/color"
	"testing"
)

func TestDeviceIndependentBitmapIsBottomUpBGRA(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.NRGBA{R: 1, G: 2, B: 3, A: 4}) // top left
	img.Set(1, 1, color.NRGBA{R: 5, G: 6, B: 7, A: 8}) // bottom right
	dib := deviceIndependentBitmap(img)
	if len(dib) != 40+2*2*4 {
		t.Fatalf("length %d", len(dib))
	}
	if binary.LittleEndian.Uint32(dib[0:]) != 40 || binary.LittleEndian.Uint32(dib[4:]) != 2 ||
		binary.LittleEndian.Uint32(dib[8:]) != 2 || binary.LittleEndian.Uint16(dib[14:]) != 32 {
		t.Fatalf("header %v", dib[:40])
	}
	pixels := dib[40:]
	// The bottom row comes first, so the bottom-right pixel is the second one.
	if got := pixels[4:8]; got[0] != 7 || got[1] != 6 || got[2] != 5 || got[3] != 8 {
		t.Fatalf("bottom right %v", got)
	}
	if got := pixels[8:12]; got[0] != 3 || got[1] != 2 || got[2] != 1 || got[3] != 4 {
		t.Fatalf("top left %v", got)
	}
}
