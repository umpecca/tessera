package rdpsession

import (
	"bytes"
	"context"
	"testing"
)

type payloadViewer struct {
	frames [][]byte
}

func (v *payloadViewer) Event(kind uint32, payload []byte) {
	if frame, ok := ViewFrame(kind, payload); ok {
		v.frames = append(v.frames, frame)
	}
}

func (*payloadViewer) Detached(string) {}

func TestBorrowedModuleEventsRetainOnlyOwnedFramesAndSessionState(t *testing.T) {
	instance := testInstance(t)
	e, module := instance.engine, instance.module
	allocated, err := module.ExportedFunction("alloc").Call(context.Background(), 1024)
	if err != nil {
		t.Fatal(err)
	}
	ptr := uint32(allocated[0])
	var observed [][]byte
	session := NewSession(nil, Target{}, func(_ uint32, payload []byte) {
		observed = append(observed, payload) // observer owns its copy
	})
	viewer := &payloadViewer{}
	session.viewer = viewer
	borrowed := false
	conn := &serverConn{onEvent: func(kind uint32, payload []byte) {
		memory, ok := module.Memory().Read(ptr, uint32(len(payload)))
		if !ok || len(payload) == 0 || &payload[0] != &memory[0] {
			t.Fatal("the synchronous event callback did not borrow module memory")
		}
		if cap(payload) != len(payload) {
			t.Fatal("a borrowed payload can append into unrelated module memory")
		}
		borrowed = true
		session.handleEvent(kind, payload)
	}}
	e.mu.Lock()
	e.links[module.Name()] = conn
	e.mu.Unlock()
	t.Cleanup(func() {
		e.mu.Lock()
		delete(e.links, module.Name())
		e.mu.Unlock()
	})

	shown := surfaceShown(3, 17, 29)
	image := []byte{4, 0, 6, 0, 1, 0, 1, 0, 10, 20, 30, 0}
	for _, event := range []recordedEvent{{eventH264, shown}, {eventImage, image}} {
		if !module.Memory().Write(ptr, event.payload) {
			t.Fatal("payload write failed")
		}
		e.event(context.Background(), module, event.kind, ptr, uint32(len(event.payload)))
		// Simulate the Rust module immediately reusing its event buffer.
		module.Memory().Write(ptr, bytes.Repeat([]byte{0xee}, len(event.payload)))
	}
	if _, ok := module.Memory().Grow(1); !ok {
		t.Fatal("test module memory could not grow")
	}
	if !borrowed {
		t.Fatal("no module event arrived")
	}
	if !bytes.Equal(session.surfaces[3], shown) {
		t.Fatal("retained surface mapping aliases reused module memory")
	}
	if !bytes.Equal(viewer.frames[0], append([]byte{ViewH264}, shown...)) ||
		!bytes.Equal(viewer.frames[1], append([]byte{ViewImage}, image...)) {
		t.Fatalf("queued frame bytes changed after module reuse: %v", viewer.frames)
	}
	if !bytes.Equal(observed[0], shown) || !bytes.Equal(observed[1], image) {
		t.Fatal("optional observer payloads did not retain their owned lifetime")
	}
	observed[0][0] = 99
	if viewer.frames[0][1] != shown[0] || session.surfaces[3][0] != shown[0] {
		t.Fatal("an observer's owned payload aliases queued or retained session bytes")
	}

	// Measure the real engine -> connection -> session -> framing path, without
	// an optional observer. The queued wire frame is its only owned allocation.
	session.onEvent = nil
	allocations := testing.AllocsPerRun(100, func() {
		viewer.frames = viewer.frames[:0]
		e.event(context.Background(), module, eventImage, ptr, uint32(len(image)))
	})
	if allocations != 1 {
		t.Fatalf("active bitmap delivery = %g allocations, want one owned wire frame", allocations)
	}
	session.viewer = nil
	allocations = testing.AllocsPerRun(100, func() {
		e.event(context.Background(), module, eventImage, ptr, uint32(len(image)))
	})
	if allocations != 0 {
		t.Fatalf("unviewed bitmap delivery = %g allocations, want none", allocations)
	}
}

func TestViewFrameAlwaysOwnsItsPayload(t *testing.T) {
	for _, kind := range []uint32{eventConnected, eventDesktopSize, eventH264, eventImage, eventEnded} {
		payload := []byte{1, 2, 3, 4, 5}
		frame, ok := ViewFrame(kind, payload)
		if !ok {
			t.Fatal("expected a viewer frame")
		}
		want := append([]byte(nil), frame...)
		clear(payload)
		if !bytes.Equal(frame, want) {
			t.Fatalf("kind %d retained borrowed source bytes", kind)
		}
	}
}

var payloadBenchmarkFrame []byte

func BenchmarkViewerPayloadCopies(b *testing.B) {
	for _, tc := range []struct {
		name string
		kind uint32
		size int
	}{
		{"h264_64KiB", eventH264, 64 * 1024},
		{"bitmap_1080p", eventImage, 8 + 1920*1080*4},
		{"bitmap_4k", eventImage, 8 + 3840*2160*4},
	} {
		payload := bytes.Repeat([]byte{0x7f}, tc.size)
		for _, before := range []bool{true, false} {
			name := "borrowed_event"
			if before {
				name = "before_event_copy"
			}
			b.Run(tc.name+"/"+name, func(b *testing.B) {
				b.SetBytes(int64(len(payload)))
				b.ReportAllocs()
				for b.Loop() {
					input := payload
					if before {
						// Reproduce the old engine copy before the owned wire frame.
						input = append([]byte(nil), payload...)
					}
					payloadBenchmarkFrame, _ = ViewFrame(tc.kind, input)
				}
			})
		}
	}
	payloadBenchmarkFrame = nil
}
