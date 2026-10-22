//go:build !unix && !windows

package hostclipboard

import "context"

func detect() Status {
	return Status{Session: SessionHeadless, Reason: "This platform has no host clipboard support."}
}

func writeImage(context.Context, Image) error {
	return ErrUnavailable
}
