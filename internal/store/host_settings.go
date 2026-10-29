package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"tessera/internal/localhttps"
)

const localHTTPSSettingsKey = "local_https"

func (s *Store) LoadLocalHTTPSConfig(ctx context.Context, defaultAddress string) (localhttps.Config, error) {
	config := localhttps.DefaultConfig(defaultAddress)
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM host_settings WHERE key = ?`, localHTTPSSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return config, nil
	}
	if err != nil {
		return localhttps.Config{}, fmt.Errorf("load local HTTPS settings: %w", err)
	}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return localhttps.Config{}, fmt.Errorf("decode local HTTPS settings: %w", err)
	}
	return localhttps.MigrateSeparateListeners(config, defaultAddress), nil
}

func (s *Store) SaveLocalHTTPSConfig(ctx context.Context, config localhttps.Config) error {
	raw, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("encode local HTTPS settings: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO host_settings (key, value, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		localHTTPSSettingsKey, string(raw), nowText())
	if err != nil {
		return fmt.Errorf("save local HTTPS settings: %w", err)
	}
	return nil
}

const signInSettingsKey = "sign_in"

// LoadSignInMode returns the sign-in mode chosen in Settings, or "" when none
// was chosen there.
func (s *Store) LoadSignInMode(ctx context.Context) (string, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM host_settings WHERE key = ?`, signInSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("load sign-in settings: %w", err)
	}
	var settings struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		return "", fmt.Errorf("decode sign-in settings: %w", err)
	}
	return settings.Mode, nil
}

func (s *Store) SaveSignInMode(ctx context.Context, mode string) error {
	raw, err := json.Marshal(struct {
		Mode string `json:"mode"`
	}{mode})
	if err != nil {
		return fmt.Errorf("encode sign-in settings: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO host_settings (key, value, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		signInSettingsKey, string(raw), nowText())
	if err != nil {
		return fmt.Errorf("save sign-in settings: %w", err)
	}
	return nil
}

const recoveryTokenKey = "recovery_token"

// RecoveryToken returns the host recovery token, creating it on first use.
// It lets someone on the host who can read the database, as the account
// Tessera runs as, sign in without a password (`tessera login`) or end
// every sign-in.
func (s *Store) RecoveryToken(ctx context.Context) (string, error) {
	var token string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM host_settings WHERE key = ?`, recoveryTokenKey).Scan(&token)
	if err == nil {
		return token, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("load recovery token: %w", err)
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	// Another process may create it first; whichever is stored wins.
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO host_settings (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO NOTHING`, recoveryTokenKey, hex.EncodeToString(raw[:]), nowText()); err != nil {
		return "", fmt.Errorf("save recovery token: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM host_settings WHERE key = ?`, recoveryTokenKey).Scan(&token); err != nil {
		return "", fmt.Errorf("load recovery token: %w", err)
	}
	return token, nil
}
