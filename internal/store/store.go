package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	storemigrations "tessera/migrations"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type migration struct {
	version int
	name    string
	sql     string
}

func Open(ctx context.Context, path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	store := &Store{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"); err != nil {
		return fmt.Errorf("configure sqlite: %w", err)
	}

	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	currentVersion, err := s.userVersion(ctx)
	if err != nil {
		return err
	}
	latestVersion := migrations[len(migrations)-1].version
	if currentVersion > latestVersion {
		return fmt.Errorf("database migration version %d is newer than supported version %d", currentVersion, latestVersion)
	}

	hasLegacySchema, err := s.tableExists(ctx, "workspaces")
	if err != nil {
		return err
	}
	adoptingLegacySchema := currentVersion == 0 && hasLegacySchema

	for _, migration := range migrations {
		if migration.version <= currentVersion {
			continue
		}
		if err := s.applyMigration(ctx, migration); err != nil {
			if !adoptingLegacySchema || !isAdoptableDuplicateColumn(migration, err) {
				return fmt.Errorf("apply migration %s: %w", migration.name, err)
			}
			// Pre-versioned databases may already contain this one-column ALTER.
			// Every ALTER migration contains exactly one statement, so recording a
			// duplicate as adopted cannot hide a partially applied migration file.
			if err := s.recordMigrationVersion(ctx, migration.version); err != nil {
				return fmt.Errorf("adopt migration %s: %w", migration.name, err)
			}
		}
		currentVersion = migration.version
	}
	return nil
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(storemigrations.Files, ".")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}
	var migrations []migration
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sql" {
			continue
		}
		prefix, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			return nil, fmt.Errorf("migration %q must start with a numeric version and underscore", entry.Name())
		}
		version, err := strconv.Atoi(prefix)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("migration %q has invalid version", entry.Name())
		}
		sqlBytes, err := fs.ReadFile(storemigrations.Files, entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		migrations = append(migrations, migration{
			version: version,
			name:    entry.Name(),
			sql:     string(sqlBytes),
		})
	}

	sort.Slice(migrations, func(i, j int) bool {
		return migrations[i].version < migrations[j].version
	})
	if err := validateMigrationSequence(migrations); err != nil {
		return nil, err
	}
	return migrations, nil
}

func validateMigrationSequence(migrations []migration) error {
	if len(migrations) == 0 {
		return errors.New("no embedded migrations found")
	}
	for index, migration := range migrations {
		expected := index + 1
		if migration.version != expected {
			return fmt.Errorf("migration sequence has version %d at position %d; want %d", migration.version, index, expected)
		}
	}
	return nil
}

func (s *Store) applyMigration(ctx context.Context, migration migration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, migration.sql); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", migration.version)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) recordMigrationVersion(ctx context.Context, version int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) userVersion(ctx context.Context) (int, error) {
	var version int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return 0, fmt.Errorf("read database migration version: %w", err)
	}
	return version, nil
}

func (s *Store) tableExists(ctx context.Context, table string) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM sqlite_master
  WHERE type = 'table' AND name = ?
)`, table).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("inspect table %s: %w", table, err)
	}
	return exists != 0, nil
}

func isAdoptableDuplicateColumn(migration migration, err error) bool {
	if !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return false
	}
	statements := strings.Split(migration.sql, ";")
	var nonEmpty []string
	for _, statement := range statements {
		if statement = strings.TrimSpace(statement); statement != "" {
			nonEmpty = append(nonEmpty, statement)
		}
	}
	return len(nonEmpty) == 1 && strings.HasPrefix(strings.ToUpper(nonEmpty[0]), "ALTER TABLE ")
}

func nowText() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
