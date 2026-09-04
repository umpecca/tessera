package terminalcore

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWazeroSnapshotRestoresInJavaScript(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is needed for the cross-runtime integration test")
	}
	c, err := New(40, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	before := "\x1b[31mHello 😀\r\n\x1bPq\"1;1;8;18#1;2;100;0;0!8~-!8~-!8~\x1b\\\x1b7"
	partial := "\x1b[?1049hALT\x1bPq#2;2;0;100;0!"
	after := "16~\x1b\\\x1b[?1049l\x1b8continued"
	if err = c.Write([]byte(before)); err != nil {
		t.Fatal(err)
	}
	if err = c.Resize(30, 8, 7, 14); err != nil {
		t.Fatal(err)
	}
	if err = c.Write([]byte(partial)); err != nil {
		t.Fatal(err)
	}
	snapshot, err := c.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := json.Marshal(map[string]any{"before": before, "partial": partial, "after": after, "snapshot": snapshot})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "state.json")
	if err = os.WriteFile(file, fixture, 0600); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(node, "interop.mjs", file).CombinedOutput()
	if err != nil {
		t.Fatalf("cross-runtime restoration: %v\n%s", err, output)
	}
}

func TestNativeCoreRepliesAndSnapshot(t *testing.T) {
	c, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Write([]byte("hello\x1b[c\x1b[6n")); err != nil {
		t.Fatal(err)
	}
	reply, err := c.Replies()
	if err != nil {
		t.Fatal(err)
	}
	if string(reply) != "\x1b[?62;4c\x1b[1;6R" {
		t.Fatalf("reply %q", reply)
	}
	snapshot, err := c.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(snapshot, []byte("TSS2")) {
		t.Fatalf("invalid snapshot header")
	}
	if again, err := c.Replies(); err != nil || len(again) != 0 {
		t.Fatalf("snapshot replayed effects: %q %v", again, err)
	}
}

func BenchmarkCoreTextOutput(b *testing.B) {
	c, err := New(80, 24)
	if err != nil {
		b.Fatal(err)
	}
	defer c.Close()
	data := bytes.Repeat([]byte("ordinary terminal output\r\n"), 128)
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for range b.N {
		if err := c.Write(data); err != nil {
			b.Fatal(err)
		}
	}
}
