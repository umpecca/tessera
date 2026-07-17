package store

import (
	"context"
	"fmt"
)

// AudioStation is the durable portion of Tessera's one host-wide audio
// station. Playback always resumes paused, so only source and seek position are
// stored.
type AudioStation struct {
	SourceKind      string
	SourceValue     string
	WorkspaceID     string
	PaneID          string
	PositionSeconds float64
	SourceVersion   uint64
	StateVersion    uint64
}

func (s *Store) LoadAudioStation(ctx context.Context) (AudioStation, error) {
	var station AudioStation
	err := s.db.QueryRowContext(ctx, `
SELECT source_kind, source_value, workspace_id, pane_id,
       position_seconds, source_version, state_version
FROM audio_station
WHERE id = 1`).Scan(
		&station.SourceKind,
		&station.SourceValue,
		&station.WorkspaceID,
		&station.PaneID,
		&station.PositionSeconds,
		&station.SourceVersion,
		&station.StateVersion,
	)
	if err != nil {
		return AudioStation{}, fmt.Errorf("load audio station: %w", err)
	}
	return station, nil
}

func (s *Store) SaveAudioStation(ctx context.Context, station AudioStation) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE audio_station
SET source_kind = ?, source_value = ?, workspace_id = ?, pane_id = ?,
    position_seconds = ?, source_version = ?, state_version = ?,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1`,
		station.SourceKind,
		station.SourceValue,
		station.WorkspaceID,
		station.PaneID,
		station.PositionSeconds,
		station.SourceVersion,
		station.StateVersion,
	)
	if err != nil {
		return fmt.Errorf("save audio station: %w", err)
	}
	return nil
}
