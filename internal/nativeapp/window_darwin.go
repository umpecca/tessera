//go:build darwin && desktop && cgo

package nativeapp

/*
#cgo CFLAGS: -x objective-c -fobjc-arc -mmacosx-version-min=12.0
#cgo LDFLAGS: -framework Cocoa -framework WebKit -mmacosx-version-min=12.0
#include <stdlib.h>
void tesseraRun(const char *url, const char *token);
void tesseraError(const char *message);
void tesseraFocus(void);
void tesseraRequestClose(const char *message);
*/
import "C"
import "unsafe"

func Run(url, token string) {
	u, t := C.CString(url), C.CString(token)
	defer C.free(unsafe.Pointer(u))
	defer C.free(unsafe.Pointer(t))
	C.tesseraRun(u, t)
}

func ShowError(message string) {
	m := C.CString(message)
	defer C.free(unsafe.Pointer(m))
	C.tesseraError(m)
}

func FocusExisting() { C.tesseraFocus() }

func RequestClose(message string) {
	m := C.CString(message)
	defer C.free(unsafe.Pointer(m))
	C.tesseraRequestClose(m)
}
