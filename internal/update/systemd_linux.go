//go:build linux

package update

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// RunSystemdServiceUpdate applies the release as root, then asks systemd to
// restart the installer-owned service. It is intended to run under a
// transient systemd unit so restarting Tessera cannot kill this helper.
func RunSystemdServiceUpdate(ctx context.Context, repo string) error {
	u, err := New(repo)
	if err != nil {
		return err
	}
	// The transient unit has its own INVOCATION_ID, but it must be allowed to
	// perform the privileged swap rather than being redirected back to the UI.
	u.serviceName = ""
	return applySystemdServiceUpdate(ctx, os.Geteuid(), u.Apply, func(ctx context.Context, args ...string) error {
		command := exec.CommandContext(ctx, "systemctl", args...)
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
		if err := command.Run(); err != nil {
			return fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
		}
		return nil
	})
}
