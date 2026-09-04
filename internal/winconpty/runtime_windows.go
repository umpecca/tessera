//go:build windows

package conpty

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/windows"
)

var runtimeOnce sync.Once
var runtimeErr error

// Use Microsoft's redistributable ConPTY, whose VT passthrough preserves DCS.
// The inbox version on older Windows builds silently consumes Sixel output.
func loadRuntime() error {
	runtimeOnce.Do(func() {
		root, err := os.UserCacheDir()
		if err != nil {
			runtimeErr = err
			return
		}
		hash := sha256.Sum256(append(append([]byte(nil), runtimeDLL...), runtimeEXE...))
		dir := filepath.Join(root, "Tessera", "conpty", fmt.Sprintf("%x", hash))
		if err = os.MkdirAll(dir, 0700); err != nil {
			runtimeErr = err
			return
		}
		for name, data := range map[string][]byte{"conpty.dll": runtimeDLL, "OpenConsole.exe": runtimeEXE} {
			file := filepath.Join(dir, name)
			if existing, err := os.ReadFile(file); err == nil && bytes.Equal(existing, data) {
				continue
			}
			// Unique temporary files plus rename permit concurrent server starts.
			tmp, err := os.CreateTemp(dir, ".install-")
			if err != nil {
				runtimeErr = err
				return
			}
			_, err = tmp.Write(data)
			closeErr := tmp.Close()
			if err == nil {
				err = closeErr
			}
			if err == nil {
				err = os.Rename(tmp.Name(), file)
			}
			_ = os.Remove(tmp.Name())
			if err != nil {
				if existing, readErr := os.ReadFile(file); readErr != nil || !bytes.Equal(existing, data) {
					runtimeErr = err
					return
				}
			}
		}
		dll := windows.NewLazyDLL(filepath.Join(dir, "conpty.dll"))
		if err = dll.Load(); err != nil {
			runtimeErr = err
			return
		}
		fCreatePseudoConsole = dll.NewProc("ConptyCreatePseudoConsole")
		fResizePseudoConsole = dll.NewProc("ConptyResizePseudoConsole")
		fClosePseudoConsole = dll.NewProc("ConptyClosePseudoConsole")
	})
	return runtimeErr
}
