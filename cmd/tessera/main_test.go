package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"tessera/internal/update"
)

func TestStringListFlagAcceptsRepeatedAndCommaSeparatedValues(t *testing.T) {
	var values stringListFlag
	if err := values.Set("127.0.0.1, 10.0.0.0/8"); err != nil {
		t.Fatalf("set comma-separated values: %v", err)
	}
	if err := values.Set("192.168.0.0/16"); err != nil {
		t.Fatalf("set repeated value: %v", err)
	}
	want := stringListFlag{"127.0.0.1", "10.0.0.0/8", "192.168.0.0/16"}
	if !reflect.DeepEqual(values, want) {
		t.Fatalf("values = %v, want %v", values, want)
	}
	if got := values.String(); got != "127.0.0.1,10.0.0.0/8,192.168.0.0/16" {
		t.Fatalf("String() = %q", got)
	}
}

func TestRestartUpdatedServerDoesNotWaitForTrayShutdown(t *testing.T) {
	var steps []string
	err := restartUpdatedServer(
		func(context.Context) error {
			steps = append(steps, "stop")
			return nil
		},
		func(context.Context) error {
			steps = append(steps, "restore")
			return nil
		},
		func() error {
			steps = append(steps, "spawn")
			return nil
		},
	)
	if err != nil {
		t.Fatalf("restartUpdatedServer: %v", err)
	}
	if want := []string{"stop", "spawn"}; !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps = %v, want %v", steps, want)
	}
}

func TestRestartUpdatedServerRestoresCurrentServerAfterLaunchFailure(t *testing.T) {
	var steps []string
	err := restartUpdatedServer(
		func(context.Context) error {
			steps = append(steps, "stop")
			return nil
		},
		func(context.Context) error {
			steps = append(steps, "restore")
			return nil
		},
		func() error {
			steps = append(steps, "spawn")
			return errors.New("replacement failed")
		},
	)
	if err == nil || err.Error() != "start replacement: replacement failed; current server restored" {
		t.Fatalf("error = %v", err)
	}
	if want := []string{"stop", "spawn", "restore"}; !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps = %v, want %v", steps, want)
	}
}

func TestRestartUpdatedServerDoesNotLaunchBeforeSuccessfulStop(t *testing.T) {
	var steps []string
	err := restartUpdatedServer(
		func(context.Context) error {
			steps = append(steps, "stop")
			return errors.New("shutdown timed out")
		},
		func(context.Context) error {
			steps = append(steps, "restore")
			return nil
		},
		func() error {
			steps = append(steps, "spawn")
			return nil
		},
	)
	if err == nil || err.Error() != "stop current server: shutdown timed out; current server restored" {
		t.Fatalf("error = %v", err)
	}
	if want := []string{"stop", "restore"}; !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps = %v, want %v", steps, want)
	}
}

type fakeTrayUpdater struct {
	result   *update.CheckResult
	err      error
	restarts int
}

func (f *fakeTrayUpdater) Apply(context.Context) (*update.CheckResult, error) {
	return f.result, f.err
}

func (f *fakeTrayUpdater) RequestRestart() {
	f.restarts++
}

func TestTrayUpdateActionRequestsRestartAfterInstallation(t *testing.T) {
	updater := &fakeTrayUpdater{result: &update.CheckResult{UpdateAvailable: true}}
	restarting, err := newTrayUpdateAction(updater)(context.Background())
	if err != nil {
		t.Fatalf("tray update: %v", err)
	}
	if !restarting || updater.restarts != 1 {
		t.Fatalf("restarting = %v, restart requests = %d", restarting, updater.restarts)
	}
}

func TestTrayUpdateActionLeavesUpToDateServerRunning(t *testing.T) {
	updater := &fakeTrayUpdater{result: &update.CheckResult{UpdateAvailable: false}}
	restarting, err := newTrayUpdateAction(updater)(context.Background())
	if err != nil {
		t.Fatalf("tray update: %v", err)
	}
	if restarting || updater.restarts != 0 {
		t.Fatalf("restarting = %v, restart requests = %d", restarting, updater.restarts)
	}
}

func TestTrayUpdateActionReturnsApplyFailure(t *testing.T) {
	updater := &fakeTrayUpdater{err: errors.New("download failed")}
	restarting, err := newTrayUpdateAction(updater)(context.Background())
	if err == nil || err.Error() != "download failed" {
		t.Fatalf("error = %v", err)
	}
	if restarting || updater.restarts != 0 {
		t.Fatalf("restarting = %v, restart requests = %d", restarting, updater.restarts)
	}
}
