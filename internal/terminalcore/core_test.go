package terminalcore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepeatedUnicodePageGrowth(t *testing.T) {
	for _, text := range []string{"é output", "देवनागरी output", "ÅÉgyp 界 é देवनागरी output"} {
		t.Run(text, func(t *testing.T) {
			c, err := New(80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			data := []byte(strings.Repeat("\x1b[32m"+text+"\x1b[0m\r\n", 128))
			for batch := range 100 {
				if err := c.Write(data); err != nil {
					t.Fatalf("batch %d: %v", batch, err)
				}
			}
			if err := c.Resize(100, 30, 9, 20); err != nil {
				t.Fatal(err)
			}
			if _, err := c.Snapshot(); err != nil {
				t.Fatal(err)
			}
			if err := c.Write([]byte("\x1b[Hé देवनागरी\x1b[6n")); err != nil {
				t.Fatal(err)
			}
			if reply, err := c.Replies(); err != nil || string(reply) != "\x1b[1;8R" {
				t.Fatalf("reply=%q err=%v", reply, err)
			}
		})
	}
}

func TestDenseSixelFitsImageBudget(t *testing.T) {
	c, err := New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.call("tessera_sixel_image_settings", c.handle, 16, 1); err != nil {
		t.Fatal(err)
	}
	image := "\x1bPq\"1;1;1024;720#1;2;100;0;0#2;2;0;100;0" + strings.Repeat("#1!1024~-#2!1024~-", 60) + "\x1b\\"
	if err := c.Write([]byte(image)); err != nil {
		t.Fatal(err)
	}
	if count, err := c.call("tessera_sixel_image_count", c.handle); err != nil || count != 1 {
		t.Fatalf("image count=%d err=%v", count, err)
	}
	if pixels, err := c.call("tessera_sixel_image_pixels", c.handle, 1); err != nil || pixels == 0 {
		t.Fatalf("image pixel pointer=%d err=%v", pixels, err)
	}
	if _, err := c.Snapshot(); err != nil {
		t.Fatal(err)
	}
}

func TestImageCollectionSurvivesCleanRenderingAndReclaimsOverwrites(t *testing.T) {
	for _, overwrite := range []string{"xxxx", "界界", "\x1b[4X", "\x1b[K", "\x1b[2K", "\x1b[78P", "\x1b[78@"} {
		t.Run(fmt.Sprintf("%q", overwrite), func(t *testing.T) {
			c, err := New(80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if err := c.Write([]byte("\x1b[2;3H\x1bPq\"1;1;32;6#1;2;100;0;0!32~\x1b\\")); err != nil {
				t.Fatal(err)
			}
			for tick := range 50 {
				if err := c.Write([]byte(fmt.Sprintf("\x1b[24;1H\r\x1b[32mstatus %d\x1b[0m\x1b[K", tick))); err != nil {
					t.Fatal(err)
				}
				if _, err := c.call("ghostty_render_state_update", c.handle); err != nil {
					t.Fatal(err)
				}
				if _, err := c.call("ghostty_render_state_mark_clean", c.handle); err != nil {
					t.Fatal(err)
				}
			}
			if count, err := c.call("tessera_sixel_image_count", c.handle); err != nil || count != 1 {
				t.Fatalf("retained image count=%d err=%v", count, err)
			}
			if err := c.Write([]byte("\x1b[2;3H" + overwrite)); err != nil {
				t.Fatal(err)
			}
			if count, err := c.call("tessera_sixel_image_count", c.handle); err != nil || count != 0 {
				t.Fatalf("overwritten image count=%d err=%v", count, err)
			}
		})
	}
}

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
	if !bytes.HasPrefix(snapshot, []byte("TSS6")) {
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

func BenchmarkCoreSmallWritesWithRetainedImage(b *testing.B) {
	for _, lines := range []int{0, 1000, 10000} {
		b.Run(fmt.Sprintf("history_%d", lines), func(b *testing.B) {
			c, err := New(80, 24)
			if err != nil {
				b.Fatal(err)
			}
			defer c.Close()
			line := append(bytes.Repeat([]byte("x"), 79), '\r', '\n')
			history := bytes.Repeat(line, lines)
			if err := c.Write(history); err != nil {
				b.Fatal(err)
			}
			// Retain a tiny image in history while rewriting a different row.
			if err := c.Write([]byte("\x1b[H\x1bPq\"1;1;8;6#1;2;100;0;0!8~\x1b\\\x1b[24;1H\r\n\r\n")); err != nil {
				b.Fatal(err)
			}
			if count, err := c.call("tessera_sixel_image_count", c.handle); err != nil || count != 1 {
				b.Fatalf("retained image count=%d err=%v", count, err)
			}
			data := []byte("\rtick")
			b.SetBytes(int64(len(data)))
			b.ResetTimer()
			for range b.N {
				if err := c.Write(data); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// The host's core answers Kitty graphics commands for the program, decodes
// PNG, refuses to read files, and keeps images in its snapshots.
func TestNativeCoreKittyGraphics(t *testing.T) {
	c, err := New(20, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	png, err := os.ReadFile("testdata/kitty-2x3.png")
	if err != nil {
		t.Fatal(err)
	}
	commands := "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\" +
		"\x1b_Ga=T,i=2,f=100;" + base64.StdEncoding.EncodeToString(png) + "\x1b\\" +
		"\x1b_Ga=t,i=3,t=f,f=24,s=1,v=1;" + base64.StdEncoding.EncodeToString([]byte("/etc/passwd")) + "\x1b\\"
	if err := c.Write([]byte(commands)); err != nil {
		t.Fatal(err)
	}
	reply, err := c.Replies()
	if err != nil {
		t.Fatal(err)
	}
	if want := "\x1b_Gi=31;OK\x1b\\\x1b_Gi=2;OK\x1b\\\x1b_Gi=3;EINVAL: invalid data\x1b\\"; string(reply) != want {
		t.Fatalf("reply %q, want %q", reply, want)
	}
	snapshot, err := c.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	// The decoded 2x3 RGBA image travels with the screen.
	if len(snapshot) < 24 || !bytes.Contains(snapshot, bytes.Repeat([]byte{0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff}, 1)) {
		t.Fatal("snapshot lacks the decoded image")
	}
}
