package desktop

import (
	"runtime"
	"testing"
)

func TestTraySupportedMatchesPlatform(t *testing.T) {
	want := runtime.GOOS == "windows" || runtime.GOOS == "darwin"
	if got := TraySupported(); got != want {
		t.Fatalf("TraySupported() = %v, want %v on %s", got, want, runtime.GOOS)
	}
}
