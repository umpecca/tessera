package main

import (
	"io"
	"strings"
	"testing"

	"tessera/internal/auth"
)

func TestRuntimeCredentials(t *testing.T) {
	for _, test := range []struct {
		name, input, want string
		flags             credentialFlags
	}{
		{"argument", "", "secret", credentialFlags{username: "alice", password: "secret", usernameSet: true, passwordSet: true}},
		{"stdin", "stdin-secret\nignored\n", "stdin-secret", credentialFlags{username: "alice", fromStdin: true, usernameSet: true, stdinSet: true}},
		{"crlf", "secret\r\n", "secret", credentialFlags{username: "alice", fromStdin: true, usernameSet: true, stdinSet: true}},
		{"eof", "secret", "secret", credentialFlags{username: "alice", fromStdin: true, usernameSet: true, stdinSet: true}},
		{"spaces", " secret \n", " secret ", credentialFlags{username: "alice", fromStdin: true, usernameSet: true, stdinSet: true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			account, err := test.flags.account("", nil, strings.NewReader(test.input))
			if err != nil || account == nil || account.Name != "alice" || !account.Admin {
				t.Fatalf("account = %v, %v", account != nil, err)
			}
			if ok, err := auth.VerifyPassword(account.Hash, []byte(test.want)); err != nil || !ok {
				t.Fatal("password not preserved")
			}
			if test.flags.password != "" {
				t.Fatal("retained plaintext flag value")
			}
		})
	}
}

func TestRuntimeCredentialsRejectIncompleteConflictingAndOversizedInput(t *testing.T) {
	for _, flags := range []credentialFlags{
		{username: "alice", usernameSet: true},
		{password: "secret", passwordSet: true},
		{fromStdin: true, stdinSet: true},
		{username: "", usernameSet: true, password: "secret", passwordSet: true},
		{username: "bad name", usernameSet: true, password: "secret", passwordSet: true},
		{username: "alice", usernameSet: true, passwordSet: true},
		{username: "alice", usernameSet: true, fromStdin: true, stdinSet: true},
		{username: "alice", usernameSet: true, fromStdin: true, password: "secret", passwordSet: true},
		{username: "alice", usernameSet: true, password: strings.Repeat("s", 1025), passwordSet: true},
		{stdinSet: true},
	} {
		if _, err := flags.account("", nil, strings.NewReader("")); err == nil {
			t.Fatal("accepted invalid flags")
		}
	}
	for _, mode := range []string{"off", "system", "invalid"} {
		flags := credentialFlags{username: "alice", usernameSet: true, password: "secret", passwordSet: true}
		if _, err := flags.account(mode, nil, nil); err == nil {
			t.Fatal("accepted conflicting mode")
		}
	}
	flags := credentialFlags{username: "alice", usernameSet: true, password: "secret", passwordSet: true}
	if _, err := flags.account("file", []string{"alice"}, nil); err == nil {
		t.Fatal("accepted roster")
	}
	flags = credentialFlags{username: "alice", usernameSet: true, fromStdin: true, stdinSet: true}
	if _, err := flags.account("", nil, io.LimitReader(strings.NewReader(strings.Repeat("s", 100000)), 100000)); err == nil {
		t.Fatal("accepted oversized stdin")
	}
	var unset credentialFlags
	if account, err := unset.account("system", nil, nil); err != nil || account != nil {
		t.Fatal("changed unflagged behavior")
	}
}
