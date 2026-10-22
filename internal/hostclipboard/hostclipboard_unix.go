//go:build unix && !darwin

package hostclipboard

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// A clipboard tool, the display variable it needs, and its arguments for
// owning the clipboard selection with one MIME type read from stdin. Both
// tools fork a process that keeps serving the selection after they return.
type clipboardTool struct {
	name, display, backend string
	args                   func(mime string) []string
}

var clipboardTools = []clipboardTool{
	{name: "wl-copy", display: "WAYLAND_DISPLAY", backend: "Wayland (wl-copy)", args: func(mime string) []string {
		return []string{"--type", mime}
	}},
	{name: "xclip", display: "DISPLAY", backend: "X11 (xclip)", args: func(mime string) []string {
		return []string{"-selection", "clipboard", "-t", mime, "-i"}
	}},
}

var lookPath = exec.LookPath

func selectTool() (clipboardTool, string, Status) {
	status := Status{Session: SessionHeadless}
	var missing []string
	for _, tool := range clipboardTools {
		if os.Getenv(tool.display) == "" {
			continue
		}
		status.Session = SessionDesktop
		path, err := lookPath(tool.name)
		if err != nil {
			missing = append(missing, tool.name)
			continue
		}
		status.Available = true
		status.Backend = tool.backend
		return tool, path, status
	}
	if status.Session == SessionDesktop {
		status.Reason = fmt.Sprintf("Install %s so Tessera can use the desktop clipboard.", strings.Join(missing, " or "))
	} else {
		status.Reason = "Tessera is not running in a graphical session (neither WAYLAND_DISPLAY nor DISPLAY is set), so this host has no clipboard to share."
	}
	return clipboardTool{}, "", status
}

func detect() Status {
	_, _, status := selectTool()
	return status
}

func writeImage(ctx context.Context, img Image) error {
	tool, path, status := selectTool()
	if !status.Available {
		return fmt.Errorf("%w: %s", ErrUnavailable, status.Reason)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, tool.args(img.MIME)...)
	cmd.Stdin = bytes.NewReader(img.Data)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	// The child that keeps serving the selection inherits stderr. Stop
	// waiting for it once the tool itself has exited.
	cmd.WaitDelay = 250 * time.Millisecond
	if err := cmd.Run(); err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return fmt.Errorf("%s: %s", tool.name, message)
		}
		return fmt.Errorf("%s: %w", tool.name, err)
	}
	return nil
}
