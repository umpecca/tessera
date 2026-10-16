// Package sysauth checks the password of the operating-system account that
// Tessera runs as, without cgo: Linux runs PAM's unix_chkpwd helper, macOS
// calls OpenDirectory through purego, and Windows calls LogonUserW.
package sysauth

import (
	"context"
	"errors"
	"os/user"
	"sync"
)

var (
	// ErrIncorrect means the account rejected the password.
	ErrIncorrect = errors.New("incorrect password")
	// ErrUnavailable means the password could not be checked at all, for
	// example a missing helper or an account without a usable password.
	ErrUnavailable = errors.New("system password verification is unavailable")
)

// Account names the account Tessera runs as, the only one it verifies.
func Account() (string, error) {
	current, err := user.Current()
	if err != nil {
		return "", err
	}
	return current.Username, nil
}

var verifyMu sync.Mutex

// Verify checks password for account, which must be the account Tessera runs
// as. It returns nil, ErrIncorrect, or an error wrapping ErrUnavailable. The
// password is never logged, kept, or placed in process arguments.
func Verify(ctx context.Context, account string, password []byte) error {
	if len(password) == 0 {
		return ErrIncorrect
	}
	verifyMu.Lock()
	defer verifyMu.Unlock()
	result := make(chan error, 1)
	// Platform calls block without a context; a stuck one is abandoned
	// rather than holding the sign-in page open.
	go func() { result <- verify(ctx, account, password) }()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return errors.Join(ErrUnavailable, ctx.Err())
	}
}
