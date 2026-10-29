package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"

	"tessera/internal/localhttps"
)

// PKIFiles keeps the Local HTTPS certificate authority's files in the
// database.
func (s *Store) PKIFiles() localhttps.Files {
	return pkiFiles{s}
}

type pkiFiles struct{ s *Store }

func (f pkiFiles) ReadFile(name string) ([]byte, error) {
	var data []byte
	err := f.s.db.QueryRowContext(context.Background(), `SELECT data FROM pki_files WHERE name = ?`, name).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &fs.PathError{Op: "read", Path: name, Err: fs.ErrNotExist}
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	return data, nil
}

func (f pkiFiles) WriteFile(name string, data []byte) error {
	_, err := f.s.db.ExecContext(context.Background(), `
INSERT INTO pki_files (name, data, updated_at) VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		name, data, nowText())
	if err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	return nil
}
