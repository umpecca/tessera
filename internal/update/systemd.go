package update

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
)

const (
	systemdServiceEnvironment = "TESSERA_SYSTEMD_SERVICE"
	installerSystemdService   = "tessera.service"
)

// DetectSystemdService recognizes both newly installed units, which carry an
// explicit marker, and older installer units through systemd's invocation ID.
// Only Tessera's fixed installer unit is accepted.
func DetectSystemdService() string {
	cgroup, _ := os.ReadFile("/proc/self/cgroup")
	return detectSystemdService(runtime.GOOS, os.Getenv, string(cgroup))
}

func detectSystemdService(goos string, getenv func(string) string, cgroup string) string {
	if goos != "linux" {
		return ""
	}
	if strings.TrimSpace(getenv(systemdServiceEnvironment)) == installerSystemdService {
		return installerSystemdService
	}
	// Installer units predating the explicit marker still identify themselves
	// in cgroup v1/v2 paths such as /system.slice/tessera.service.
	for _, line := range strings.Split(cgroup, "\n") {
		path := line
		if separator := strings.LastIndexByte(line, ':'); separator >= 0 {
			path = line[separator+1:]
		}
		if strings.HasSuffix(strings.TrimSpace(path), "/"+installerSystemdService) {
			return installerSystemdService
		}
	}
	if strings.TrimSpace(cgroup) == installerSystemdService {
		return installerSystemdService
	}
	return ""
}

func systemdUpdateCommand(exePath string) string {
	quotedPath := "'" + strings.ReplaceAll(exePath, "'", `'"'"'`) + "'"
	return "sudo systemd-run --quiet --collect --wait --pipe " + quotedPath + " -systemd-update"
}

type systemdApplyFunc func(context.Context) (*CheckResult, error)
type systemctlFunc func(context.Context, ...string) error

func applySystemdServiceUpdate(ctx context.Context, effectiveUID int, apply systemdApplyFunc, systemctl systemctlFunc) error {
	if effectiveUID != 0 {
		return errors.New("systemd update must run as root (use the in-app sudo command)")
	}
	result, err := apply(ctx)
	if err != nil {
		return err
	}
	if !result.UpdateAvailable {
		return nil
	}
	if err := systemctl(ctx, "restart", installerSystemdService); err != nil {
		return fmt.Errorf("restart %s: %w", installerSystemdService, err)
	}
	if err := systemctl(ctx, "is-active", "--quiet", installerSystemdService); err != nil {
		return fmt.Errorf("verify %s: %w", installerSystemdService, err)
	}
	return nil
}
