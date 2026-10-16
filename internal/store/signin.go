package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SignIn is one authenticated device. The cookie secret itself is never
// stored; SecretHash is its SHA-256, so a copied database cannot be used to
// sign in. Times are Unix seconds.
type SignIn struct {
	ID            string
	SecretHash    string
	Account       string
	CredentialTag string
	Remember      bool
	CreatedAt     int64
	LastSeenAt    int64
	ExpiresAt     int64
	IdleSeconds   int64
	CreatedIP     string
	UserAgent     string
	LastIP        string
}

// ErrSignInInvalid covers a sign-in that is unknown, revoked or expired.
var ErrSignInInvalid = errors.New("sign-in is not valid")

func (s *Store) CreateSignIn(ctx context.Context, signIn SignIn) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO auth_sign_ins (
  id, secret_hash, account, credential_tag, remember, created_at, last_seen_at,
  expires_at, idle_seconds, created_ip, user_agent, last_ip
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		signIn.ID, signIn.SecretHash, signIn.Account, signIn.CredentialTag, signIn.Remember,
		signIn.CreatedAt, signIn.LastSeenAt, signIn.ExpiresAt, signIn.IdleSeconds,
		signIn.CreatedIP, signIn.UserAgent, signIn.LastIP)
	if err != nil {
		return fmt.Errorf("create sign-in: %w", err)
	}
	return nil
}

// SignInBySecretHash returns a sign-in that is neither revoked nor past its
// idle or absolute expiry at now.
func (s *Store) SignInBySecretHash(ctx context.Context, secretHash string, now time.Time) (SignIn, error) {
	var signIn SignIn
	err := s.db.QueryRowContext(ctx, `
SELECT id, secret_hash, account, credential_tag, remember, created_at, last_seen_at,
  expires_at, idle_seconds, created_ip, user_agent, last_ip
FROM auth_sign_ins
WHERE secret_hash = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at + idle_seconds > ?`,
		secretHash, now.Unix(), now.Unix(),
	).Scan(&signIn.ID, &signIn.SecretHash, &signIn.Account, &signIn.CredentialTag, &signIn.Remember,
		&signIn.CreatedAt, &signIn.LastSeenAt, &signIn.ExpiresAt, &signIn.IdleSeconds,
		&signIn.CreatedIP, &signIn.UserAgent, &signIn.LastIP)
	if errors.Is(err, sql.ErrNoRows) {
		return SignIn{}, ErrSignInInvalid
	}
	if err != nil {
		return SignIn{}, fmt.Errorf("load sign-in: %w", err)
	}
	return signIn, nil
}

// TouchSignIn slides a sign-in's idle window.
func (s *Store) TouchSignIn(ctx context.Context, id string, now time.Time, clientIP string) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE auth_sign_ins SET last_seen_at = ?, last_ip = ? WHERE id = ? AND revoked_at IS NULL`,
		now.Unix(), clientIP, id); err != nil {
		return fmt.Errorf("touch sign-in: %w", err)
	}
	return nil
}

func (s *Store) RevokeSignIn(ctx context.Context, id string, now time.Time) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE auth_sign_ins SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now.Unix(), id); err != nil {
		return fmt.Errorf("revoke sign-in: %w", err)
	}
	return nil
}

// RemoveEndedSignIns deletes sign-ins that expired or were revoked before
// cutoff.
func (s *Store) RemoveEndedSignIns(ctx context.Context, cutoff time.Time) error {
	if _, err := s.db.ExecContext(ctx, `
DELETE FROM auth_sign_ins
WHERE revoked_at < ? OR expires_at < ? OR last_seen_at + idle_seconds < ?`,
		cutoff.Unix(), cutoff.Unix(), cutoff.Unix()); err != nil {
		return fmt.Errorf("remove ended sign-ins: %w", err)
	}
	return nil
}

// RevokeAllSignIns ends every sign-in, for `tessera logout --all`.
func (s *Store) RevokeAllSignIns(ctx context.Context, now time.Time) (int64, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE auth_sign_ins SET revoked_at = ? WHERE revoked_at IS NULL`, now.Unix())
	if err != nil {
		return 0, fmt.Errorf("revoke sign-ins: %w", err)
	}
	return result.RowsAffected()
}

// SignInByID returns a sign-in by ID if it is still valid at now.
func (s *Store) SignInByID(ctx context.Context, id string, now time.Time) (SignIn, error) {
	var signIn SignIn
	err := s.db.QueryRowContext(ctx, `
SELECT id, secret_hash, account, credential_tag, remember, created_at, last_seen_at,
  expires_at, idle_seconds, created_ip, user_agent, last_ip
FROM auth_sign_ins
WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at + idle_seconds > ?`,
		id, now.Unix(), now.Unix(),
	).Scan(&signIn.ID, &signIn.SecretHash, &signIn.Account, &signIn.CredentialTag, &signIn.Remember,
		&signIn.CreatedAt, &signIn.LastSeenAt, &signIn.ExpiresAt, &signIn.IdleSeconds,
		&signIn.CreatedIP, &signIn.UserAgent, &signIn.LastIP)
	if errors.Is(err, sql.ErrNoRows) {
		return SignIn{}, ErrSignInInvalid
	}
	if err != nil {
		return SignIn{}, fmt.Errorf("load sign-in: %w", err)
	}
	return signIn, nil
}

// ListSignIns returns an account's valid sign-ins, most recently used first.
func (s *Store) ListSignIns(ctx context.Context, account string, now time.Time) ([]SignIn, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, secret_hash, account, credential_tag, remember, created_at, last_seen_at,
  expires_at, idle_seconds, created_ip, user_agent, last_ip
FROM auth_sign_ins
WHERE account = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at + idle_seconds > ?
ORDER BY last_seen_at DESC, created_at DESC`, account, now.Unix(), now.Unix())
	if err != nil {
		return nil, fmt.Errorf("list sign-ins: %w", err)
	}
	defer rows.Close()
	var signIns []SignIn
	for rows.Next() {
		var signIn SignIn
		if err := rows.Scan(&signIn.ID, &signIn.SecretHash, &signIn.Account, &signIn.CredentialTag, &signIn.Remember,
			&signIn.CreatedAt, &signIn.LastSeenAt, &signIn.ExpiresAt, &signIn.IdleSeconds,
			&signIn.CreatedIP, &signIn.UserAgent, &signIn.LastIP); err != nil {
			return nil, fmt.Errorf("scan sign-in: %w", err)
		}
		signIns = append(signIns, signIn)
	}
	return signIns, rows.Err()
}

// RevokeAccountSignIns ends one of an account's sign-ins, or all of them
// when id is empty, and returns the IDs it ended.
func (s *Store) RevokeAccountSignIns(ctx context.Context, account, id string, now time.Time) ([]string, error) {
	query := `SELECT id FROM auth_sign_ins WHERE account = ? AND revoked_at IS NULL`
	args := []any{account}
	if id != "" {
		query += ` AND id = ?`
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("find sign-ins: %w", err)
	}
	var ids []string
	for rows.Next() {
		var found string
		if err := rows.Scan(&found); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, found)
	}
	rows.Close()
	for _, found := range ids {
		if err := s.RevokeSignIn(ctx, found, now); err != nil {
			return nil, err
		}
	}
	return ids, nil
}
