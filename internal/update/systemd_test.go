package update

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestDetectSystemdServiceUsesInstallerMarker(t *testing.T) {
	getenv := func(name string) string {
		if name == systemdServiceEnvironment {
			return installerSystemdService
		}
		return ""
	}
	if got := detectSystemdService("linux", getenv, ""); got != installerSystemdService {
		t.Fatalf("service = %q, want %q", got, installerSystemdService)
	}
	if got := detectSystemdService("windows", getenv, "0::/system.slice/tessera.service"); got != "" {
		t.Fatalf("non-Linux service = %q, want empty", got)
	}
}

func TestDetectSystemdServiceRecognizesLegacyInstallerCgroupOnly(t *testing.T) {
	emptyEnvironment := func(string) string { return "" }
	for _, cgroup := range []string{
		"0::/system.slice/tessera.service\n",
		"1:name=systemd:/system.slice/tessera.service\n",
	} {
		if got := detectSystemdService("linux", emptyEnvironment, cgroup); got != installerSystemdService {
			t.Errorf("service for %q = %q", cgroup, got)
		}
	}
	for _, cgroup := range []string{
		"0::/user.slice/user-1000.slice/session-2.scope\n",
		"0::/system.slice/not-tessera.service\n",
		"",
	} {
		if got := detectSystemdService("linux", emptyEnvironment, cgroup); got != "" {
			t.Errorf("unrelated cgroup %q detected as %q", cgroup, got)
		}
	}
}

func TestSystemdUpdateCommandQuotesExecutableAndRequestsTransientUnit(t *testing.T) {
	got := systemdUpdateCommand("/opt/Tessera's bin/tessera")
	want := `sudo systemd-run --quiet --collect --wait --pipe '/opt/Tessera'"'"'s bin/tessera' -systemd-update`
	if got != want {
		t.Fatalf("command = %q, want %q", got, want)
	}
}

func TestServiceManagedUpdaterDescribesInteractiveModeAndRejectsDirectApply(t *testing.T) {
	u := &Updater{exePath: "/usr/local/bin/tessera", serviceName: installerSystemdService}
	result := u.addUpdateMode(&CheckResult{UpdateAvailable: true})
	if result.UpdateMode != "systemd" || result.UpdateCommand == "" {
		t.Fatalf("mode = %q, command = %q", result.UpdateMode, result.UpdateCommand)
	}
	if _, err := u.Apply(context.Background()); err == nil {
		t.Fatal("service-managed updater accepted an ordinary Apply")
	}
}

func TestApplySystemdServiceUpdateRequiresRoot(t *testing.T) {
	called := false
	err := applySystemdServiceUpdate(context.Background(), 1000, func(context.Context) (*CheckResult, error) {
		called = true
		return nil, nil
	}, nil)
	if err == nil || called {
		t.Fatalf("error = %v, apply called = %v", err, called)
	}
}

func TestApplySystemdServiceUpdateRestartsAndVerifies(t *testing.T) {
	var calls [][]string
	err := applySystemdServiceUpdate(context.Background(), 0, func(context.Context) (*CheckResult, error) {
		return &CheckResult{UpdateAvailable: true}, nil
	}, func(_ context.Context, args ...string) error {
		calls = append(calls, append([]string(nil), args...))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"restart", installerSystemdService}, {"is-active", "--quiet", installerSystemdService}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("systemctl calls = %#v, want %#v", calls, want)
	}
}

func TestApplySystemdServiceUpdateSkipsRestartWhenCurrent(t *testing.T) {
	err := applySystemdServiceUpdate(context.Background(), 0, func(context.Context) (*CheckResult, error) {
		return &CheckResult{UpdateAvailable: false}, nil
	}, func(context.Context, ...string) error {
		return errors.New("must not run")
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestApplySystemdServiceUpdateReportsRestartFailure(t *testing.T) {
	err := applySystemdServiceUpdate(context.Background(), 0, func(context.Context) (*CheckResult, error) {
		return &CheckResult{UpdateAvailable: true}, nil
	}, func(context.Context, ...string) error {
		return errors.New("unit failed")
	})
	if err == nil {
		t.Fatal("expected restart error")
	}
}
