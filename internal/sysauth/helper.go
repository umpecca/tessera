package sysauth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
)

// PAM's unix_chkpwd exits with PAM_AUTH_ERR for a wrong password.
const pamAuthErr = 7

// unixChkpwdPaths are where distributions install PAM's helper.
var unixChkpwdPaths = []string{"/usr/sbin/unix_chkpwd", "/sbin/unix_chkpwd", "/usr/bin/unix_chkpwd"}

// verifyWithHelper runs a unix_chkpwd-compatible helper: the account and
// "nonull" as arguments, the password and a NUL byte on standard input.
// The helper is setuid (or setgid shadow) and only checks the calling
// account, so it fails when the service runs with NoNewPrivileges.
func verifyWithHelper(ctx context.Context, paths []string, account string, password []byte) error {
	helper := ""
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			helper = path
			break
		}
	}
	if helper == "" {
		return fmt.Errorf("%w: unix_chkpwd was not found", ErrUnavailable)
	}
	input := make([]byte, len(password)+1)
	copy(input, password)
	defer clear(input)
	command := exec.CommandContext(ctx, helper, account, "nonull")
	command.Stdin = bytes.NewReader(input)
	err := command.Run()
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return errors.Join(ErrUnavailable, ctx.Err())
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == pamAuthErr {
		return ErrIncorrect
	}
	return fmt.Errorf("%w: unix_chkpwd: %v", ErrUnavailable, err)
}
