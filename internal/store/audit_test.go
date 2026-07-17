package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestRecordAuditEventPersistsMetadataAndExpiresOldEntries(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "audit.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	old := AuditEvent{
		OccurredAt: time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339Nano),
		RequestID:  "old-request",
		ClientIP:   "192.0.2.1",
		Method:     "POST",
		Path:       "/api/run",
		Status:     200,
		Outcome:    "success",
	}
	if err := st.RecordAuditEvent(ctx, old, 24*time.Hour); err != nil {
		t.Fatalf("record old event: %v", err)
	}
	current := AuditEvent{
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		RequestID:  "current-request",
		ClientIP:   "192.0.2.2",
		Method:     "DELETE",
		Path:       "/api/file",
		Status:     403,
		Outcome:    "denied",
		DurationMS: 7,
	}
	if err := st.RecordAuditEvent(ctx, current, 24*time.Hour); err != nil {
		t.Fatalf("record current event: %v", err)
	}

	events, err := st.ListAuditEvents(ctx, 10)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("event count = %d, want 1: %+v", len(events), events)
	}
	if got := events[0]; got.RequestID != current.RequestID || got.ClientIP != current.ClientIP || got.Method != current.Method || got.Path != current.Path || got.Status != current.Status || got.Outcome != current.Outcome || got.DurationMS != current.DurationMS {
		t.Fatalf("stored event = %+v, want %+v", got, current)
	}
}

func TestRecordAuditEventDisabledDoesNotPersist(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "audit-disabled.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	if err := st.RecordAuditEvent(ctx, AuditEvent{RequestID: "ignored"}, 0); err != nil {
		t.Fatalf("record disabled event: %v", err)
	}
	events, err := st.ListAuditEvents(ctx, 10)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("event count = %d, want 0", len(events))
	}
}
