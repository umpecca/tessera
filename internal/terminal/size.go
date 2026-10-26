package terminal

// sizeClaim is a size one browser took for a while, as a phone does while
// someone types on it, with the size it took over. Letting go puts that
// size back, unless another browser has set one since: then the shell is
// that browser's, and stays as it is.
type sizeClaim struct {
	owner      any
	restore    [4]int
	generation uint64
}

// ClaimSize resizes the shell for owner until ReleaseSize. Claiming again
// keeps the size first taken over, so a phone keyboard coming and going
// still gives back the desk's size in the end.
func (s *ManagedSession) ClaimSize(owner any, cols, rows, cellWidth, cellHeight int) error {
	if s == nil || owner == nil {
		return s.ResizeWithMetrics(cols, rows, cellWidth, cellHeight)
	}
	s.mu.Lock()
	if s.claim == nil || s.claim.owner != owner || s.claim.generation != s.sizeGeneration {
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
	s.claim = nil
	current := claim.generation == s.sizeGeneration
	s.mu.Unlock()
	if !current {
		return nil
	}
	r := claim.restore
	return s.ResizeWithMetrics(r[0], r[1], r[2], r[3])
}
