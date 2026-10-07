//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"time"
	"unicode/utf8"
	"unsafe"
)

var readConsoleInput = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReadConsoleInputW")

func prepareOutput(output *os.File) (func(), error) {
	handle := windows.Handle(output.Fd())
	var mode uint32
	if windows.GetConsoleMode(handle, &mode) != nil {
		return func() {}, nil
	} // redirected stdout is a byte stream
	if err := windows.SetConsoleMode(handle, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING); err != nil {
		return nil, err
	}
	return func() { windows.SetConsoleMode(handle, mode) }, nil
}

// Read input records after waiting, rather than parking a ReadFile goroutine
// that could consume later shell input after the one-second query expires.
func readTerminalInput(input *os.File, wait time.Duration) ([]byte, error) {
	handle := windows.Handle(input.Fd())
	status, err := windows.WaitForSingleObject(handle, uint32(max(1, wait.Milliseconds())))
	if err != nil || status == uint32(windows.WAIT_TIMEOUT) {
		return nil, err
	}
	if status != windows.WAIT_OBJECT_0 {
		return nil, errors.New("terminal input unavailable")
	}
	type inputRecord struct {
		EventType    uint16
		Padding      uint16
		KeyDown      int32
		Repeat       uint16
		VirtualKey   uint16
		ScanCode     uint16
		Character    uint16
		ControlState uint32
	}
	var records [128]inputRecord
	var count uint32
	result, _, callErr := readConsoleInput.Call(uintptr(handle), uintptr(unsafe.Pointer(&records[0])), uintptr(len(records)), uintptr(unsafe.Pointer(&count)))
	if result == 0 {
		return nil, callErr
	}
	var data []byte
	for _, record := range records[:count] {
		if record.EventType == 1 && record.KeyDown != 0 && record.Character != 0 {
			for range record.Repeat {
				data = utf8.AppendRune(data, rune(record.Character))
			}
		}
	}
	return data, nil
}
