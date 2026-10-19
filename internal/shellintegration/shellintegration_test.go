package shellintegration

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestInstallWritesTheScriptsOnceByContent(t *testing.T) {
	base := t.TempDir()
	root, err := install(base)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(root) != base || len(filepath.Base(root)) != 16 {
		t.Fatalf("root = %s", root)
	}
	for _, name := range []string{"zsh/.zshenv", "zsh/tessera-integration.zsh", "bash/tessera.bash"} {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil || info.Mode().Perm() != 0o644 {
			t.Fatalf("%s: %v %v", name, info, err)
		}
	}
	// A file changed on disk is put back; the same contents give the same folder.
	if err := os.WriteFile(filepath.Join(root, "bash", "tessera.bash"), []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	again, err := install(base)
	if err != nil || again != root {
		t.Fatalf("again = %s, %v", again, err)
	}
	data, _ := os.ReadFile(filepath.Join(root, "bash", "tessera.bash"))
	want, _ := scripts.ReadFile("scripts/bash/tessera.bash")
	if string(data) != string(want) {
		t.Fatal("changed script not restored")
	}
	entries, _ := os.ReadDir(filepath.Join(root, "bash"))
	if len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
}

func TestConfigurePointsZshAndBashAtTheScripts(t *testing.T) {
	root := "/cache/integration"
	env := []string{"HOME=/home/me", "ZDOTDIR=/home/me/.config/zsh", "TESSERA_ZSH_ZDOTDIR=stale"}
	args, got := Configure("/bin/zsh", nil, env, root)
	if args != nil || !reflect.DeepEqual(got, []string{"HOME=/home/me", "TESSERA_ZSH_ZDOTDIR=/home/me/.config/zsh", "ZDOTDIR=/cache/integration/zsh"}) {
		t.Fatalf("zsh = %v %v", args, got)
	}
	if env[1] != "ZDOTDIR=/home/me/.config/zsh" {
		t.Fatal("env modified")
	}
	_, got = Configure("-zsh", nil, []string{"HOME=/home/me"}, root)
	if !reflect.DeepEqual(got, []string{"HOME=/home/me", "ZDOTDIR=/cache/integration/zsh"}) {
		t.Fatalf("zsh without ZDOTDIR = %v", got)
	}
	args, got = Configure("/usr/local/bin/bash", []string{"-i"}, env, root)
	if !reflect.DeepEqual(args, []string{"--rcfile", "/cache/integration/bash/tessera.bash", "-i"}) || !reflect.DeepEqual(got, env) {
		t.Fatalf("bash = %v %v", args, got)
	}
	for _, shell := range []string{"/usr/bin/fish", "/bin/sh", "/bin/dash"} {
		args, got = Configure(shell, []string{"-l"}, env, root)
		if !reflect.DeepEqual(args, []string{"-l"}) || !reflect.DeepEqual(got, env) {
			t.Fatalf("%s = %v %v", shell, args, got)
		}
	}
}

func TestRootPutsBackScriptsRemovedWhileRunning(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", "")
	root, err := Root()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	again, err := Root()
	if err != nil || again != root {
		t.Fatalf("again = %s, %v", again, err)
	}
	if _, err := os.Stat(filepath.Join(root, "zsh", ".zshenv")); err != nil {
		t.Fatal(err)
	}
}
