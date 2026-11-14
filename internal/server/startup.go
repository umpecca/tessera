package server

import (
	"context"
	"fmt"
	"log"
	"strings"

	"tessera/internal/httpapi"
)

// Called with listenerMu held, after both listeners have successfully bound.
func (s *Server) reportStartup() {
	if s.startupOutput == nil {
		return
	}
	var summary strings.Builder
	fmt.Fprintf(&summary, "Tessera listening\n  HTTP:  %s\n", s.URL)
	if s.HTTPSURL == "" {
		fmt.Fprintln(&summary, "  HTTPS: disabled (enable Local HTTPS in Settings)")
	} else {
		fmt.Fprintf(&summary, "  HTTPS: %s\n", s.HTTPSURL)
	}
	ctx := context.Background()
	mode := s.auth.Mode
	if !s.auth.ModeLocked {
		if saved, err := s.store.LoadSignInMode(ctx); err == nil && saved != "" {
			mode = saved
		}
	}
	switch {
	case s.auth.RuntimeAccount != nil:
		fmt.Fprintf(&summary, "  Sign-in: CLI account %q (admin; saved accounts inactive)\n", s.auth.RuntimeAccount.Name)
	case mode == httpapi.AuthSystem:
		fmt.Fprintf(&summary, "  Sign-in: host account %q\n", s.auth.SystemAccount)
	case mode == httpapi.AuthFile:
		accounts, err := s.store.Accounts(ctx)
		if err != nil {
			fmt.Fprintln(&summary, "  Sign-in: Tessera accounts (account names unavailable)")
		} else if len(accounts) == 0 {
			fmt.Fprintln(&summary, "  Sign-in: Tessera accounts (none configured; use tessera user add <name>)")
		} else {
			names := make([]string, 0, len(accounts))
			for _, account := range accounts {
				names = append(names, fmt.Sprintf("%q", account.Name))
			}
			fmt.Fprintf(&summary, "  Sign-in: Tessera accounts: %s\n", strings.Join(names, ", "))
		}
	default:
		fmt.Fprintln(&summary, "  Sign-in: off")
	}
	if _, err := fmt.Fprint(s.startupOutput, summary.String()); err != nil {
		log.Printf("write startup summary: %v", err)
	}
}
