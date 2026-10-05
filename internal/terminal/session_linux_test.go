package terminal

import (
	"bytes"
	"errors"
	"io"
	"os"
	"syscall"
	"testing"

	"github.com/creack/pty"
)

func TestLinuxPtyHangupReturnsEOF(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { master.Close(); slave.Close() })
	if err := slave.Close(); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	if n, err := master.Read(buf); n != 0 || !errors.Is(err, syscall.EIO) {
		t.Fatalf("raw PTY hangup = (%d, %v), want (0, EIO)", n, err)
	}
	if n, err := (&unixPty{file: master}).Read(buf); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("adapted PTY hangup = (%d, %v), want (0, EOF)", n, err)
	}
}

func TestLinuxPtyHangupPreservesBufferedOutput(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { master.Close(); slave.Close() })
	want := []byte("last output before hangup")
	if _, err := slave.Write(want); err != nil {
		t.Fatal(err)
	}
	if err := slave.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(&unixPty{file: master})
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("drained output = (%q, %v), want (%q, nil)", got, err, want)
	}
}

func TestLinuxPtyReadPreservesOtherErrors(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { master.Close(); slave.Close() })
	if err := master.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&unixPty{file: master}).Read(make([]byte, 64)); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed master read = %v, want a closed-file error", err)
	}
}
