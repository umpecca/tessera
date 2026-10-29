package auth

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword([]byte("correct horse"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("hash = %q", hash)
	}
	if ok, err := VerifyPassword(hash, []byte("correct horse")); !ok || err != nil {
		t.Fatalf("correct password: %v %v", ok, err)
	}
	if ok, err := VerifyPassword(hash, []byte("wrong")); ok || err != nil {
		t.Fatalf("wrong password: %v %v", ok, err)
	}
	other, _ := HashPassword([]byte("correct horse"))
	if other == hash || CredentialTag(other) == CredentialTag(hash) {
		t.Fatal("hashes must be salted")
	}
	for _, bad := range []string{"", "$argon2i$v=19$m=1,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", "$argon2id$v=19$m=0,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"} {
		if _, err := VerifyPassword(bad, []byte("x")); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, err := HashPassword(nil); err == nil {
		t.Fatal("empty password accepted")
	}
}

func TestValidateName(t *testing.T) {
	for _, good := range []string{"alice", "Bob.Smith", "ünï"} {
		if ValidateName(good) != nil {
			t.Fatalf("rejected %q", good)
		}
	}
	for _, bad := range []string{"", "a b", "a:b", "a/b", `a\b`, "a\tb", strings.Repeat("x", 65)} {
		if ValidateName(bad) == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestParseCredentials(t *testing.T) {
	accounts, err := ParseCredentials([]byte("# comment\n\nalice:$argon2id$x:admin\n bob:$argon2id$y \n"))
	if err != nil || len(accounts) != 2 || accounts[1].Name != "bob" || accounts[1].Hash != "$argon2id$y" ||
		!accounts[0].Admin || accounts[0].Hash != "$argon2id$x" || accounts[1].Admin {
		t.Fatalf("accounts = %#v, %v", accounts, err)
	}
	if got := string(FormatCredentials(accounts)); !strings.HasSuffix(got, "alice:$argon2id$x:admin\nbob:$argon2id$y\n") {
		t.Fatalf("formatted = %q", got)
	}
	for _, bad := range []string{"alice", "alice:plain", "a b:$argon2id$x", "a:$argon2id$x\na:$argon2id$y", "a:$argon2id$x:root"} {
		if _, err := ParseCredentials([]byte(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestCredentialsFileRoundTripAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conf", "credentials")
	if err := WriteCredentialsFile(path, []Account{{Name: "alice", Hash: "$argon2id$a"}}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		dir, _ := os.Stat(filepath.Dir(path))
		if info.Mode().Perm() != 0o600 || dir.Mode().Perm() != 0o700 {
			t.Fatalf("modes %v %v", info.Mode().Perm(), dir.Mode().Perm())
		}
	}
	credentials := NewCredentials(path)
	if names := credentials.Names(); len(names) != 1 || names[0] != "alice" {
		t.Fatalf("names = %v", names)
	}
	if err := WriteCredentialsFile(path, []Account{{Name: "alice", Hash: "$argon2id$a"}, {Name: "bob", Hash: "$argon2id$b", Admin: true}}); err != nil {
		t.Fatal(err)
	}
	// Force a different modification time even on coarse filesystems.
	later := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(path, later, later)
	if account, ok := credentials.Lookup("bob"); !ok || account.Hash != "$argon2id$b" || !account.Admin {
		t.Fatal("reload did not pick up bob")
	}
	// Update writes through and is seen at once, whatever the file's times.
	err := credentials.Update(func(accounts []Account) ([]Account, error) {
		return append(accounts[:1], Account{Name: "carol", Hash: "$argon2id$c"}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if names := credentials.Names(); len(names) != 2 || names[1] != "carol" {
		t.Fatalf("names after update = %v", names)
	}
	if onDisk, _ := ReadCredentialsFile(path); len(onDisk) != 2 || onDisk[1].Name != "carol" {
		t.Fatalf("file after update = %v", onDisk)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, ok := credentials.Lookup("alice"); ok {
		t.Fatal("a missing file must yield no accounts")
	}
}

func TestReadCredentialsFileRejectsSharedFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permissions are ACL-based on Windows")
	}
	path := filepath.Join(t.TempDir(), "credentials")
	if err := os.WriteFile(path, []byte("alice:$argon2id$a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCredentialsFile(path); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("err = %v", err)
	}
	// Fixing the permissions changes neither time nor size; it still counts.
	credentials := NewCredentials(path)
	if _, err := credentials.Accounts(); err == nil {
		t.Fatal("shared file accepted")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := credentials.Lookup("alice"); !ok {
		t.Fatal("fixed file not read again")
	}
}

func TestThrottle(t *testing.T) {
	throttle := NewThrottle()
	now := time.Unix(1000, 0)
	for i := 0; i < freeFailures; i++ {
		if wait := throttle.Begin("a", now); wait != 0 {
			t.Fatalf("attempt %d waited %v", i, wait)
		}
		throttle.Failure("a", now)
	}
	if wait := throttle.Begin("a", now); wait != 0 {
		t.Fatalf("fourth attempt waited %v", wait)
	}
	throttle.Failure("a", now)
	if wait := throttle.Begin("a", now); wait != 2*time.Second {
		t.Fatalf("wait after 4 failures = %v", wait)
	}
	now = now.Add(2 * time.Second)
	throttle.Begin("a", now)
	throttle.Failure("a", now)
	if wait := throttle.Begin("a", now); wait != 4*time.Second {
		t.Fatalf("wait after 5 failures = %v", wait)
	}
	for i := 0; i < 30; i++ {
		throttle.Failure("a", now)
	}
	if wait := throttle.Begin("a", now); wait != maxBackoff {
		t.Fatalf("capped wait = %v", wait)
	}
	throttle.Success("a")
	// Other clients are unaffected, until the shared per-minute cap.
	fresh := NewThrottle()
	for i := 0; i < globalPerMinute; i++ {
		if wait := fresh.Begin("c"+string(rune('a'+i)), now); wait != 0 {
			t.Fatalf("client %d waited %v", i, wait)
		}
	}
	if wait := fresh.Begin("z", now.Add(10*time.Second)); wait != 50*time.Second {
		t.Fatalf("global cap wait = %v", wait)
	}
}

func TestRecoveryToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Tessera", "auth-token")
	first, err := EnsureToken(path)
	if err != nil || len(first) != 64 {
		t.Fatalf("token = %q, %v", first, err)
	}
	if again, err := EnsureToken(path); err != nil || again != first {
		t.Fatalf("second EnsureToken = %q, %v", again, err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v", info.Mode().Perm())
		}
		_ = os.Chmod(path, 0o644)
		if _, err := ReadToken(path); err == nil {
			t.Fatal("shared token file accepted")
		}
	}
}
