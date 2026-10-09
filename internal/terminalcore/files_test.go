package terminalcore

import (
	"strings"
	"tessera/internal/terminalfile"
	"testing"
)

func TestFileOSCAllSplitPointsAndCancellation(t *testing.T) {
	c, err := New(20, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, end := range []string{terminalfile.Terminator, "\a"} {
		sequence := terminalfile.Prefix + "upload;id;" + terminalfile.Encode(map[string]string{"directory": t.TempDir()}) + end
		for split := 0; split <= len(sequence); split++ {
			_ = c.Write([]byte(sequence[:split]))
			first, err := c.Files()
			if err != nil || (split < len(sequence) && len(first) != 0) {
				t.Fatalf("early effect %d", split)
			}
			_ = c.Write([]byte(sequence[split:]))
			last, err := c.Files()
			all := append(first, last...)
			if err != nil || len(all) != 1 || all[0].ID != "id" || all[0].Error != "" {
				t.Fatalf("split %d: %+v %v", split, all, err)
			}
		}
	}
	for _, sequence := range []string{terminalfile.Prefix + "query;x\x18", terminalfile.Prefix + "query;x\x1a", terminalfile.Prefix + "query;x\x1b[H", "\x1b]777;other;1;query;x\a", "\x1b]777;tessera-file;2;query;x\a"} {
		_ = c.Write([]byte(sequence))
		commands, err := c.Files()
		if err != nil || len(commands) != 0 {
			t.Fatalf("cancelled sequence emitted %+v", commands)
		}
	}
	_ = c.Write([]byte(terminalfile.Prefix + "upload;x;!\a"))
	commands, _ := c.Files()
	if len(commands) != 1 || commands[0].Error == "" {
		t.Fatal("malformed request was accepted")
	}
	_ = c.Write([]byte(terminalfile.Prefix + "download;x;" + strings.Repeat("A", 1024*1024+128) + "\a"))
	commands, _ = c.Files()
	if len(commands) != 0 {
		t.Fatal("oversized request produced a file effect")
	}
	_ = c.Write([]byte(strings.Repeat(terminalfile.Prefix+"query;x\a", 100)))
	commands, _ = c.Files()
	if len(commands) > 8 || commands[0].Action != "reset" {
		t.Fatal("effects unbounded")
	}
	_ = c.Write([]byte("\x1bc"))
	commands, _ = c.Files()
	if len(commands) != 1 || commands[0].Action != "reset" {
		t.Fatal("reset lost")
	}
	_ = c.Write([]byte("\x1b[H\x1b[6n"))
	reply, _ := c.Replies()
	if string(reply) != "\x1b[1;1R" {
		t.Fatalf("ordinary parser broken %q", reply)
	}
}
