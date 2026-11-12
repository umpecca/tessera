package store

import (
	"context"
	"database/sql"
	"errors"
)

var ErrRDPCertificateConflict = errors.New("RDP certificate trust changed in another window; connect again to review it")

// RDPCertificateFingerprint returns the explicitly accepted certificate for a
// normalized host:port. No record means the user must verify it first.
func (s *Store) RDPCertificateFingerprint(ctx context.Context, userID, target string) (string, error) {
	var fingerprint string
	err := s.db.QueryRowContext(ctx, `SELECT fingerprint FROM rdp_certificate_trust WHERE user_id = ? AND target = ?`, userID, target).Scan(&fingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return fingerprint, err
}

// TrustRDPCertificate records an explicit approval (or a compatible legacy pane
// approval). previous is the fingerprint read before the dialog: another window
// cannot replace a newer, different approval using stale information.
func (s *Store) TrustRDPCertificate(ctx context.Context, userID, target, fingerprint, previous string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var current string
	err = tx.QueryRowContext(ctx, `SELECT fingerprint FROM rdp_certificate_trust WHERE user_id = ? AND target = ?`, userID, target).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if current != previous && current != fingerprint {
		return ErrRDPCertificateConflict
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO rdp_certificate_trust (user_id, target, fingerprint, updated_at) VALUES (?, ?, ?, ?)
ON CONFLICT(user_id, target) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
		userID, target, fingerprint, nowText()); err != nil {
		return err
	}
	return tx.Commit()
}
