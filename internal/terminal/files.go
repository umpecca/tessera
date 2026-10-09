package terminal

import (
	"encoding/json"
	"tessera/internal/terminalfile"
	"time"
)

func (s *ManagedSession) queueFileReply(reply string) {
	s.fileReplyOnce.Do(func() {
		s.fileReplies = make(chan string, 128)
		go func() {
			tick := time.NewTicker(100 * time.Millisecond)
			defer tick.Stop()
			for {
				select {
				case data := <-s.fileReplies:
					if s.isClosed() {
						return
					}
					_, _ = s.Write([]byte(data))
				case <-tick.C:
					if s.isClosed() {
						return
					}
				}
			}
		}()
	})
	select {
	case s.fileReplies <- reply:
	default:
	}
}
func (s *ManagedSession) enableFiles(sub *subscriber, client string) {
	if s.manager == nil || s.manager.Files == nil || !terminalfile.ValidID(client) {
		return
	}
	s.mu.Lock()
	if sub.done || sub.fileClient != "" {
		s.mu.Unlock()
		return
	}
	sub.fileClient = client
	s.mu.Unlock()
	s.manager.Files.Register(s.workspaceID, s.paneID, s.epoch, client, sub.fileGeneration, func(event terminalfile.Event) { s.enqueueFile(sub, event) })
	s.mu.Lock()
	gone := sub.done || sub.fileClient != client
	s.mu.Unlock()
	if gone {
		s.manager.Files.Detach(s.workspaceID, s.paneID, s.epoch, client, sub.fileGeneration, false)
	}
}
func (s *ManagedSession) detachFiles(sub *subscriber, handoff bool) {
	s.mu.Lock()
	client := sub.fileClient
	sub.fileClient = ""
	clear(sub.filePending)
	sub.filePending = nil
	sub.fileBytes = 0
	s.mu.Unlock()
	if client != "" && s.manager != nil && s.manager.Files != nil {
		s.manager.Files.Detach(s.workspaceID, s.paneID, s.epoch, client, sub.fileGeneration, handoff)
	}
}
func (s *ManagedSession) enqueueFile(sub *subscriber, event terminalfile.Event) {
	data, _ := json.Marshal(event)
	s.mu.Lock()
	defer s.mu.Unlock()
	if sub.done || sub.fileClient == "" {
		return
	}
	if len(sub.filePending) >= 8 || sub.fileBytes+len(data) > 256*1024 {
		clear(sub.filePending)
		sub.filePending = []terminalfile.Event{{Type: "terminal-file", Epoch: s.epoch, Action: "reset"}}
		sub.fileBytes = 128
		// Never acquire the broker lock from the terminal lock or its callback.
		client := sub.fileClient
		sub.fileClient = ""
		go s.manager.Files.Detach(s.workspaceID, s.paneID, s.epoch, client, sub.fileGeneration, false)
	} else {
		sub.filePending = append(sub.filePending, event)
		sub.fileBytes += len(data)
	}
	select {
	case sub.fileWake <- struct{}{}:
	default:
	}
}
func (s *ManagedSession) readFile(sub *subscriber) (terminalfile.Event, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(sub.filePending) == 0 {
		return terminalfile.Event{}, false
	}
	event := sub.filePending[0]
	sub.filePending[0] = terminalfile.Event{}
	sub.filePending = sub.filePending[1:]
	data, _ := json.Marshal(event)
	sub.fileBytes -= len(data)
	if len(sub.filePending) > 0 {
		select {
		case sub.fileWake <- struct{}{}:
		default:
		}
	}
	return event, true
}
