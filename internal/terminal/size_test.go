package terminal

import (
	"testing"
	"time"
)

func sessionSize(s *ManagedSession) [4]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return [4]int{s.cols, s.rows, s.cellWidth, s.cellHeight}
}

func TestClaimedSizeGoesBackWhenReleased(t *testing.T) {
	s, _ := stateSession(t)
	desk := [4]int{80, 24, 8, 16}
	phone := new(byte)
	if err := s.ClaimSize(phone, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	if got := sessionSize(s); got != [4]int{45, 30, 8, 16} {
		t.Fatalf("claimed size = %v", got)
	}
	// The phone's keyboard comes up: still the desk's size to give back.
	if err := s.ClaimSize(phone, 45, 18, 8, 16); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseSize(new(byte)); err != nil || sessionSize(s) != [4]int{45, 18, 8, 16} {
		t.Fatalf("another socket released it: %v %v", sessionSize(s), err)
	}
	if err := s.ReleaseSize(phone); err != nil || sessionSize(s) != desk {
		t.Fatalf("released size = %v %v", sessionSize(s), err)
	}
	if err := s.ReleaseSize(phone); err != nil || sessionSize(s) != desk {
		t.Fatalf("second release = %v %v", sessionSize(s), err)
	}
}

func TestClaimedSizeStaysWhenAnotherBrowserResizedSince(t *testing.T) {
	s, _ := stateSession(t)
	phone := new(byte)
	if err := s.ClaimSize(phone, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	// Someone at the desk clicks the terminal, taking it back at a new size.
	if err := s.ResizeWithMetrics(120, 40, 9, 18); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseSize(phone); err != nil || sessionSize(s) != [4]int{120, 40, 9, 18} {
		t.Fatalf("release undid the desk: %v %v", sessionSize(s), err)
	}
	// Claimed again after that, the desk's new size is what goes back.
	if err := s.ClaimSize(phone, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseSize(phone); err != nil || sessionSize(s) != [4]int{120, 40, 9, 18} {
		t.Fatalf("released size = %v %v", sessionSize(s), err)
	}
}

// waitForSize waits for the session to reach want, the release being on a
// timer.
func waitForSize(t *testing.T, s *ManagedSession, want [4]int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for sessionSize(s) != want {
		if time.Now().After(deadline) {
			t.Fatalf("size = %v, want %v", sessionSize(s), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestClaimedSizeGoesBackAfterTheGrace(t *testing.T) {
	s, _ := stateSession(t)
	desk := [4]int{80, 24, 8, 16}
	phone := new(byte)
	if err := s.ClaimSize(phone, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	s.ReleaseSizeAfter(phone, 20*time.Millisecond)
	if got := sessionSize(s); got != [4]int{45, 30, 8, 16} {
		t.Fatalf("released at once: %v", got)
	}
	waitForSize(t, s, desk)
}

func TestReconnectedSocketTakesOverTheClaim(t *testing.T) {
	s, _ := stateSession(t)
	desk := [4]int{80, 24, 8, 16}
	lost, reconnected := new(byte), new(byte)
	if err := s.ClaimSize(lost, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	// The phone switches networks: its old socket closes, and the new one
	// claims the same size within the grace.
	s.ReleaseSizeAfter(lost, 20*time.Millisecond)
	if err := s.ClaimSize(reconnected, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if got := sessionSize(s); got != [4]int{45, 30, 8, 16} {
		t.Fatalf("the lost socket's release went through: %v", got)
	}
	// The desk's size is still the one to give back.
	if err := s.ReleaseSize(reconnected); err != nil || sessionSize(s) != desk {
		t.Fatalf("released size = %v %v", sessionSize(s), err)
	}
}

func TestClaimBeforeTheOldSocketCloses(t *testing.T) {
	s, _ := stateSession(t)
	desk := [4]int{80, 24, 8, 16}
	lost, reconnected := new(byte), new(byte)
	if err := s.ClaimSize(lost, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	// The host only notices the dead socket after the new one has claimed.
	if err := s.ClaimSize(reconnected, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseSize(lost); err != nil || sessionSize(s) != [4]int{45, 30, 8, 16} {
		t.Fatalf("the lost socket released it: %v %v", sessionSize(s), err)
	}
	if err := s.ReleaseSize(reconnected); err != nil || sessionSize(s) != desk {
		t.Fatalf("released size = %v %v", sessionSize(s), err)
	}
}

func TestSameSocketClaimingAgainCancelsTheRelease(t *testing.T) {
	s, _ := stateSession(t)
	phone := new(byte)
	if err := s.ClaimSize(phone, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	s.ReleaseSizeAfter(phone, 20*time.Millisecond)
	if err := s.ClaimSize(phone, 45, 30, 8, 16); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if got := sessionSize(s); got != [4]int{45, 30, 8, 16} {
		t.Fatalf("released after claiming again: %v", got)
	}
}

func TestWatchingAttachLeavesTheSizeAlone(t *testing.T) {
	s, _ := stateSession(t)
	watcher := s.join(Cursor{Protocol: StateProtocol, Watch: true}, 45, 30)
	defer watcher.Unsubscribe()
	if got := sessionSize(s); got != [4]int{80, 24, 8, 16} {
		t.Fatalf("watching attach resized to %v", got)
	}
	watcher.Unsubscribe()
	user := s.join(Cursor{Protocol: StateProtocol}, 100, 30)
	defer user.Unsubscribe()
	if got := sessionSize(s); got[0] != 100 || got[1] != 30 {
		t.Fatalf("first ordinary attach kept %v", got)
	}
}
