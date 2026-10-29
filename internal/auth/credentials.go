// Package auth holds what Tessera's own accounts need: password hashing,
// the credentials file of older versions, and sign-in throttling.
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
	// Admin accounts can manage accounts and sign-in from Settings.
	Admin bool
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

// DefaultCredentialsPath is where accounts were kept before they moved into
// the database; a file there is imported once.
func DefaultCredentialsPath() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "Tessera", "credentials")
	}
	return "tessera-credentials"
}

// ParseCredentials reads `name:hash` lines, or `name:hash:admin` for admin
// accounts, ignoring blanks and # comments. Hashes never contain ':'.
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
		hash, role, hasRole := strings.Cut(hash, ":")
		if !ok || ValidateName(name) != nil || !strings.HasPrefix(hash, "$argon2id$") || (hasRole && role != "admin") {
			return nil, fmt.Errorf("credentials line %d is not name:argon2id-hash[:admin]", line)
		}
		if seen[name] {
			return nil, fmt.Errorf("credentials line %d repeats account %q", line, name)
		}
		seen[name] = true
		accounts = append(accounts, Account{Name: name, Hash: hash, Admin: hasRole})
	}
	return accounts, scanner.Err()
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
