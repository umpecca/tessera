package hostclipboard

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Writing replaces the real clipboard, so this runs only on request:
// TESSERA_HOST_CLIPBOARD_TEST=1 go test ./internal/hostclipboard
func TestWriteImageReachesTheMacPasteboard(t *testing.T) {
	if os.Getenv("TESSERA_HOST_CLIPBOARD_TEST") != "1" {
		t.Skip("set TESSERA_HOST_CLIPBOARD_TEST=1 to write to the real pasteboard")
	}
	if status := Detect(); !status.Available {
		t.Skipf("no pasteboard: %s", status.Reason)
	}
	img, err := ParseImage(testPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteImage(context.Background(), img); err != nil {
		t.Fatal(err)
	}
	// osascript reads the pasteboard the way other programs do.
	out, err := exec.Command("osascript", "-e", "clipboard info").CombinedOutput()
	if err != nil {
		t.Fatalf("osascript: %v %s", err, out)
	}
	if !strings.Contains(string(out), "PNGf") {
		t.Fatalf("pasteboard holds %q, want PNG", out)
	}
}
