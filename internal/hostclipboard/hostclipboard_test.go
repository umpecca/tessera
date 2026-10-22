package hostclipboard

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func testPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestParseImageUsesTheContentsNotTheDeclaredType(t *testing.T) {
	img, err := ParseImage(testPNG(t))
	if err != nil || img.MIME != "image/png" {
		t.Fatalf("PNG: %+v, %v", img.MIME, err)
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	if img, err := ParseImage(jpg.Bytes()); err != nil || img.MIME != "image/jpeg" {
		t.Fatalf("JPEG: %+v, %v", img.MIME, err)
	}
}

func TestParseImageRejectsOtherData(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":     nil,
		"text":      []byte("hello"),
		"too large": append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, MaxImageBytes)...),
	} {
		if _, err := ParseImage(data); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDetectExplainsAnUnavailableClipboard(t *testing.T) {
	status := Detect()
	if status.Session == "" {
		t.Fatal("no session reported")
	}
	if !status.Available && status.Reason == "" {
		t.Fatalf("unavailable without a reason: %+v", status)
	}
}
