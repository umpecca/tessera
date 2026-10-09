package terminal

import (
	"runtime"
	"testing"
)

func TestShortcutShellUsesConfiguredHostShell(t *testing.T) {
	t.Setenv("TESSERA_TERMINAL_SHELL", "")
	t.Setenv("SHELL", "")
	want := "posix"
	if runtime.GOOS == "windows" {
		want = "powershell"
	}
	if got := ShortcutShell(); got != want {
		t.Fatal("default shell", got)
	}
	cases := map[string]string{"custom-shell": "unsupported", "   ": "unsupported"}
	if runtime.GOOS == "windows" {
		cases[`"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo`] = "powershell"
		cases["powershell.exe -NoLogo"] = "powershell"
		cases["cmd.exe"] = "unsupported"
	} else {
		cases["/bin/bash"] = "posix"
		cases["/usr/bin/fish"] = "posix"
		cases["/bin/csh"] = "unsupported"
	}
	for shell, expected := range cases {
		t.Setenv("TESSERA_TERMINAL_SHELL", shell)
		if got := ShortcutShell(); got != expected {
			t.Errorf("%q: got %s, want %s", shell, got, expected)
		}
	}
}
