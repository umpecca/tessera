package store

import (
	"context"
	"database/sql"
	"errors"
	"unicode/utf16"
)

// Browser pane site data: the localStorage items and persistent cookies
// Tessera keeps for pages in Browser panes, whose opaque origin keeps the
// browser from storing them (task 242). Both belong to an account ("" with
// sign-in off) and a development server's origin, such as
// "http://localhost:8080".

var ErrBrowserStorageQuota = errors.New("browser storage quota exceeded")

// BrowserStorageOp is one change to an origin's localStorage: "set" (Key to
// Value), "remove" (Key) or "clear".
type BrowserStorageOp struct {
	Op    string
	Key   string
	Value string
}

// BrowserCookie is a cookie a development server or its page set. Expires is
// in Unix seconds; Created, in Unix nanoseconds, orders cookies with the same
// path length as browsers do.
type BrowserCookie struct {
	Name     string
	Value    string
	Path     string
	Expires  int64
	Secure   bool
	HTTPOnly bool
	SameSite string
	Created  int64
}

// BrowserStorageSize is what an item counts towards a storage quota: the
// UTF-16 code units of its key and value, as browsers count them.
func BrowserStorageSize(key, value string) int {
	size := 0
	for _, text := range []string{key, value} {
		for _, r := range text {
			size += utf16.RuneLen(r)
		}
	}
	return size
}

func (s *Store) BrowserStorage(ctx context.Context, account, origin string) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM browser_storage WHERE account = ? AND origin = ?`, account, origin)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		items[key] = value
	}
	return items, rows.Err()
}

// ApplyBrowserStorage applies ops in order, all or none: none when the
// origin's items would then come to more than quota.
func (s *Store) ApplyBrowserStorage(ctx context.Context, account, origin string, ops []BrowserStorageOp, quota int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, op := range ops {
		switch op.Op {
		case "set":
			_, err = tx.ExecContext(ctx, `
INSERT INTO browser_storage (account, origin, key, value, size) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(account, origin, key) DO UPDATE SET value = excluded.value, size = excluded.size`,
				account, origin, op.Key, op.Value, BrowserStorageSize(op.Key, op.Value))
		case "remove":
			_, err = tx.ExecContext(ctx, `DELETE FROM browser_storage WHERE account = ? AND origin = ? AND key = ?`, account, origin, op.Key)
		case "clear":
			_, err = tx.ExecContext(ctx, `DELETE FROM browser_storage WHERE account = ? AND origin = ?`, account, origin)
		default:
			err = errors.New("unknown browser storage operation")
		}
		if err != nil {
			return err
		}
	}
	var size sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT SUM(size) FROM browser_storage WHERE account = ? AND origin = ?`, account, origin).Scan(&size); err != nil {
		return err
	}
	if int(size.Int64) > quota {
		return ErrBrowserStorageQuota
	}
	return tx.Commit()
}

func (s *Store) BrowserCookies(ctx context.Context, account, origin string) ([]BrowserCookie, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT name, value, path, expires, secure, http_only, same_site, created
FROM browser_cookies WHERE account = ? AND origin = ? ORDER BY created`, account, origin)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cookies []BrowserCookie
	for rows.Next() {
		var cookie BrowserCookie
		if err := rows.Scan(&cookie.Name, &cookie.Value, &cookie.Path, &cookie.Expires, &cookie.Secure, &cookie.HTTPOnly, &cookie.SameSite, &cookie.Created); err != nil {
			return nil, err
		}
		cookies = append(cookies, cookie)
	}
	return cookies, rows.Err()
}

// SaveBrowserCookies replaces an origin's stored cookies with cookies.
func (s *Store) SaveBrowserCookies(ctx context.Context, account, origin string, cookies []BrowserCookie) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM browser_cookies WHERE account = ? AND origin = ?`, account, origin); err != nil {
		return err
	}
	for _, cookie := range cookies {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO browser_cookies (account, origin, name, path, value, expires, secure, http_only, same_site, created)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			account, origin, cookie.Name, cookie.Path, cookie.Value, cookie.Expires, cookie.Secure, cookie.HTTPOnly, cookie.SameSite, cookie.Created); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ClearBrowserSiteData removes an origin's localStorage and cookies.
func (s *Store) ClearBrowserSiteData(ctx context.Context, account, origin string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"browser_storage", "browser_cookies"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE account = ? AND origin = ?`, account, origin); err != nil {
			return err
		}
	}
	return tx.Commit()
}
