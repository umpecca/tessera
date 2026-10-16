package sysauth

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

// TestLiveSystemPassword checks this machine's account. It is opt-in because
// it makes a real (failed) password check against the account:
//
//	TESSERA_SYSAUTH_LIVE=1 go test ./internal/sysauth -run Live -v
//
// Set TESSERA_SYSAUTH_PASSWORD as well to check the correct password too.
func TestLiveSystemPassword(t *testing.T) {
	if os.Getenv("TESSERA_SYSAUTH_LIVE") != "1" {
		t.Skip("set TESSERA_SYSAUTH_LIVE=1 to check this machine's account")
	}
	account, err := Account()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	started := time.Now()
	err = Verify(ctx, account, []byte("tessera-live-test-wrong-password"))
	t.Logf("wrong password for %s: %v (%v)", account, err, time.Since(started).Round(time.Millisecond))
	if !errors.Is(err, ErrIncorrect) {
		t.Fatalf("wrong password = %v, want ErrIncorrect", err)
	}
	if password := os.Getenv("TESSERA_SYSAUTH_PASSWORD"); password != "" {
		started = time.Now()
		err := Verify(ctx, account, []byte(password))
		t.Logf("correct password: %v (%v)", err, time.Since(started).Round(time.Millisecond))
		if err != nil {
			t.Fatalf("correct password = %v", err)
		}
	}
}
