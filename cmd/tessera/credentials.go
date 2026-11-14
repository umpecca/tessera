package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"

	"tessera/internal/auth"
	"tessera/internal/httpapi"
)

type credentialFlags struct {
	username, password                 string
	fromStdin                          bool
	usernameSet, passwordSet, stdinSet bool
}

func (f *credentialFlags) account(mode string, users []string, stdin io.Reader) (*auth.Account, error) {
	if !f.usernameSet && !f.passwordSet && !f.stdinSet {
		return nil, nil
	}
	if !f.usernameSet || (!f.passwordSet && !f.fromStdin) {
		return nil, errors.New("CLI sign-in requires -username and either -password or -password-stdin")
	}
	if f.passwordSet && f.fromStdin {
		return nil, errors.New("use only one of -password and -password-stdin")
	}
	if mode != "" && mode != httpapi.AuthFile {
		return nil, errors.New("CLI credentials cannot be combined with -auth=off or -auth=system")
	}
	if len(users) != 0 {
		return nil, errors.New("CLI credentials cannot be combined with -users")
	}
	if err := auth.ValidateName(f.username); err != nil {
		return nil, fmt.Errorf("-username: %w", err)
	}
	password := []byte(f.password)
	f.password = ""
	if f.fromStdin {
		// Bound input before allocation; one line, optionally ending in CRLF.
		line, err := bufio.NewReader(io.LimitReader(stdin, 1027)).ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			clear(line)
			return nil, errors.New("could not read -password-stdin")
		}
		password = bytes.TrimSuffix(bytes.TrimSuffix(line, []byte("\n")), []byte("\r"))
		defer clear(line)
	}
	defer clear(password)
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, fmt.Errorf("CLI password: %w", err)
	}
	return &auth.Account{Name: f.username, Hash: hash, Admin: true}, nil
}
