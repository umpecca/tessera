package terminal

import "time"

// SizeReleaseGrace is how long a size a browser let go of stays before it
// goes back: a phone that loses its connection switching networks, or goes
// into a pocket and straight back out, reconnects and takes the size again
// without the shell being resized twice, which can leave a program that
// redraws in place (Claude Code, say) in pieces.
const SizeReleaseGrace = 45 * time.Second

// sizeClaim is a size one browser took for a while, as a phone does while
// someone types on it, with the size it took over. Letting go puts that
// size back, unless another browser has set one since: then the shell is
// that browser's, and stays as it is.
type sizeClaim struct {
	owner      any
	restore    [4]int
	generation uint64
	// release puts the size back once the grace after letting go is over.
	release *time.Timer
}

func (c *sizeClaim) stopRelease() {
	if c.release != nil {
		c.release.Stop()
		c.release = nil
	}
}

// ClaimSize resizes the shell for owner until ReleaseSize. Claiming again
// keeps the size first taken over, so a phone keyboard coming and going
// still gives back the desk's size in the end. So does a claim from a new
// owner while the last one still holds the size, as when a phone's
// reconnected socket takes over from the one it lost.
func (s *ManagedSession) ClaimSize(owner any, cols, rows, cellWidth, cellHeight int) error {
	if s == nil || owner == nil {
		return s.ResizeWithMetrics(cols, rows, cellWidth, cellHeight)
	}
	s.mu.Lock()
	if s.claim != nil && s.claim.generation == s.sizeGeneration {
		s.claim.stopRelease()
		s.claim.owner = owner
	} else {
		if s.claim != nil {
			s.claim.stopRelease()
		}
		s.claim = &sizeClaim{owner: owner, restore: [4]int{s.cols, s.rows, s.cellWidth, s.cellHeight}}
	}
	claim := s.claim
	s.mu.Unlock()
	err := s.ResizeWithMetrics(cols, rows, cellWidth, cellHeight)
	s.mu.Lock()
	if s.claim == claim {
		claim.generation = s.sizeGeneration
	}
	s.mu.Unlock()
	return err
}

// ReleaseSize ends owner's claim, putting back the size it took over if
// nobody has resized the shell since.
func (s *ManagedSession) ReleaseSize(owner any) error {
	if s == nil || owner == nil {
		return nil
	}
	s.mu.Lock()
	claim := s.claim
	if claim == nil || claim.owner != owner {
		s.mu.Unlock()
		return nil
	}
	return s.endClaim(claim)
}

// ReleaseSizeAfter ends owner's claim once delay has passed, unless it, or
// another browser taking over from it, claims the size again first.
func (s *ManagedSession) ReleaseSizeAfter(owner any, delay time.Duration) {
	if s == nil || owner == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	claim := s.claim
	if claim == nil || claim.owner != owner {
		return
	}
	claim.stopRelease()
	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		s.mu.Lock()
		if s.claim != claim || claim.release != timer {
			s.mu.Unlock()
			return
		}
		_ = s.endClaim(claim)
	})
	claim.release = timer
}

// endClaim is called with s.mu held, and unlocks it.
func (s *ManagedSession) endClaim(claim *sizeClaim) error {
	claim.stopRelease()
	s.claim = nil
	current := claim.generation == s.sizeGeneration
	s.mu.Unlock()
	if !current {
		return nil
	}
	r := claim.restore
	return s.ResizeWithMetrics(r[0], r[1], r[2], r[3])
}
