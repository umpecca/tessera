//go:build windows

package update

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("TESSERA_RESTART_TEST_HELPER") == "1" {
		if err := os.WriteFile(os.Getenv("TESSERA_RESTART_TEST_OUTPUT"), []byte("started"), 0o600); err != nil {
			os.Exit(2)
		}
		if err := SignalReplacementReady(); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestSpawnReplacementStartsReleasedChild(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "replacement-output")
	t.Setenv("TESSERA_RESTART_TEST_HELPER", "1")
	t.Setenv("TESSERA_RESTART_TEST_OUTPUT", outputPath)
	u := &Updater{exePath: os.Args[0]}
	if err := u.spawnReplacement(5 * time.Second); err != nil {
		t.Fatalf("spawn replacement: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		if output, err := os.ReadFile(outputPath); err == nil {
			if string(output) != "started" {
				t.Fatalf("replacement output = %q, want started", output)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("released replacement did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
