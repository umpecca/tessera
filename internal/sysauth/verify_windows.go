package sysauth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	logon32LogonNetwork    = 3
	logon32ProviderDefault = 0
)

var procLogonUserW = windows.NewLazySystemDLL("advapi32.dll").NewProc("LogonUserW")

// verify asks Windows to log the account on for network access, then closes
// the token at once.
func verify(_ context.Context, account string, password []byte) error {
	domain, name, found := strings.Cut(account, `\`)
	if !found {
		domain, name = ".", account
	}
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return ErrIncorrect
	}
	domainPtr, err := windows.UTF16PtrFromString(domain)
	if err != nil {
		return ErrIncorrect
	}
	secret, err := windows.UTF16FromString(string(password))
	if err != nil {
		return ErrIncorrect
	}
	defer clear(secret)
	var token windows.Token
	ok, _, callErr := procLogonUserW.Call(uintptr(unsafe.Pointer(namePtr)), uintptr(unsafe.Pointer(domainPtr)),
		uintptr(unsafe.Pointer(&secret[0])), logon32LogonNetwork, logon32ProviderDefault, uintptr(unsafe.Pointer(&token)))
	if ok != 0 {
		token.Close()
		return nil
	}
	var code syscall.Errno
	if errors.As(callErr, &code) {
		switch code {
		case windows.ERROR_LOGON_FAILURE, windows.ERROR_PASSWORD_EXPIRED, windows.ERROR_ACCOUNT_DISABLED,
			windows.ERROR_ACCOUNT_LOCKED_OUT, windows.ERROR_ACCOUNT_EXPIRED:
			return ErrIncorrect
		}
	}
	// ERROR_ACCOUNT_RESTRICTION covers accounts with blank passwords, which
	// Windows refuses for network logons; the token file is the way in.
	return fmt.Errorf("%w: LogonUserW: %v", ErrUnavailable, callErr)
}
