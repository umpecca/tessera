package terminal

import (
	"tessera/internal/terminalaudio"
	"time"
)

const maximumAudioEvents = 8
const maximumAudioQueueBytes = 2 * 1024 * 1024

func audioEventBytes(event terminalaudio.Event) int {
	return len(event.Data) + len(event.ID) + len(event.Token) + len(event.Epoch) + 256
}

// Audio is transient and has its own budget. Neither visibility nor a listener
// that cannot keep up is allowed to affect the shell or text subscription.
func (s *ManagedSession) enqueueAudioLocked(sub *subscriber, event terminalaudio.Event) {
	if sub.done || !sub.audioEnabled {
		return
	}
	size := audioEventBytes(event)
	if len(sub.audioPending) >= maximumAudioEvents || sub.audioBytes+size > maximumAudioQueueBytes {
		clear(sub.audioPending)
		sub.audioPending = []terminalaudio.Event{{Type: "terminal-audio", Epoch: s.epoch, Action: "reset"}}
		sub.audioBytes = audioEventBytes(sub.audioPending[0])
		s.joinAudioStreamsLocked(sub)
		// Drop the overflowing request; the next request starts fresh.
	} else {
		sub.audioPending = append(sub.audioPending, event)
		sub.audioBytes += size
	}
	select {
	case sub.audioWake <- struct{}{}:
	default:
	}
}

type liveAudioStream struct {
	start terminalaudio.Event
	order uint64
	last  time.Time
}

// Only decoder configuration is retained. New listeners get the next packet's
// sequence and zero pre-skip, never packets emitted before their subscription.
func (s *ManagedSession) joinAudioStreamsLocked(sub *subscriber) {
	for _, stream := range s.audioStreams {
		if time.Since(stream.last) > 30*time.Second {
			continue
		}
		event := stream.start
		event.PreSkip = 0
		s.enqueueAudioLocked(sub, event)
	}
}

func (s *ManagedSession) publishAudioLocked(event terminalaudio.Event) {
	if s.audioStreams == nil {
		s.audioStreams = make(map[string]liveAudioStream)
	}
	switch event.Action {
	case "stream-start":
		if old, ok := s.audioStreams[event.ID]; ok && old.start.Token == event.Token {
			return
		}
		if _, ok := s.audioStreams[event.ID]; !ok && len(s.audioStreams) >= 4 {
			var oldestID string
			var oldest uint64 = ^uint64(0)
			for id, item := range s.audioStreams {
				if item.order < oldest {
					oldestID, oldest = id, item.order
				}
			}
			delete(s.audioStreams, oldestID)
			for sub := range s.subscribers {
				s.enqueueAudioLocked(sub, terminalaudio.Event{Type: "terminal-audio", Epoch: s.epoch, Action: "stop", ID: oldestID})
			}
		}
		s.audioStreamOrder++
		s.audioStreams[event.ID] = liveAudioStream{event, s.audioStreamOrder, time.Now()}
	case "stream-data", "stream-end", "stream-abort":
		stream, ok := s.audioStreams[event.ID]
		if !ok || stream.start.Token != event.Token {
			return
		}
		if event.Action != "stream-abort" && stream.start.Sequence != event.Sequence {
			delete(s.audioStreams, event.ID)
			for sub := range s.subscribers {
				s.enqueueAudioLocked(sub, terminalaudio.Event{Type: "terminal-audio", Epoch: s.epoch, Action: "stop", ID: event.ID})
			}
			return
		}
		if event.Action != "stream-data" {
			delete(s.audioStreams, event.ID)
		} else {
			stream.start.Sequence++
			stream.last = time.Now()
			s.audioStreams[event.ID] = stream
		}
	case "play", "stop":
		if event.ID == "*" {
			clear(s.audioStreams)
		} else {
			delete(s.audioStreams, event.ID)
		}
	case "reset":
		clear(s.audioStreams)
	}
	for sub := range s.subscribers {
		s.enqueueAudioLocked(sub, event)
	}
}
