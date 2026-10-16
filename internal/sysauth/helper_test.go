//go:build !windows

package sysauth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeHelper writes a unix_chkpwd stand-in that accepts alice/"s3cret" only
// when it arrives on stdin with a trailing NUL, and records its arguments.
func fakeHelper(t *testing.T, body string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	path := filepath.Join(dir, "unix_chkpwd")
	script := "#!/bin/sh\necho \"$@\" > '" + args + "'\n" + body
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path, args
}

const checkingHelper = `input=$(od -An -tx1 | tr -d ' \n')
[ "$1" = alice ] && [ "$input" = "73336372657400" ] && exit 0
exit 7
`

func TestHelperVerifiesThroughStandardInput(t *testing.T) {
	helper, args := fakeHelper(t, checkingHelper)
	ctx := context.Background()
	if err := verifyWithHelper(ctx, []string{"/nonexistent/unix_chkpwd", helper}, "alice", []byte("s3cret")); err != nil {
		t.Fatalf("correct password: %v", err)
	}
	if recorded, _ := os.ReadFile(args); string(recorded) != "alice nonull\n" {
		t.Fatalf("arguments = %q; the password must never be one", recorded)
	}
	if err := verifyWithHelper(ctx, []string{helper}, "alice", []byte("wrong")); !errors.Is(err, ErrIncorrect) {
		t.Fatalf("wrong password: %v", err)
	}
}

func TestHelperUnavailable(t *testing.T) {
	ctx := context.Background()
	if err := verifyWithHelper(ctx, []string{"/nonexistent/unix_chkpwd"}, "alice", []byte("x")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing helper: %v", err)
	}
	broken, _ := fakeHelper(t, "exit 9\n")
	if err := verifyWithHelper(ctx, []string{broken}, "alice", []byte("x")); !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrIncorrect) {
		t.Fatalf("helper failure: %v", err)
	}
	slow, _ := fakeHelper(t, "sleep 5\n")
	timeout, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if err := verifyWithHelper(timeout, []string{slow}, "alice", []byte("x")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("timeout: %v", err)
	}
}
