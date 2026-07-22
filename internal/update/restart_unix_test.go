//go:build !windows

package update

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSpawnReplacementExecsWithArgumentsEnvironmentAndWorkingDirectory(t *testing.T) {
	if os.Getenv("TESSERA_RESTART_TEST_HELPER") == "1" {
		u := &Updater{exePath: os.Getenv("TESSERA_RESTART_TEST_EXECUTABLE")}
		if err := u.SpawnReplacement(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(3) // An in-place exec must never return on success.
	}

	dir := t.TempDir()
	workDir := filepath.Join(dir, "working-directory")
	if err := os.Mkdir(workDir, 0o755); err != nil {
		t.Fatalf("create working directory: %v", err)
	}
	outputPath := filepath.Join(dir, "replacement-output")
	replacementPath := filepath.Join(dir, "replacement.sh")
	script := `#!/bin/sh
{
  printf 'argument=%s\n' "$1"
  printf 'marker=%s\n' "$TESSERA_RESTART_TEST_MARKER"
  printf 'working_directory=%s\n' "$(pwd)"
} > "$TESSERA_RESTART_TEST_OUTPUT"
`
	if err := os.WriteFile(replacementPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write replacement: %v", err)
	}

	const runArgument = "-test.run=^TestSpawnReplacementExecsWithArgumentsEnvironmentAndWorkingDirectory$"
	cmd := exec.Command(os.Args[0], runArgument)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(),
		"TESSERA_RESTART_TEST_HELPER=1",
		"TESSERA_RESTART_TEST_EXECUTABLE="+replacementPath,
		"TESSERA_RESTART_TEST_OUTPUT="+outputPath,
		"TESSERA_RESTART_TEST_MARKER=preserved",
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("run restart helper: %v\n%s", err, output)
	}

	output, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read replacement output: %v", err)
	}
	resolvedWorkDir, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		t.Fatalf("resolve working directory: %v", err)
	}
	wantLines := []string{
		"argument=" + runArgument,
		"marker=preserved",
		"working_directory=" + resolvedWorkDir,
	}
	for _, want := range wantLines {
		if !strings.Contains(string(output), want+"\n") {
			t.Errorf("replacement output %q does not contain %q", output, want)
		}
	}
}

func TestSpawnReplacementReturnsExecError(t *testing.T) {
	u := &Updater{exePath: filepath.Join(t.TempDir(), "missing-tessera")}
	if err := u.SpawnReplacement(); err == nil {
		t.Fatal("SpawnReplacement returned nil for a missing executable")
	}
}
