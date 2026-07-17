package store

import (
	"context"
	"fmt"
	"time"
)

// AuditEvent is deliberately limited to request metadata. Request bodies,
// query strings, credentials, command text, and file contents do not belong in
// the audit log.
type AuditEvent struct {
	ID         int64  `json:"id"`
	OccurredAt string `json:"occurredAt"`
	RequestID  string `json:"requestId"`
	ClientIP   string `json:"clientIp"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Status     int    `json:"status"`
	Outcome    string `json:"outcome"`
	DurationMS int64  `json:"durationMs"`
}

// RecordAuditEvent appends an event and deletes entries older than the
// configured retention window in the same transaction. A non-positive
// retention disables persistence.
func (s *Store) RecordAuditEvent(ctx context.Context, event AuditEvent, retention time.Duration) error {
	if retention <= 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin audit event: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
INSERT INTO audit_events (
  occurred_at, request_id, client_ip, method, path, status, outcome, duration_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		event.OccurredAt,
		event.RequestID,
		event.ClientIP,
		event.Method,
		event.Path,
		event.Status,
		event.Outcome,
		event.DurationMS,
	); err != nil {
		return fmt.Errorf("insert audit event: %w", err)
	}
	cutoff := time.Now().UTC().Add(-retention).Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `DELETE FROM audit_events WHERE occurred_at < ?`, cutoff); err != nil {
		return fmt.Errorf("expire audit events: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit audit event: %w", err)
	}
	return nil
}

// ListAuditEvents returns newest-first records for diagnostics and tests. It is
// intentionally not exposed by the HTTP API until administrator authorization
// exists.
func (s *Store) ListAuditEvents(ctx context.Context, limit int) ([]AuditEvent, error) {
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id, occurred_at, request_id, client_ip, method, path, status, outcome, duration_ms
FROM audit_events
ORDER BY id DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list audit events: %w", err)
	}
	defer rows.Close()

	var events []AuditEvent
	for rows.Next() {
		var event AuditEvent
		if err := rows.Scan(
			&event.ID,
			&event.OccurredAt,
			&event.RequestID,
			&event.ClientIP,
			&event.Method,
			&event.Path,
			&event.Status,
			&event.Outcome,
			&event.DurationMS,
		); err != nil {
			return nil, fmt.Errorf("scan audit event: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate audit events: %w", err)
	}
	return events, nil
}
