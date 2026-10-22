package hostclipboard

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	cfDIB        = 8
	gmemMoveable = 0x0002
)

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	kernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procOpenClipboard            = user32.NewProc("OpenClipboard")
	procCloseClipboard           = user32.NewProc("CloseClipboard")
	procEmptyClipboard           = user32.NewProc("EmptyClipboard")
	procSetClipboardData         = user32.NewProc("SetClipboardData")
	procRegisterClipboardFormatW = user32.NewProc("RegisterClipboardFormatW")
	procGlobalAlloc              = kernel32.NewProc("GlobalAlloc")
	procGlobalLock               = kernel32.NewProc("GlobalLock")
	procGlobalUnlock             = kernel32.NewProc("GlobalUnlock")
	procGlobalFree               = kernel32.NewProc("GlobalFree")
	procRtlMoveMemory            = kernel32.NewProc("RtlMoveMemory")
)

func detect() Status {
	status := Status{Backend: "Windows clipboard", Session: SessionDesktop}
	// Services run in session 0, which has no interactive desktop and so no
	// clipboard shared with the signed-in user's programs.
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil || session == 0 {
		status.Session = SessionService
		status.Reason = "Tessera is running as a Windows service, outside your desktop session. Start it from the tray app while you are signed in."
		return status
	}
	status.Available = true
	return status
}

func writeImage(ctx context.Context, img Image) error {
	decoded, _, err := image.Decode(bytes.NewReader(img.Data))
	if err != nil {
		return fmt.Errorf("decode image: %w", err)
	}
	pngData := img.Data
	if img.MIME != "image/png" {
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, decoded); err != nil {
			return fmt.Errorf("encode PNG: %w", err)
		}
		pngData = encoded.Bytes()
	}
	dib := deviceIndependentBitmap(decoded)

	name, _ := windows.UTF16PtrFromString("PNG")
	pngFormat, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(name)))

	// The clipboard belongs to the thread that opened it.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := openClipboard(ctx); err != nil {
		return err
	}
	defer procCloseClipboard.Call()
	if ok, _, err := procEmptyClipboard.Call(); ok == 0 {
		return fmt.Errorf("empty clipboard: %w", err)
	}
	// Readers differ: browsers and Electron apps take PNG, most native apps
	// and PowerShell's Get-Clipboard take the bitmap.
	if pngFormat != 0 {
		if err := setClipboardData(pngFormat, pngData); err != nil {
			return err
		}
	}
	return setClipboardData(cfDIB, dib)
}

// openClipboard retries briefly, since another program may hold the
// clipboard for a moment.
func openClipboard(ctx context.Context) error {
	for attempt := 0; ; attempt++ {
		ok, _, err := procOpenClipboard.Call(0)
		if ok != 0 {
			return nil
		}
		if attempt == 20 {
			return fmt.Errorf("open clipboard: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func setClipboardData(format uintptr, data []byte) error {
	handle, _, err := procGlobalAlloc.Call(gmemMoveable, uintptr(len(data)))
	if handle == 0 {
		return fmt.Errorf("allocate clipboard memory: %w", err)
	}
	pointer, _, err := procGlobalLock.Call(handle)
	if pointer == 0 {
		procGlobalFree.Call(handle)
		return fmt.Errorf("lock clipboard memory: %w", err)
	}
	if len(data) > 0 {
		procRtlMoveMemory.Call(pointer, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)))
	}
	procGlobalUnlock.Call(handle)
	// On success the clipboard owns the memory.
	if set, _, err := procSetClipboardData.Call(format, handle); set == 0 {
		procGlobalFree.Call(handle)
		return fmt.Errorf("set clipboard data: %w", err)
	}
	return nil
}

// deviceIndependentBitmap encodes img as CF_DIB: a BITMAPINFOHEADER followed
// by 32-bit BGRA rows, bottom row first.
func deviceIndependentBitmap(img image.Image) []byte {
	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	pixels := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(pixels, pixels.Bounds(), img, bounds.Min, draw.Src)

	const headerSize = 40
	out := make([]byte, headerSize+width*height*4)
	binary.LittleEndian.PutUint32(out[0:], headerSize)
	binary.LittleEndian.PutUint32(out[4:], uint32(int32(width)))
	binary.LittleEndian.PutUint32(out[8:], uint32(int32(height)))
	binary.LittleEndian.PutUint16(out[12:], 1)  // planes
	binary.LittleEndian.PutUint16(out[14:], 32) // bits per pixel; BI_RGB is 0
	binary.LittleEndian.PutUint32(out[20:], uint32(width*height*4))
	row := out[headerSize:]
	for y := 0; y < height; y++ {
		src := pixels.Pix[y*pixels.Stride : y*pixels.Stride+width*4]
		dst := row[(height-1-y)*width*4:]
		for x := 0; x < width; x++ {
			r, g, b, a := src[x*4], src[x*4+1], src[x*4+2], src[x*4+3]
			dst[x*4], dst[x*4+1], dst[x*4+2], dst[x*4+3] = b, g, r, a
		}
	}
	return out
}
