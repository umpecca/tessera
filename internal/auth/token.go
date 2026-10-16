package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultTokenPath sits beside the default credentials file.
func DefaultTokenPath() string {
	return filepath.Join(filepath.Dir(DefaultCredentialsPath()), "auth-token")
}

// EnsureToken returns the host recovery token, creating it on first use. The
// token lets someone already on the host, as the service account, sign in
// without a password (`tessera login`) or end every sign-in.
func EnsureToken(path string) (string, error) {
	token, err := ReadToken(path)
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		return token, err
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token = hex.EncodeToString(raw[:])
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return ReadToken(path)
	}
	if err != nil {
		return "", err
	}
	if _, err := file.WriteString(token + "\n"); err != nil {
		file.Close()
		return "", err
	}
	return token, file.Close()
}

// ReadToken reads the recovery token after checking that only the service
// account can read or change it.
func ReadToken(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if err := checkPrivate(path, info); err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if len(token) < 32 {
		return "", fmt.Errorf("%s does not hold a recovery token", path)
	}
	return token, nil
}
