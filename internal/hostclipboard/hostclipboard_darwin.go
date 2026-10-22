package hostclipboard

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

const (
	appKitPath   = "/System/Library/Frameworks/AppKit.framework/AppKit"
	securityPath = "/System/Library/Frameworks/Security.framework/Security"

	// SessionGetInfo's callerSecuritySession and sessionHasGraphicAccess.
	callerSecuritySession   = ^uint32(0)
	sessionHasGraphicAccess = 0x0010
	nsUTF8StringEncoding    = 4
)

// The uniform type identifiers opencode and other native readers look for.
var pasteboardTypes = map[string]string{
	"image/png":  "public.png",
	"image/jpeg": "public.jpeg",
	"image/gif":  "com.compuserve.gif",
}

var (
	loadOnce sync.Once
	loadErr  error

	sessionGetInfo func(session uint32, id *uint32, attributes *uint32) int32

	selNew, selDrain, selGeneralPasteboard, selClearContents        objc.SEL
	selDataWithBytesLength, selSetDataForType, selDataForType       objc.SEL
	selInitWithBytesLengthEncoding, selAlloc, selRelease, selLength objc.SEL
)

func load() error {
	loadOnce.Do(func() {
		if _, err := purego.Dlopen(appKitPath, purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
			loadErr = fmt.Errorf("load AppKit: %w", err)
			return
		}
		security, err := purego.Dlopen(securityPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			loadErr = fmt.Errorf("load Security: %w", err)
			return
		}
		purego.RegisterLibFunc(&sessionGetInfo, security, "SessionGetInfo")
		selNew = objc.RegisterName("new")
		selDrain = objc.RegisterName("drain")
		selAlloc = objc.RegisterName("alloc")
		selRelease = objc.RegisterName("release")
		selLength = objc.RegisterName("length")
		selGeneralPasteboard = objc.RegisterName("generalPasteboard")
		selClearContents = objc.RegisterName("clearContents")
		selDataWithBytesLength = objc.RegisterName("dataWithBytes:length:")
		selSetDataForType = objc.RegisterName("setData:forType:")
		selDataForType = objc.RegisterName("dataForType:")
		selInitWithBytesLengthEncoding = objc.RegisterName("initWithBytes:length:encoding:")
	})
	return loadErr
}

func detect() Status {
	status := Status{Backend: "macOS pasteboard", Session: SessionDesktop}
	if err := load(); err != nil {
		status.Reason = err.Error()
		return status
	}
	// A LaunchDaemon, or a process started over SSH, runs outside the Aqua
	// session: it has no window server, so it has no pasteboard to share with
	// the programs a user runs.
	var id, attributes uint32
	if os.Geteuid() == 0 || sessionGetInfo(callerSecuritySession, &id, &attributes) != 0 ||
		attributes&sessionHasGraphicAccess == 0 {
		status.Session = SessionService
		status.Reason = "Tessera is running outside your desktop session (as a background service or over SSH). Start it from the menu bar app while you are logged in."
		return status
	}
	status.Available = true
	return status
}

func writeImage(_ context.Context, img Image) error {
	uti, ok := pasteboardTypes[img.MIME]
	if !ok {
		return fmt.Errorf("unsupported image type %s", img.MIME)
	}
	if err := load(); err != nil {
		return err
	}
	// AppKit objects are autoreleased into the current thread's pool.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := objc.ID(objc.GetClass("NSAutoreleasePool")).Send(selNew)
	defer pool.Send(selDrain)

	pasteboard := objc.ID(objc.GetClass("NSPasteboard")).Send(selGeneralPasteboard)
	if pasteboard == 0 {
		return errors.New("the macOS pasteboard is not available")
	}
	kind := nsString(uti)
	defer kind.Send(selRelease)
	data := objc.ID(objc.GetClass("NSData")).Send(selDataWithBytesLength, unsafe.Pointer(&img.Data[0]), uint(len(img.Data)))
	runtime.KeepAlive(img.Data)
	if data == 0 {
		return errors.New("could not copy the image for the pasteboard")
	}
	pasteboard.Send(selClearContents)
	if !objc.Send[bool](pasteboard, selSetDataForType, data, kind) {
		return errors.New("the macOS pasteboard refused the image")
	}
	// Read it back, so a status of success means a reader will find it.
	stored := pasteboard.Send(selDataForType, kind)
	if stored == 0 || objc.Send[uint](stored, selLength) != uint(len(img.Data)) {
		return errors.New("the image did not stay on the macOS pasteboard")
	}
	return nil
}

// nsString returns a retained NSString; the caller releases it.
func nsString(value string) objc.ID {
	bytes := []byte(value)
	str := objc.ID(objc.GetClass("NSString")).Send(selAlloc).
		Send(selInitWithBytesLengthEncoding, unsafe.Pointer(&bytes[0]), uint(len(bytes)), uint(nsUTF8StringEncoding))
	runtime.KeepAlive(bytes)
	return str
}
