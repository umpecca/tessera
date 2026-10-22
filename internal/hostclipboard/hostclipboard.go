// Package hostclipboard puts images on the clipboard of the desktop session
// Tessera runs in, so a program in a Tessera terminal can paste an image that
// came from the browser.
//
// A terminal carries only text. Programs such as opencode paste an image by
// reading the system clipboard themselves when they receive Ctrl+V, so the
// browser sends the image here, it goes on the host clipboard, and the browser
// then sends the program its paste key. Nothing is written to disk.
package hostclipboard

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
)

// MaxImageBytes bounds one pasted image. A full-resolution iPad screenshot is
// a few megabytes.
const MaxImageBytes = 32 << 20

// Sessions describe where the Tessera process runs.
const (
	// SessionDesktop is a logged-in desktop session with a clipboard.
	SessionDesktop = "desktop"
	// SessionService is a background service, outside any desktop session.
	SessionService = "service"
	// SessionHeadless is a host with no desktop to share a clipboard with.
	SessionHeadless = "headless"
)

// ErrUnavailable reports that this host has no clipboard Tessera can write.
var ErrUnavailable = errors.New("host clipboard unavailable")

// Status says whether images can be put on the host clipboard, and if not,
// why.
type Status struct {
	Available bool   `json:"available"`
	Backend   string `json:"backend,omitempty"`
	Session   string `json:"session"`
	Reason    string `json:"reason,omitempty"`
}

// Image is a validated image ready for the clipboard.
type Image struct {
	// MIME is image/png, image/jpeg or image/gif.
	MIME string
	Data []byte
}

var formatMIME = map[string]string{"png": "image/png", "jpeg": "image/jpeg", "gif": "image/gif"}

// ParseImage checks that data is an image of a supported format and returns it
// with the MIME type its contents show, whatever the browser declared.
func ParseImage(data []byte) (Image, error) {
	if len(data) == 0 {
		return Image{}, errors.New("empty image")
	}
	if len(data) > MaxImageBytes {
		return Image{}, fmt.Errorf("image is larger than %d MiB", MaxImageBytes>>20)
	}
	_, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Image{}, errors.New("not a PNG, JPEG or GIF image")
	}
	mime, ok := formatMIME[format]
	if !ok {
		return Image{}, errors.New("not a PNG, JPEG or GIF image")
	}
	return Image{MIME: mime, Data: data}, nil
}

// Detect reports what the host clipboard supports. It is cheap enough to call
// for every status request.
func Detect() Status {
	return detect()
}

// WriteImage replaces the host clipboard's contents with img.
func WriteImage(ctx context.Context, img Image) error {
	if status := detect(); !status.Available {
		return fmt.Errorf("%w: %s", ErrUnavailable, status.Reason)
	}
	return writeImage(ctx, img)
}
