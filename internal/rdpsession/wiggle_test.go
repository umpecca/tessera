package rdpsession

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

func mouseMoves(points ...[2]int) []byte {
	var records []byte
	for _, point := range points {
		records = append(records, inputMouseMove, byte(point[0]), byte(point[0]>>8), byte(point[1]), byte(point[1]>>8))
	}
	return records
}

func TestWiggleInputMovesAPixelAsideAndBack(t *testing.T) {
	for _, test := range []struct {
		name          string
		x, y          int
		placed        bool
		width, height int
		want          [][2]int
	}{
		{"from the pointer", 100, 40, true, 1920, 1080, [][2]int{{101, 40}, {100, 40}}},
		{"left at the right edge", 1919, 0, true, 1920, 1080, [][2]int{{1918, 0}, {1919, 0}}},
		{"inside a shrunken desktop", 3000, 2000, true, 1280, 720, [][2]int{{1278, 719}, {1279, 719}}},
		{"around the centre when never placed", 0, 0, false, 1920, 1080, [][2]int{{961, 540}, {960, 540}}},
	} {
		want := append([]byte{tagInput}, mouseMoves(test.want...)...)
		if got := wiggleInput(test.x, test.y, test.placed, test.width, test.height); !bytes.Equal(got, want) {
			t.Errorf("%s: wiggleInput = %v, want %v", test.name, got, want)
		}
	}
}

func TestLastMouseMoveSkipsOtherRecords(t *testing.T) {
	records := append(mouseMoves([2]int{5, 6}), inputMouseButton, 0, 1)
	records = append(records, mouseMoves([2]int{300, 400})...)
	records = append(records, inputKey, 0x1e, 0, 1)
	if x, y, ok := lastMouseMove(records); !ok || x != 300 || y != 400 {
		t.Fatalf("lastMouseMove = %d, %d, %v; want 300, 400, true", x, y, ok)
	}
	if _, _, ok := lastMouseMove([]byte{inputKey, 0x1e, 0, 1}); ok {
		t.Fatal("found a mouse move in a key record")
	}
}

func fastWiggle(t *testing.T) {
	t.Helper()
	previous := wiggleInterval
	wiggleInterval = 20 * time.Millisecond
	t.Cleanup(func() { wiggleInterval = previous })
}

func TestAnUnwatchedSessionIsWiggledWherePointerWas(t *testing.T) {
	fastWiggle(t)
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	detach, err := s.Attach(&recordingViewer{})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.HandleViewerMessage(append([]byte{ViewInput}, mouseMoves([2]int{200, 100})...)); err != nil {
		t.Fatal(err)
	}
	if err := s.HandleViewerMessage([]byte{ViewWiggle, wiggleOn | wiggleInUse}); err != nil {
		t.Fatal(err)
	}
	wiggle := wiggleInput(200, 100, true, 1216, 640)
	time.Sleep(80 * time.Millisecond)
	if runner.count(wiggle) != 0 {
		t.Fatal("wiggled a session whose window is in use")
	}
	detach()
	eventually(t, "a wiggle with no viewer", func() bool { return runner.count(wiggle) > 0 })
}

func TestAViewerNotInUseIsWiggledUntilItTurnsWiggleOff(t *testing.T) {
	fastWiggle(t)
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	if _, err := s.Attach(&recordingViewer{}); err != nil {
		t.Fatal(err)
	}
	if err := s.HandleViewerMessage([]byte{ViewWiggle, wiggleOn}); err != nil {
		t.Fatal(err)
	}
	wiggle := wiggleInput(0, 0, false, 1216, 640)
	eventually(t, "a wiggle while the window isn't in use", func() bool { return runner.count(wiggle) > 0 })
	if err := s.HandleViewerMessage([]byte{ViewWiggle, 0}); err != nil {
		t.Fatal(err)
	}
	// One tick may already have been under way.
	time.Sleep(30 * time.Millisecond)
	settled := runner.count(wiggle)
	time.Sleep(80 * time.Millisecond)
	if runner.count(wiggle) != settled {
		t.Fatal("kept wiggling after wiggle was turned off")
	}
}

func TestANewViewerIsInUseUntilItSaysOtherwise(t *testing.T) {
	fastWiggle(t)
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	if err := s.HandleViewerMessage([]byte{ViewWiggle, wiggleOn}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Attach(&recordingViewer{}); err != nil {
		t.Fatal(err)
	}
	// Ticks already under way may land; none after that.
	time.Sleep(30 * time.Millisecond)
	wiggle := wiggleInput(0, 0, false, 1216, 640)
	settled := runner.count(wiggle)
	time.Sleep(80 * time.Millisecond)
	if runner.count(wiggle) != settled {
		t.Fatal("wiggled a newly attached viewer's session")
	}
}

func TestWiggleMessagesAreValidated(t *testing.T) {
	s, _ := startedSession(t, &scriptRunner{cookie: true}, 0)
	for _, message := range [][]byte{{ViewWiggle}, {ViewWiggle, 4}, {ViewWiggle, 1, 0}} {
		if err := s.HandleViewerMessage(message); !errors.Is(err, ErrViewerMessage) {
			t.Errorf("HandleViewerMessage(%v) = %v, want ErrViewerMessage", message, err)
		}
	}
}
