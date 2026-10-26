package terminalcore

import (
	"reflect"
	"slices"
	"testing"
)

func TestScreenText(t *testing.T) {
	c, err := New(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Write([]byte("\x1b[31mred\x1b[0m text   \r\n界 wide\r\nnaïve é\r\n")); err != nil {
		t.Fatal(err)
	}
	lines, err := c.ScreenText()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"red text", "界 wide", "naïve é", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines=%q want %q", lines, want)
	}
}

func TestScreenTextAfterScrollAndResize(t *testing.T) {
	c, err := New(10, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Write([]byte("one\r\ntwo\r\nthree")); err != nil {
		t.Fatal(err)
	}
	if lines, err := c.ScreenText(); err != nil || !reflect.DeepEqual(lines, []string{"two", "three"}) {
		t.Fatalf("lines=%q err=%v", lines, err)
	}
	if err := c.Resize(12, 3, 8, 16); err != nil {
		t.Fatal(err)
	}
	// Growing keeps the cursor's row, so "three" stays where it was.
	if lines, err := c.ScreenText(); err != nil || !slices.Contains(lines, "three") || len(lines) != 3 {
		t.Fatalf("lines=%q err=%v", lines, err)
	}
}

func TestWorkingDirectory(t *testing.T) {
	c, err := New(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if dir, err := c.WorkingDirectory(); err != nil || dir != "" {
		t.Fatalf("dir=%q err=%v", dir, err)
	}
	if err := c.Write([]byte("\x1b]7;file://studio/Users/me/src\x07")); err != nil {
		t.Fatal(err)
	}
	if dir, err := c.WorkingDirectory(); err != nil || dir != "file://studio/Users/me/src" {
		t.Fatalf("dir=%q err=%v", dir, err)
	}
}

func TestAtPrompt(t *testing.T) {
	c, err := New(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if at, err := c.AtPrompt(); err != nil || at {
		t.Fatalf("unmarked at=%v err=%v", at, err)
	}
	if err := c.Write([]byte("\x1b]133;A\x07$ \x1b]133;B\x07")); err != nil {
		t.Fatal(err)
	}
	if at, err := c.AtPrompt(); err != nil || !at {
		t.Fatalf("prompt at=%v err=%v", at, err)
	}
	if err := c.Write([]byte("make\r\n\x1b]133;C\x07building\r\n")); err != nil {
		t.Fatal(err)
	}
	if at, err := c.AtPrompt(); err != nil || at {
		t.Fatalf("output at=%v err=%v", at, err)
	}
	// Past the bottom of the screen the row is counted through scrollback.
	if err := c.Write([]byte("1\r\n2\r\n3\r\n4\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ ")); err != nil {
		t.Fatal(err)
	}
	if at, err := c.AtPrompt(); err != nil || !at {
		t.Fatalf("prompt after scrolling at=%v err=%v", at, err)
	}
}
