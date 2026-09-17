package store

import (
	"context"
	"database/sql"
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
