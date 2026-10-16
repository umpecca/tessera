package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"tessera/internal/auth"
)

// hostRequest calls a running server's loopback-only recovery endpoint with
// the host recovery token, which proves the caller is the service account.
func hostRequest(addr, tokenPath, path string, body any) (map[string]any, string, error) {
	token, err := auth.ReadToken(tokenPath)
	if err != nil {
		return nil, "", fmt.Errorf("read recovery token (is the server running with -auth?): %w", err)
	}
	base, err := loopbackBase(addr)
	if err != nil {
		return nil, "", err
	}
	payload, _ := json.Marshal(body)
	request, err := http.NewRequest(http.MethodPost, base+path, bytes.NewReader(payload))
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		return nil, "", fmt.Errorf("reach Tessera at %s (pass the server's -addr): %w", base, err)
	}
	defer response.Body.Close()
	var result map[string]any
	_ = json.NewDecoder(io.LimitReader(response.Body, 1<<16)).Decode(&result)
	if response.StatusCode != http.StatusOK {
		message, _ := result["error"].(string)
		return nil, "", fmt.Errorf("%s: %s", response.Status, message)
	}
	return result, base, nil
}

// loopbackBase turns a listen address into a URL on this machine; wildcard
// binds are reached through 127.0.0.1.
func loopbackBase(addr string) (string, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("invalid -addr %q: %w", addr, err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port), nil
}

func runLoginCommand(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("tessera login", flag.ContinueOnError)
	flags.SetOutput(stderr)
	addr := flags.String("addr", "127.0.0.1:7331", "the server's listen address")
	tokenPath := flags.String("auth-token", auth.DefaultTokenPath(), "host recovery token")
	account := flags.String("account", "", "account to sign in as (with -auth=file)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("login takes no arguments")
	}
	result, base, err := hostRequest(*addr, *tokenPath, "/api/auth/recovery-link", map[string]string{"account": *account})
	if err != nil {
		return err
	}
	path, _ := result["path"].(string)
	name, _ := result["account"].(string)
	fmt.Fprintf(stdout, "Sign in as %s within 2 minutes; the link works once:\n\n  %s%s\n\n", name, base, path)
	fmt.Fprintln(stdout, "On another device, replace the address with the one that device uses for Tessera.")
	return nil
}

func runLogoutCommand(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("tessera logout", flag.ContinueOnError)
	flags.SetOutput(stderr)
	addr := flags.String("addr", "127.0.0.1:7331", "the server's listen address")
	tokenPath := flags.String("auth-token", auth.DefaultTokenPath(), "host recovery token")
	all := flags.Bool("all", false, "end every sign-in on every device")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !*all || flags.NArg() != 0 {
		return errors.New("usage: tessera logout -all [-addr host:port]")
	}
	result, _, err := hostRequest(*addr, *tokenPath, "/api/auth/revoke-all", struct{}{})
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Ended %v sign-ins.\n", result["ended"])
	return nil
}
