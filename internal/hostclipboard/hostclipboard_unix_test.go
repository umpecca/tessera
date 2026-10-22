//go:build unix && !darwin

package hostclipboard

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func stubTools(t *testing.T, installed ...string) {
	t.Helper()
	previous := lookPath
	t.Cleanup(func() { lookPath = previous })
	lookPath = func(name string) (string, error) {
		for _, tool := range installed {
			if tool == name {
				return "/usr/bin/" + name, nil
			}
		}
		return "", exec.ErrNotFound
	}
}

func TestSelectToolPrefersWaylandThenX11(t *testing.T) {
	stubTools(t, "wl-copy", "xclip")
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("DISPLAY", ":0")
	if status := Detect(); !status.Available || status.Backend != "Wayland (wl-copy)" {
		t.Fatalf("Wayland: %+v", status)
	}
	t.Setenv("WAYLAND_DISPLAY", "")
	if status := Detect(); !status.Available || status.Backend != "X11 (xclip)" {
		t.Fatalf("X11: %+v", status)
	}
}

func TestSelectToolNamesTheMissingTool(t *testing.T) {
	stubTools(t)
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("DISPLAY", "")
	status := Detect()
	if status.Available || status.Session != SessionDesktop || !strings.Contains(status.Reason, "wl-copy") {
		t.Fatalf("%+v", status)
	}
}

func TestHeadlessHostHasNoClipboard(t *testing.T) {
	stubTools(t, "wl-copy", "xclip")
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("DISPLAY", "")
	status := Detect()
	if status.Available || status.Session != SessionHeadless {
		t.Fatalf("%+v", status)
	}
	if err := WriteImage(t.Context(), Image{MIME: "image/png", Data: []byte{1}}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("write: %v", err)
	}
}
