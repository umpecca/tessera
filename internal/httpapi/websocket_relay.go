package httpapi

import "io"

const (
	// relayBuffers bounds what a relay holds per connection: one buffer
	// being sent, the rest read and waiting.
	relayBuffers     = 8
	relayBufferBytes = 32 << 10
	// relayMessageBytes is where a relay stops merging waiting reads into
	// one message. A message can pass it by up to one read.
	relayMessageBytes = 64 << 10
)

// relayToWebSocket reads src and hands what it reads to write, one websocket
// message at a time, until either side fails. It returns src's read error,
// or nil when write failed first; then the caller closes src, which ends the
// read still waiting.
//
// Reads that arrive while a message is being sent go out together in the
// next one. A TLS connection returns at most one record (16 KB) per read, so
// a 100 KB H.264 picture would otherwise reach the browser as seven
// messages, each its own event and its own trip into IronRDP. A read with
// nothing behind it still goes out at once, so merging never waits for data.
func relayToWebSocket(write func([]byte) error, src io.Reader) error {
	free := make(chan []byte, relayBuffers)
	for range relayBuffers {
		free <- make([]byte, relayBufferBytes)
	}
	// Only relayBuffers buffers exist, so sending to full never blocks.
	full := make(chan []byte, relayBuffers)
	done := make(chan struct{})
	defer close(done)
	var readErr error
	go func() {
		defer close(full)
		for {
			var buffer []byte
			select {
			case buffer = <-free:
			case <-done:
				return
			}
			count, err := src.Read(buffer)
			if count > 0 {
				full <- buffer[:count]
			} else {
				free <- buffer
			}
			if err != nil {
				readErr = err
				return
			}
		}
	}()

	merged := make([]byte, 0, relayMessageBytes+relayBufferBytes)
	for chunk := range full {
		if len(full) == 0 {
			if err := write(chunk); err != nil {
				return nil
			}
			free <- chunk[:cap(chunk)]
			continue
		}
		merged = append(merged[:0], chunk...)
		free <- chunk[:cap(chunk)]
		for len(merged) < relayMessageBytes && len(full) > 0 {
			next := <-full
			merged = append(merged, next...)
			free <- next[:cap(next)]
		}
		if err := write(merged); err != nil {
			return nil
		}
	}
	return readErr
}
