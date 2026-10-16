// Package auth holds Tessera's own accounts: the credentials file, password
// hashing, and sign-in throttling. Sign-ins themselves live in the store.
package auth

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters follow the OWASP password storage recommendation.
const (
	argonMemoryKiB = 19 * 1024
	argonTime      = 2
	argonThreads   = 1
	argonSaltBytes = 16
	argonKeyBytes  = 32
	maxNameBytes   = 64
	maxPassword    = 1024
)

type Account struct {
	Name string
	Hash string
}

var (
	ErrInvalidName     = errors.New("account names must be 1-64 bytes without spaces, control characters, '/', '\\' or ':'")
	ErrInvalidPassword = errors.New("passwords must be 1-1024 bytes")
	ErrAccountExists   = errors.New("account already exists")
	ErrNoAccount       = errors.New("no such account")
)

func ValidateName(name string) error {
	if name == "" || len(name) > maxNameBytes || strings.ContainsAny(name, "/\\:") {
		return ErrInvalidName
	}
	for _, r := range name {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return ErrInvalidName
		}
	}
	return nil
}

func ValidatePassword(password []byte) error {
	if len(password) == 0 || len(password) > maxPassword {
		return ErrInvalidPassword
	}
	return nil
}

// HashPassword returns an argon2id hash in PHC string format.
func HashPassword(password []byte) (string, error) {
	if err := ValidatePassword(password); err != nil {
		return "", err
	}
	salt := make([]byte, argonSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey(password, salt, argonTime, argonMemoryKiB, argonThreads, argonKeyBytes)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemoryKiB, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks password against a hash from HashPassword. Parameters
// come from the hash, so stronger future defaults keep old hashes valid.
func VerifyPassword(encoded string, password []byte) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false, errors.New("unsupported password hash")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errors.New("unsupported argon2 version")
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil ||
		memory == 0 || memory > 1024*1024 || iterations == 0 || iterations > 64 || threads == 0 {
		return false, errors.New("invalid argon2 parameters")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 8 {
		return false, errors.New("invalid password salt")
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) < 16 || len(want) > 64 {
		return false, errors.New("invalid password hash")
	}
	got := argon2.IDKey(password, salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// CredentialTag identifies the password an account had when a sign-in was
// made. Changing the password changes the tag and ends older sign-ins.
func CredentialTag(hash string) string {
	sum := sha256.Sum256([]byte(hash))
	return hex.EncodeToString(sum[:8])
}

// DefaultCredentialsPath sits beside the default database.
func DefaultCredentialsPath() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "Tessera", "credentials")
	}
	return "tessera-credentials"
}

// ParseCredentials reads `name:hash` lines, ignoring blanks and # comments.
func ParseCredentials(data []byte) ([]Account, error) {
	var accounts []Account
	seen := map[string]bool{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		name, hash, ok := strings.Cut(text, ":")
		if !ok || ValidateName(name) != nil || !strings.HasPrefix(hash, "$argon2id$") {
			return nil, fmt.Errorf("credentials line %d is not name:argon2id-hash", line)
		}
		if seen[name] {
			return nil, fmt.Errorf("credentials line %d repeats account %q", line, name)
		}
		seen[name] = true
		accounts = append(accounts, Account{Name: name, Hash: hash})
	}
	return accounts, scanner.Err()
}

func FormatCredentials(accounts []Account) []byte {
	var out bytes.Buffer
	out.WriteString("# Tessera accounts. Manage with `tessera user add|passwd|remove|list`.\n")
	for _, account := range accounts {
		fmt.Fprintf(&out, "%s:%s\n", account.Name, account.Hash)
	}
	return out.Bytes()
}

// ReadCredentialsFile loads a credentials file after checking that only the
// service account can read or change it.
func ReadCredentialsFile(path string) ([]Account, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if err := checkPrivate(path, info); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseCredentials(data)
}

// WriteCredentialsFile replaces the file atomically with mode 0600 in a
// directory created with mode 0700.
func WriteCredentialsFile(path string, accounts []Account) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".credentials-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(FormatCredentials(accounts)); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

// Credentials serves the accounts in a file to a running server, reloading
// whenever the file changes so `tessera user` edits apply without a restart.
type Credentials struct {
	path    string
	mu      sync.Mutex
	modTime time.Time
	size    int64
	loaded  bool
	list    []Account
	err     error
}

func NewCredentials(path string) *Credentials {
	return &Credentials{path: path}
}

func (c *Credentials) Path() string { return c.path }

// Accounts returns the current accounts. A file that becomes unreadable or
// invalid yields its error and no accounts, so nobody signs in against a
// stale copy.
func (c *Credentials) Accounts() ([]Account, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	info, err := os.Stat(c.path)
	if err != nil {
		c.loaded, c.list, c.err = false, nil, err
		return nil, err
	}
	if !c.loaded || !info.ModTime().Equal(c.modTime) || info.Size() != c.size {
		c.list, c.err = ReadCredentialsFile(c.path)
		c.modTime, c.size, c.loaded = info.ModTime(), info.Size(), true
	}
	return c.list, c.err
}

func (c *Credentials) Lookup(name string) (Account, bool) {
	accounts, _ := c.Accounts()
	for _, account := range accounts {
		if account.Name == name {
			return account, true
		}
	}
	return Account{}, false
}

func (c *Credentials) Names() []string {
	accounts, _ := c.Accounts()
	names := make([]string, len(accounts))
	for i, account := range accounts {
		names[i] = account.Name
	}
	return names
}
