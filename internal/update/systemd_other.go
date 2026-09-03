//go:build !linux

package update

import (
	"context"
	"errors"
)

func RunSystemdServiceUpdate(context.Context, string) error {
	return errors.New("systemd service update is available only on Linux")
}
