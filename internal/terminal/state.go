package terminal

import (
	"encoding/binary"
	"errors"

	"tessera/internal/terminalcore"
)

const StateProtocol = 2
const StateFrameHeader = 21
const StateOutput byte = 1
const StateGeometry byte = 2
const StateClipboard byte = 3
const StateSnapshot byte = 4
const StateConfiguration byte = 5
const StateImageSettings byte = 6
const StateClearImages byte = 7

// Bound both copying and parser visits when a paused browser catches up. Tiny
// progress/control writes must not fit an arbitrarily long replay by byte size.
const maximumCatchUpReplayBytes = 64 * 1024
const maximumCatchUpReplayEvents = 128

// Optional fields avoid overwriting a different browser's latest setting.
func (s *ManagedSession) ConfigureImages(memoryMiB *int, placeholders *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isClosed() || s.core == nil {
		return errors.New("terminal state is unavailable")
	}
	limit, show, err := s.core.ImageSettings()
	if err != nil {
		return err
	}
	if memoryMiB != nil {
		limit = *memoryMiB
	}
	if placeholders != nil {
		show = *placeholders
	}
	if err := s.core.ConfigureImages(limit, show); err != nil {
		return err
	}
	payload := make([]byte, 5)
	binary.LittleEndian.PutUint32(payload, uint32(limit))
	if show {
		payload[4] = 1
	}
	s.publishStateLocked(StateImageSettings, payload)
	return nil
}

func (s *ManagedSession) ClearImages() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isClosed() || s.core == nil {
		return errors.New("terminal state is unavailable")
	}
	if err := s.core.ClearImages(); err != nil {
		return err
	}
	s.publishStateLocked(StateClearImages, nil)
	return nil
}

func (s *ManagedSession) Configure(light bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.core == nil {
		return errors.New("terminal state is unavailable")
	}
	if s.light == light {
		return nil
	}
	if err := s.core.Configure(light); err != nil {
		return err
	}
	s.light = light
	value := byte(0)
	if light {
		value = 1
	}
	s.publishStateLocked(StateConfiguration, []byte{value})
	return nil
}

type stateEvent struct {
	sequence uint64
	data     []byte
}

func StateFrame(kind byte, sequence uint64, offset int64, data []byte) []byte {
	frame := make([]byte, StateFrameHeader+len(data))
	frame[0] = kind
	binary.LittleEndian.PutUint64(frame[1:], sequence)
	binary.LittleEndian.PutUint64(frame[9:], uint64(offset))
	binary.LittleEndian.PutUint32(frame[17:], uint32(len(data)))
	copy(frame[StateFrameHeader:], data)
	return frame
}

func (s *ManagedSession) publishStateLocked(kind byte, data []byte) {
	s.sequence++
	frame := StateFrame(kind, s.sequence, s.published, data)
	s.stateEvents = append(s.stateEvents, stateEvent{s.sequence, frame})
	s.stateBytes += len(frame)
	limit := s.scrollback.limit
	if limit <= 0 {
		limit = defaultScrollbackLimit
	}
	for s.stateBytes > limit && len(s.stateEvents) > 0 {
		s.stateBytes -= len(s.stateEvents[0].data)
		s.stateEvents[0] = stateEvent{}
		s.stateEvents = s.stateEvents[1:]
	}
	for sub := range s.subscribers {
		if sub.protocol == StateProtocol {
			s.enqueueLocked(sub, frame)
		}
	}
}

func (s *ManagedSession) stateAttachLocked(cursor Cursor, attachment *Attachment) {
	attachment.Protocol = StateProtocol
	attachment.Core = terminalcore.Compatibility
	attachment.Sequence = s.sequence
	attachment.Offset = s.published
	attachment.Cols, attachment.Rows = s.cols, s.rows
	attachment.CellWidth, attachment.CellHeight = s.cellWidth, s.cellHeight
	attachment.Replay = nil
	attachment.Reset = true
	attachment.RetainedOutputBytes = s.scrollback.limit
	if attachment.RetainedOutputBytes <= 0 {
		attachment.RetainedOutputBytes = defaultScrollbackLimit
	}
	if s.core == nil {
		attachment.Err = errors.New("terminal state is unavailable")
		return
	}
	if cursor.OutputPaused {
		// A hidden client cannot import the state. Its later visible attachment
		// decides whether its applied cursor admits a small replay or a snapshot.
		attachment.Reset = false
		return
	}
	resumable := cursor.Epoch == s.epoch && cursor.Sequence <= s.sequence && cursor.Core == terminalcore.Compatibility
	if cursor.SnapshotIfChanged && !cursor.CatchUpReplay && cursor.Sequence != s.sequence {
		resumable = false
	}
	replayStart := len(s.stateEvents)
	if resumable && cursor.Sequence == s.sequence {
		resumable = cursor.Offset == s.published
	}
	if resumable && cursor.Sequence != s.sequence {
		resumable = len(s.stateEvents) > 0 && cursor.Sequence+1 >= s.stateEvents[0].sequence
		if resumable {
			// Retained state sequences are contiguous. Locate only the missing
			// suffix instead of scanning the entire retained event window.
			replayStart = int(cursor.Sequence + 1 - s.stateEvents[0].sequence)
			resumable = replayStart < len(s.stateEvents) && s.stateEvents[replayStart].sequence == cursor.Sequence+1
			if resumable {
				event := s.stateEvents[replayStart]
				expected := int64(binary.LittleEndian.Uint64(event.data[9:]))
				if event.data[0] == StateOutput {
					expected -= int64(len(event.data) - StateFrameHeader)
				}
				resumable = cursor.Offset == expected
			}
		}
	}
	replayBytes := 0
	if resumable {
		if cursor.CatchUpReplay && len(s.stateEvents)-replayStart > maximumCatchUpReplayEvents {
			resumable = false
		} else {
			for _, event := range s.stateEvents[replayStart:] {
				if event.data[0] == StateClipboard {
					replayBytes += StateFrameHeader
				} else {
					replayBytes += len(event.data)
				}
				if cursor.CatchUpReplay && replayBytes > maximumCatchUpReplayBytes {
					resumable = false
					break
				}
			}
		}
	}
	if resumable {
		attachment.Reset = false
		attachment.Sequence = cursor.Sequence
		attachment.Offset = cursor.Offset
		if replayBytes > 0 {
			attachment.Replay = make([]byte, 0, replayBytes)
			for _, event := range s.stateEvents[replayStart:] {
				// Clipboard effects are delivered only to live subscribers.
				data := event.data
				if data[0] == StateClipboard {
					data = StateFrame(StateClipboard, event.sequence, int64(binary.LittleEndian.Uint64(data[9:])), nil)
				}
				attachment.Replay = append(attachment.Replay, data...)
			}
		}
		return
	}
	attachment.Snapshot, attachment.Err = s.core.Snapshot()
}

// ResizeWithMetrics serializes terminal geometry with PTY output. All browser
// replicas receive the accepted dimensions, including the requesting browser.
func (s *ManagedSession) ResizeWithMetrics(cols, rows, cellWidth, cellHeight int) error {
	if s == nil {
		return errors.New("terminal is unavailable")
	}
	if cols < 2 || cols > 4096 || rows < 1 || rows > 4096 || cellWidth < 1 || cellWidth > 4096 || cellHeight < 1 || cellHeight > 4096 {
		return errors.New("invalid terminal geometry")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isClosed() || s.session == nil {
		return errors.New("terminal is closed")
	}
	if s.cols == cols && s.rows == rows && s.cellWidth == cellWidth && s.cellHeight == cellHeight {
		return nil
	}
	if err := s.session.Resize(cols, rows); err != nil {
		return err
	}
	if s.core != nil {
		if err := s.core.Resize(cols, rows, cellWidth, cellHeight); err != nil {
			return err
		}
	}
	s.cols, s.rows, s.cellWidth, s.cellHeight = cols, rows, cellWidth, cellHeight
	payload := make([]byte, 16)
	for i, n := range []int{cols, rows, cellWidth, cellHeight} {
		binary.LittleEndian.PutUint32(payload[i*4:], uint32(n))
	}
	s.publishStateLocked(StateGeometry, payload)
	return nil
}
