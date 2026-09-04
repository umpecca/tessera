//go:build windows

package conpty

import (
	"bytes"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"testing"
	"time"
)

func TestConPTYOutputHelper(t *testing.T) {
	if os.Getenv("TESSERA_CONPTY_TEST_HELPER") != "1" {
		return
	}
	var mode uint32
	_ = windows.GetConsoleMode(windows.Stdout, &mode)
	_ = windows.SetConsoleMode(windows.Stdout, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING)
	fmt.Print("before\x1bPq#1;2;100;0;0!8~\x1b\\after")
	os.Exit(0)
}

func TestBundledConPTYPreservesSixelDCS(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pty, err := Start(fmt.Sprintf("%q -test.run=^TestConPTYOutputHelper$", executable), ConPtyEnv(append(os.Environ(), "TESSERA_CONPTY_TEST_HELPER=1")))
	if err != nil {
		t.Fatal(err)
	}
	defer pty.Close()
	result := make(chan []byte, 1)
	go func() {
		var output []byte
		chunk := make([]byte, 4096)
		for {
			n, err := pty.Read(chunk)
			output = append(output, chunk[:n]...)
			if err != nil || bytes.Contains(output, []byte("after")) {
				result <- output
				return
			}
		}
	}()
	select {
	case output := <-result:
		if !bytes.Contains(output, []byte("\x1bPq#1;2;100;0;0!8~\x1b\\")) {
			t.Fatalf("ConPTY consumed DCS: %q", output)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ConPTY output timed out")
	}
}
