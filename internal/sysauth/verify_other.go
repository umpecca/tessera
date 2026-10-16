//go:build !linux && !darwin && !windows

package sysauth

import "context"

func verify(context.Context, string, []byte) error {
	return ErrUnavailable
}
