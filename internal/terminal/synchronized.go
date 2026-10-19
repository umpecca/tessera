package terminal

import "time"

// synchronizedOutputTimeout is how long a program's redraw (mode 2026) may
// go unended before the host ends it, as Ghostty does. Each start restarts
// it.
var synchronizedOutputTimeout = time.Second

// watchSynchronizedOutputLocked restarts the timer when the output just
// parsed started a redraw. One that also ended it finds the mode off when
// the timer fires.
func (s *ManagedSession) watchSynchronizedOutputLocked() {
	if s.core == nil {
		return
	}
	starts, err := s.core.SynchronizedOutputStarts()
	if err != nil || starts == s.synchronizedOutputStarts {
		return
	}
	s.synchronizedOutputStarts = starts
	if s.synchronizedOutputTimer != nil {
		s.synchronizedOutputTimer.Stop()
	}
	s.synchronizedOutputTimer = time.AfterFunc(synchronizedOutputTimeout, func() {
		s.endSynchronizedOutput(starts)
	})
}

// endSynchronizedOutput ends a redraw still open since start number starts.
// Browsers end it at the same point in the output, so every core agrees, and
// snapshots and mode queries report it ended.
func (s *ManagedSession) endSynchronizedOutput(starts uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.core == nil || s.isClosed() || starts != s.synchronizedOutputStarts {
		return
	}
	ended, err := s.core.EndSynchronizedOutput()
	if err != nil || !ended {
		return
	}
	s.publishStateLocked(StateSynchronizedOutputEnd, nil)
}
