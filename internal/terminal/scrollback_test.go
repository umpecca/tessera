package terminal

import (
	"bytes"
	"fmt"
	"testing"
)

func TestScrollbackBufferRetainsOrderedBytesBelowLimit(t *testing.T) {
	buffer := scrollbackBuffer{limit: 16}
	buffer.append([]byte("hello"))
	buffer.append([]byte(" world"))

	if got, want := string(buffer.replay()), "hello world"; got != want {
		t.Fatalf("replay = %q, want %q", got, want)
	}
	if buffer.size != len("hello world") {
		t.Fatalf("size = %d, want %d", buffer.size, len("hello world"))
	}
}

func TestScrollbackBufferPartiallyTrimsOldestChunk(t *testing.T) {
	buffer := scrollbackBuffer{limit: 5}
	buffer.append([]byte("abc"))
	buffer.append([]byte("def"))

	if got, want := string(buffer.replay()), "bcdef"; got != want {
		t.Fatalf("replay = %q, want %q", got, want)
	}
	if got := string(buffer.chunks[buffer.head]); got != "bc" {
		t.Fatalf("trimmed first chunk = %q, want %q", got, "bc")
	}
}

func TestScrollbackBufferRepeatedAppendsStayAtCapacity(t *testing.T) {
	const limit = 31
	buffer := scrollbackBuffer{limit: limit}
	var complete []byte
	for index := 0; index < 5000; index++ {
		chunk := []byte(fmt.Sprintf("%04d", index))
		complete = append(complete, chunk...)
		buffer.append(chunk)
	}

	want := complete[len(complete)-limit:]
	if got := buffer.replay(); !bytes.Equal(got, want) {
		t.Fatalf("replay = %q, want final %q", got, want)
	}
	if buffer.size != limit {
		t.Fatalf("size = %d, want %d", buffer.size, limit)
	}
	if len(buffer.chunks) > 1100 {
		t.Fatalf("chunk header deque grew without compaction: %d entries", len(buffer.chunks))
	}
}

func TestScrollbackBufferOversizedChunkKeepsIndependentTail(t *testing.T) {
	buffer := scrollbackBuffer{limit: 5}
	buffer.append([]byte("old"))
	chunk := []byte("0123456789")
	buffer.append(chunk)
	chunk[9] = 'X'

	if got, want := string(buffer.replay()), "56789"; got != want {
		t.Fatalf("replay = %q, want %q", got, want)
	}
	if buffer.size != 5 || len(buffer.chunks) != 1 || buffer.head != 0 {
		t.Fatalf("oversized append state = size %d, chunks %d, head %d", buffer.size, len(buffer.chunks), buffer.head)
	}
}

func TestScrollbackBufferUnlimitedRetention(t *testing.T) {
	buffer := scrollbackBuffer{}
	for index := 0; index < 2000; index++ {
		buffer.append([]byte("output"))
	}

	if got, want := buffer.size, 2000*len("output"); got != want {
		t.Fatalf("size = %d, want %d", got, want)
	}
	if got := len(buffer.replay()); got != buffer.size {
		t.Fatalf("replay length = %d, want %d", got, buffer.size)
	}
}

func TestScrollbackReplayIsAnIndependentSnapshot(t *testing.T) {
	buffer := scrollbackBuffer{limit: 16}
	buffer.append([]byte("stable"))
	first := buffer.replay()
	first[0] = 'X'

	if got, want := string(buffer.replay()), "stable"; got != want {
		t.Fatalf("replay after snapshot mutation = %q, want %q", got, want)
	}
}

func BenchmarkScrollbackAppendAtLimit(b *testing.B) {
	const chunkSize = 8 * 1024
	buffer := scrollbackBuffer{limit: defaultScrollbackLimit}
	chunk := bytes.Repeat([]byte{'x'}, chunkSize)
	for buffer.size < defaultScrollbackLimit {
		buffer.append(chunk)
	}

	b.ReportAllocs()
	b.SetBytes(chunkSize)
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		buffer.append(chunk)
	}
}
