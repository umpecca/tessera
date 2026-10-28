package rdpsession

import (
	"context"
	"encoding/binary"
	"time"
)

// fakeRunner stands in for the headless module, so code that uses a Manager
// can be tested without an RDP server to log in to. The session is active at
// once, with a 1216x640 desktop, session ID 1 and a reconnect cookie. A
// refresh request is answered with an image event, and input records are
// echoed back as an H.264 event, so a test can watch a viewer's messages go to
// the module and its answers come back.
type fakeRunner struct{}

func (fakeRunner) RunSettings(_ context.Context, l Link, _ []byte) (End, error) {
	size := binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(nil, 1216), 640)
	l.Event(eventConnected, size)
	l.Event(eventSessionID, binary.LittleEndian.AppendUint32(nil, 1))
	l.Event(eventReconnectCookie, binary.LittleEndian.AppendUint32(nil, 7))
	for {
		message := l.Recv()
		switch {
		case message == nil:
			l.Event(eventEnded, append([]byte{byte(EndConnectionLost)}, "the connection closed"...))
			return EndConnectionLost, nil
		case message[0] == tagQuit:
			l.Event(eventEnded, append([]byte{byte(EndQuit)}, "quit"...))
			return EndQuit, nil
		case message[0] == tagInput:
			l.Event(eventH264, message[1:])
		case message[0] == tagRefresh:
			l.Event(eventImage, []byte{9})
		}
	}
}

// NewFakeManager returns a manager whose sessions run fakeRunner. The target
// address still has to accept a TCP connection.
func NewFakeManager(idleLimit time.Duration) *Manager {
	m := NewManager("", idleLimit)
	m.newRunner = func(context.Context) (Runner, func(), error) {
		return fakeRunner{}, func() {}, nil
	}
	return m
}
