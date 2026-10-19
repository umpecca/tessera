package terminal

import "time"

// Progress is the program's OSC 9;4 progress report, sent like alerts to
// every browser showing the pane, paused or not. A browser that misses
// updates needs only the latest.
type Progress struct {
	Type  string `json:"type"`
	Epoch string `json:"epoch"`
	// State is "remove", "set", "error", "indeterminate" or "pause".
	State string `json:"state"`
	// Percent is 0-100, or -1 when the program gave none.
	Percent int `json:"percent"`
	at      time.Time
}

// A program that stops reporting without removing its progress leaves it
// for this long, as in Ghostty.
const progressLifetime = 15 * time.Second

var progressStates = [...]string{"remove", "set", "error", "indeterminate", "pause"}

// readProgressLocked says whether the program reported progress since the
// last call, and the latest report.
func (s *ManagedSession) readProgressLocked() (Progress, bool, error) {
	revision, state, percent, err := s.core.Progress()
	if err != nil || revision == s.progressRevision {
		return Progress{}, false, err
	}
	s.progressRevision = revision
	if state < 0 || state >= len(progressStates) {
		state = 0
	}
	return Progress{State: progressStates[state], Percent: percent}, true, nil
}

func (s *ManagedSession) publishProgressLocked(progress Progress, now time.Time) {
	progress.Type = "terminal-progress"
	progress.Epoch = s.epoch
	progress.at = now
	s.progress = progress
	for sub := range s.subscribers {
		if sub.done {
			continue
		}
		latest := progress
		sub.progressPending = &latest
		select {
		case sub.alertWake <- struct{}{}:
		default:
		}
	}
}

func (s *ManagedSession) readProgress(sub *subscriber) (Progress, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sub.progressPending == nil {
		return Progress{}, false
	}
	progress := *sub.progressPending
	sub.progressPending = nil
	return progress, true
}

// CurrentProgress is the progress a browser that connects now should show,
// if any.
func (s *ManagedSession) CurrentProgress() *Progress {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.progress.State == "" || s.progress.State == "remove" || time.Since(s.progress.at) >= progressLifetime {
		return nil
	}
	progress := s.progress
	return &progress
}
