//go:build !windows

package terminal

import (
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A real shell started with the integration marks its prompt and the
// command it runs, and reports its directory.
func TestShellIntegrationMarksPromptsAndCommands(t *testing.T) {
	if testing.Short() {
		t.Skip("uses real shells in a local PTY")
	}
	for _, shell := range []string{"zsh", "bash"} {
		t.Run(shell, func(t *testing.T) {
			path, err := exec.LookPath(shell)
			if err != nil {
				t.Skipf("no %s", shell)
			}
			if shell == "bash" && !bashHasPS0(path) {
				t.Skip("bash older than 4.4")
			}
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("ZDOTDIR", "")
			os.Unsetenv("ZDOTDIR")
			t.Setenv("TESSERA_TERMINAL_SHELL", path)
			session, err := Start(home, Launch{TERM: "xterm-256color", ShellIntegration: true}, 80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			output := make(chan string, 1)
			go func() {
				data, _ := io.ReadAll(session)
				output <- string(data)
			}()
			time.Sleep(500 * time.Millisecond)
			if _, err := session.Write([]byte("echo marked; false\r")); err != nil {
				t.Fatal(err)
			}
			time.Sleep(500 * time.Millisecond)
			// A command line cut short says so, so nobody runs the part of it
			// that was reported as though it were the whole.
			if _, err := session.Write([]byte("echo two \\\rlines\r")); err != nil {
				t.Fatal(err)
			}
			time.Sleep(500 * time.Millisecond)
			if _, err := session.Write([]byte(": " + strings.Repeat("x", 250) + "\r")); err != nil {
				t.Fatal(err)
			}
			time.Sleep(500 * time.Millisecond)
			if _, err := session.Write([]byte("exit\r")); err != nil {
				t.Fatal(err)
			}
			var text string
			select {
			case text = <-output:
			case <-time.After(10 * time.Second):
				t.Fatal("shell did not exit")
			}
			for _, want := range []string{
				"\x1b]7;file://",
				"\x1b]133;A\x1b\\",
				"\x1b]133;B\x1b\\",
				"\x1b]133;C;cmdline_url=echo%20marked%3B%20false\x1b\\",
				"\x1b]133;C;cmdline_url=echo%20two%20%5C%E2%80%A6\x1b\\",
				"\x1b]133;C;cmdline_url=%3A%20" + strings.Repeat("x", 198) + "%E2%80%A6\x1b\\",
				"marked",
				"\x1b]133;D;1\x1b\\",
			} {
				if !strings.Contains(text, want) {
					t.Errorf("no %q in %q", want, text)
				}
			}
		})
	}
}

func bashHasPS0(path string) bool {
	out, err := exec.Command(path, "-c", `echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"`).Output()
	if err != nil {
		return false
	}
	fields := strings.Fields(string(out))
	if len(fields) != 2 {
		return false
	}
	major, _ := strconv.Atoi(fields[0])
	minor, _ := strconv.Atoi(fields[1])
	return major > 4 || (major == 4 && minor >= 4)
}

func TestShellStartsUntouchedWithIntegrationOff(t *testing.T) {
	if testing.Short() {
		t.Skip("uses a real shell in a local PTY")
	}
	path, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("no zsh")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("TESSERA_TERMINAL_SHELL", path)
	session, err := Start("", Launch{TERM: "xterm-256color"}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if _, err := session.Write([]byte("echo zdotdir=${ZDOTDIR-unset}; exit\r")); err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(session)
	text := string(data)
	if strings.Contains(text, "\x1b]133;") || !strings.Contains(text, "zdotdir=unset") {
		t.Fatalf("output = %q", text)
	}
}
