package rdpsession

import (
	"encoding/binary"
	"time"
)

// The mouse wiggler: a kept session whose window asks for it moves the remote
// pointer a pixel and back every wiggleInterval while nobody is using it, so
// the server doesn't go idle or lock the remote desktop. Nobody is using it
// while no viewer is attached, or while the attached viewer says its window
// isn't the one in use. It runs here rather than in the browser so it keeps
// going with the page closed or its timers paused in a background tab.

// wiggleInterval is how often the pointer is nudged: well inside the usual
// idle and screen-lock timeouts.
var wiggleInterval = time.Minute

// ViewWiggle's flags.
const (
	wiggleOn    = 1
	wiggleInUse = 2
)

// setWiggle records the window's wiggle setting and whether its viewer is in
// use, starting or stopping the wiggle clock.
func (s *Session) setWiggle(on, inUse bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wiggle = on
	s.viewerInUse = inUse
	if on {
		s.armWiggleLocked()
	} else {
		s.stopWiggleLocked()
	}
}

func (s *Session) armWiggleLocked() {
	if s.wiggleTimer != nil || s.closing || s.state == StateEnded {
		return
	}
	s.wiggleTimer = time.AfterFunc(wiggleInterval, s.wiggleTick)
}

func (s *Session) stopWiggleLocked() {
	if s.wiggleTimer != nil {
		s.wiggleTimer.Stop()
		s.wiggleTimer = nil
	}
}

// wiggleTick nudges the pointer if nobody is using the session, and keeps the
// clock going while wiggling is on. A lost session isn't nudged, but its clock
// runs on so a rejoined one is.
func (s *Session) wiggleTick() {
	s.mu.Lock()
	s.wiggleTimer = nil
	if !s.wiggle || s.closing || s.state == StateEnded {
		s.mu.Unlock()
		return
	}
	conn := s.conn
	due := s.state == StateActive && conn != nil && (s.viewer == nil || !s.viewerInUse)
	var message []byte
	if due {
		message = wiggleInput(s.pointerX, s.pointerY, s.hasPointer, s.width, s.height)
	}
	s.armWiggleLocked()
	s.mu.Unlock()
	if due {
		conn.post(message)
	}
}

// notePointer remembers where the viewer last put the remote pointer, so a
// wiggle starts and ends there. records are valid input records.
func (s *Session) notePointer(records []byte) {
	x, y, ok := lastMouseMove(records)
	if !ok {
		return
	}
	s.mu.Lock()
	s.pointerX, s.pointerY, s.hasPointer = x, y, true
	s.mu.Unlock()
}

// wiggleInput is the module message for one wiggle: the pointer a desktop
// pixel aside and back to (x, y), or around the desktop's centre if no viewer
// ever placed it. The centre keeps clear of a Mac's hot corners.
func wiggleInput(x, y int, placed bool, width, height int) []byte {
	width, height = max(width, 2), max(height, 1)
	if placed {
		x, y = min(max(x, 0), width-1), min(max(y, 0), height-1)
	} else {
		x, y = width/2, height/2
	}
	aside := x + 1
	if aside >= width {
		aside = x - 1
	}
	message := []byte{tagInput}
	for _, px := range []int{aside, x} {
		message = append(message, inputMouseMove)
		message = binary.LittleEndian.AppendUint16(message, uint16(px))
		message = binary.LittleEndian.AppendUint16(message, uint16(y))
	}
	return message
}
