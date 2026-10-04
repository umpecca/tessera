package terminalcore

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/tetratelabs/wazero/api"
)

// Keep the real WASM functions and memory, observing only the exported call
// boundary. Overrides exercise failures before a real function consumes data.
type coreBufferFunction struct {
	api.Function
	calls  [][]uint64
	result []uint64
	err    error
}

func (f *coreBufferFunction) Call(ctx context.Context, params ...uint64) ([]uint64, error) {
	f.calls = append(f.calls, append([]uint64(nil), params...))
	if f.err != nil || f.result != nil {
		return f.result, f.err
	}
	return f.Function.Call(ctx, params...)
}

func trackCoreBufferFunction(c *Core, name string) *coreBufferFunction {
	f := &coreBufferFunction{Function: c.module.ExportedFunction(name)}
	c.functions[name] = f
	return f
}

func TestCoreReusesScratchBuffersAndOwnsResponses(t *testing.T) {
	c, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	alloc := trackCoreBufferFunction(c, "ghostty_wasm_alloc_u8_array")
	free := trackCoreBufferFunction(c, "ghostty_wasm_free_u8_array")
	if err := c.Write([]byte("\rstatus\x1b[6n\x1b]52;c;aGk=\a")); err != nil {
		t.Fatal(err)
	}
	firstReply, err := c.Replies()
	if err != nil {
		t.Fatal(err)
	}
	firstClipboard, err := c.Clipboard()
	if err != nil || len(firstClipboard) != 1 || string(firstClipboard[0]) != "hi" {
		t.Fatalf("clipboard=%q err=%v", firstClipboard, err)
	}
	for range 128 {
		if err := c.Write([]byte("\rprogress\x1b[6n\x1b]52;c;Ynll\a")); err != nil {
			t.Fatal(err)
		}
		if reply, err := c.Replies(); err != nil || string(reply) != "\x1b[1;9R" {
			t.Fatalf("reply=%q err=%v", reply, err)
		}
		if writes, err := c.Clipboard(); err != nil || len(writes) != 1 || string(writes[0]) != "bye" {
			t.Fatalf("clipboard=%q err=%v", writes, err)
		}
	}
	if string(firstReply) != "\x1b[1;7R" || string(firstClipboard[0]) != "hi" {
		t.Fatalf("later drains changed owned results: %q %q", firstReply, firstClipboard)
	}
	if len(alloc.calls) != 2 || len(free.calls) != 0 {
		t.Fatalf("steady writes allocated %d buffers and freed %d", len(alloc.calls), len(free.calls))
	}
	input, response, capacity := c.inputPtr, c.responsePtr, c.inputCapacity
	module := c.module
	c.Close()
	c.Close()
	if len(free.calls) != 2 || free.calls[0][0] != input || free.calls[0][1] != uint64(capacity) ||
		free.calls[1][0] != response || free.calls[1][1] != responseBufferBytes {
		t.Fatalf("scratch frees=%v", free.calls)
	}
	if !module.IsClosed() || c.inputPtr != 0 || c.inputCapacity != 0 || c.responsePtr != 0 {
		t.Fatal("closing left module or scratch ownership live")
	}
	if err := c.Write([]byte("closed")); err == nil {
		t.Fatal("write after close succeeded")
	}
	if _, err := c.Replies(); err == nil {
		t.Fatal("response drain after close succeeded")
	}
}

func TestCoreInputGrowthAndOversizedWrites(t *testing.T) {
	c, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	alloc := trackCoreBufferFunction(c, "ghostty_wasm_alloc_u8_array")
	free := trackCoreBufferFunction(c, "ghostty_wasm_free_u8_array")
	if err := c.Write([]byte("small")); err != nil {
		t.Fatal(err)
	}
	initialPtr := c.inputPtr
	if err := c.Write(bytes.Repeat([]byte("\r"), 9000)); err != nil {
		t.Fatal(err)
	}
	if c.inputCapacity != 16*1024 || len(free.calls) != 1 || free.calls[0][0] != initialPtr ||
		free.calls[0][1] != minimumInputBufferBytes {
		t.Fatalf("growth capacity=%d frees=%v", c.inputCapacity, free.calls)
	}
	if err := c.Write(bytes.Repeat([]byte("\r"), maximumInputBufferBytes)); err != nil {
		t.Fatal(err)
	}
	retainedPtr := c.inputPtr
	large := append(bytes.Repeat([]byte("\r"), maximumInputBufferBytes+123), []byte("ok\x1b[6n")...)
	if err := c.Write(large); err != nil {
		t.Fatal(err)
	}
	if c.inputPtr != retainedPtr || c.inputCapacity != maximumInputBufferBytes || len(free.calls) != 3 ||
		free.calls[2][1] != uint64(len(large)) {
		t.Fatalf("oversized write retained scratch: capacity=%d frees=%v", c.inputCapacity, free.calls)
	}
	if reply, err := c.Replies(); err != nil || string(reply) != "\x1b[1;3R" {
		t.Fatalf("oversized write lost bytes: %q %v", reply, err)
	}
	allocationCount := len(alloc.calls)
	if _, ok := c.module.Memory().Grow(4); !ok {
		t.Fatal("cannot grow WASM memory")
	}
	if err := c.Resize(100, 30, 9, 18); err != nil {
		t.Fatal(err)
	}
	if err := c.Write([]byte("\rstill live\x1b[6n")); err != nil {
		t.Fatal(err)
	}
	if reply, err := c.Replies(); err != nil || string(reply) != "\x1b[1;11R" {
		t.Fatalf("memory growth or resize broke scratch: %q %v", reply, err)
	}
	if _, err := c.Snapshot(); err != nil {
		t.Fatal(err)
	}
	if len(alloc.calls) != allocationCount || c.inputPtr != retainedPtr {
		t.Fatal("memory growth, resize, or snapshot replaced the scratch allocations")
	}
}

func TestCoreScratchDrainsLargeAndFragmentedEffects(t *testing.T) {
	c, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Write(bytes.Repeat([]byte("\x1b[c"), 2000)); err != nil {
		t.Fatal(err)
	}
	if reply, err := c.Replies(); err != nil || !bytes.Equal(reply, bytes.Repeat([]byte("\x1b[?62;4c"), 2000)) {
		t.Fatalf("large reply drain: len=%d err=%v", len(reply), err)
	}
	text := strings.Repeat("clipboard 😀 ", 2000)
	osc := []byte("\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte(text)) + "\a")
	for start := 0; start < len(osc); start += 333 {
		if err := c.Write(osc[start:min(start+333, len(osc))]); err != nil {
			t.Fatal(err)
		}
		if start == 0 {
			if _, err := c.Snapshot(); err != nil {
				t.Fatal(err)
			}
			if _, ok := c.module.Memory().Grow(4); !ok {
				t.Fatal("cannot grow WASM memory during OSC continuation")
			}
		}
	}
	if err := c.Write([]byte("\x1b]52;c;bmV4dA==\a")); err != nil {
		t.Fatal(err)
	}
	if writes, err := c.Clipboard(); err != nil || len(writes) != 2 || string(writes[0]) != text || string(writes[1]) != "next" {
		t.Fatalf("fragmented clipboard drain: writes=%d err=%v", len(writes), err)
	}
	if reply, err := c.Replies(); err != nil || len(reply) != 0 {
		t.Fatalf("drained replies repeated: %q %v", reply, err)
	}
	if writes, err := c.Clipboard(); err != nil || len(writes) != 0 {
		t.Fatalf("drained clipboard repeated: writes=%d err=%v", len(writes), err)
	}
}

func TestCoreScratchBuffersStayWithTheirModule(t *testing.T) {
	a, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	b, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	for _, core := range []*Core{a, b} {
		if err := core.Write([]byte("\x1b[Hhello\x1b[6n")); err != nil {
			t.Fatal(err)
		}
		if reply, err := core.Replies(); err != nil || string(reply) != "\x1b[1;6R" {
			t.Fatalf("independent core reply=%q err=%v", reply, err)
		}
	}
	a.Close()
	if err := b.Write([]byte("\rsecond\x1b[6n\x1b]52;c;c2Vjb25k\a")); err != nil {
		t.Fatal(err)
	}
	if reply, err := b.Replies(); err != nil || string(reply) != "\x1b[1;7R" {
		t.Fatalf("closing another core changed reply=%q err=%v", reply, err)
	}
	if writes, err := b.Clipboard(); err != nil || len(writes) != 1 || string(writes[0]) != "second" {
		t.Fatalf("closing another core changed clipboard=%q err=%v", writes, err)
	}
}

func TestCoreScratchAllocationFailuresAreRecoverable(t *testing.T) {
	for _, failure := range []string{"zero", "error"} {
		t.Run("input_"+failure, func(t *testing.T) {
			c, err := New(80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			alloc := trackCoreBufferFunction(c, "ghostty_wasm_alloc_u8_array")
			free := trackCoreBufferFunction(c, "ghostty_wasm_free_u8_array")
			if err := c.Write([]byte("seed")); err != nil {
				t.Fatal(err)
			}
			ptr, capacity := c.inputPtr, c.inputCapacity
			if failure == "zero" {
				alloc.result = []uint64{0}
			} else {
				alloc.err = errors.New("allocation failed")
			}
			if err := c.Write(bytes.Repeat([]byte("\r"), 9000)); err == nil {
				t.Fatal("failed growth succeeded")
			}
			if c.inputPtr != ptr || c.inputCapacity != capacity || len(free.calls) != 0 {
				t.Fatal("failed growth freed the usable buffer")
			}
			alloc.result, alloc.err = nil, nil
			if err := c.Write([]byte("\rretry\x1b[6n")); err != nil {
				t.Fatal(err)
			}
			if reply, err := c.Replies(); err != nil || string(reply) != "\x1b[1;6R" {
				t.Fatalf("retry=%q err=%v", reply, err)
			}
		})
		t.Run("response_"+failure, func(t *testing.T) {
			c, err := New(80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			alloc := trackCoreBufferFunction(c, "ghostty_wasm_alloc_u8_array")
			read := trackCoreBufferFunction(c, "ghostty_terminal_read_response")
			if failure == "zero" {
				alloc.result = []uint64{0}
			} else {
				alloc.err = errors.New("allocation failed")
			}
			if _, err := c.Replies(); err == nil {
				t.Fatal("failed response allocation succeeded")
			}
			if c.responsePtr != 0 || len(read.calls) != 0 {
				t.Fatal("failed allocation was cached or read through")
			}
			alloc.result, alloc.err = nil, nil
			if _, err := c.Replies(); err != nil || c.responsePtr == 0 {
				t.Fatalf("allocation retry failed: %v", err)
			}
		})
	}
}

func TestCoreScratchReadFailuresKeepBufferUsable(t *testing.T) {
	for _, name := range []string{"ghostty_terminal_read_response", "tessera_sixel_clipboard_read"} {
		for _, failure := range []string{"length", "error"} {
			t.Run(name+"_"+failure, func(t *testing.T) {
				c, err := New(80, 24)
				if err != nil {
					t.Fatal(err)
				}
				defer c.Close()
				alloc := trackCoreBufferFunction(c, "ghostty_wasm_alloc_u8_array")
				read := trackCoreBufferFunction(c, name)
				if _, err := c.Replies(); err != nil {
					t.Fatal(err)
				}
				ptr := c.responsePtr
				if failure == "length" {
					read.result = []uint64{responseBufferBytes + 1}
				} else {
					read.err = errors.New("read failed")
				}
				if _, err := c.drain(name); err == nil {
					t.Fatal("invalid read succeeded")
				}
				read.result, read.err = nil, nil
				if _, err := c.drain(name); err != nil || len(alloc.calls) != 1 || c.responsePtr != ptr {
					t.Fatalf("read retry changed ownership: allocs=%d err=%v", len(alloc.calls), err)
				}
				if err := c.Write([]byte("hello\x1b[6n\x1b]52;c;b2s=\a")); err != nil {
					t.Fatal(err)
				}
				if reply, err := c.Replies(); err != nil || string(reply) != "\x1b[1;6R" {
					t.Fatalf("reply after read failure=%q err=%v", reply, err)
				}
				if writes, err := c.Clipboard(); err != nil || len(writes) != 1 || string(writes[0]) != "ok" {
					t.Fatalf("clipboard after read failure=%q err=%v", writes, err)
				}
			})
		}
	}
}

func TestCoreScratchWriteFailureReleasesOversizedBuffer(t *testing.T) {
	c, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	free := trackCoreBufferFunction(c, "ghostty_wasm_free_u8_array")
	write := trackCoreBufferFunction(c, "ghostty_terminal_write")
	if err := c.Write([]byte("seed")); err != nil {
		t.Fatal(err)
	}
	ptr, capacity := c.inputPtr, c.inputCapacity
	write.err = errors.New("write failed")
	if err := c.Write([]byte("small failure")); err == nil {
		t.Fatal("failed small write succeeded")
	}
	large := bytes.Repeat([]byte("x"), maximumInputBufferBytes+1)
	if err := c.Write(large); err == nil {
		t.Fatal("failed oversized write succeeded")
	}
	if c.inputPtr != ptr || c.inputCapacity != capacity || len(free.calls) != 1 ||
		free.calls[0][1] != uint64(len(large)) {
		t.Fatalf("failed writes changed ownership: capacity=%d frees=%v", c.inputCapacity, free.calls)
	}
	write.err = nil
	if err := c.Write([]byte("\rretry\x1b[6n")); err != nil {
		t.Fatal(err)
	}
	if reply, err := c.Replies(); err != nil || string(reply) != "\x1b[1;6R" {
		t.Fatalf("write retry=%q err=%v", reply, err)
	}
}
