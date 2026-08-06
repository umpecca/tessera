package terminal

// scrollbackBuffer retains terminal output as immutable chunks. Appending at
// capacity drops or trims references at the front instead of copying every
// retained byte. A contiguous snapshot is built only for a new subscriber.
type scrollbackBuffer struct {
	chunks [][]byte
	head   int
	size   int
	limit  int
}

func (b *scrollbackBuffer) append(chunk []byte) {
	if len(chunk) == 0 {
		return
	}

	if b.limit > 0 && len(chunk) >= b.limit {
		// Do not let a single oversized input retain a backing array larger
		// than the configured scrollback limit.
		tail := append([]byte(nil), chunk[len(chunk)-b.limit:]...)
		clear(b.chunks)
		b.chunks = append(b.chunks[:0], tail)
		b.head = 0
		b.size = len(tail)
		return
	}

	b.chunks = append(b.chunks, chunk)
	b.size += len(chunk)
	if b.limit <= 0 || b.size <= b.limit {
		return
	}

	excess := b.size - b.limit
	for excess > 0 {
		front := b.chunks[b.head]
		if len(front) <= excess {
			excess -= len(front)
			b.size -= len(front)
			b.chunks[b.head] = nil
			b.head++
			continue
		}
		b.chunks[b.head] = front[excess:]
		b.size -= excess
		excess = 0
	}
	b.compact()
}

// tail returns the last n retained bytes, for a client that already holds
// everything before them. Asking for more than is retained yields all of it.
func (b *scrollbackBuffer) tail(n int) []byte {
	if n <= 0 || b.size == 0 {
		return nil
	}
	if n >= b.size {
		return b.replay()
	}
	skip := b.size - n
	tail := make([]byte, 0, n)
	for _, chunk := range b.chunks[b.head:] {
		if skip >= len(chunk) {
			skip -= len(chunk)
			continue
		}
		tail = append(tail, chunk[skip:]...)
		skip = 0
	}
	return tail
}

func (b *scrollbackBuffer) replay() []byte {
	if b.size == 0 {
		return nil
	}
	replay := make([]byte, 0, b.size)
	for _, chunk := range b.chunks[b.head:] {
		replay = append(replay, chunk...)
	}
	return replay
}

func (b *scrollbackBuffer) compact() {
	if b.head == len(b.chunks) {
		b.chunks = b.chunks[:0]
		b.head = 0
		return
	}
	// Bound the otherwise unused prefix. This moves only chunk headers
	// occasionally; it never copies the retained terminal bytes.
	if b.head < 1024 {
		return
	}
	remaining := copy(b.chunks, b.chunks[b.head:])
	clear(b.chunks[remaining:])
	b.chunks = b.chunks[:remaining]
	b.head = 0
}
