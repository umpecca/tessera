//go:build !windows

package main

import (
	"golang.org/x/sys/unix"
	"os"
	"time"
)

func prepareOutput(_ *os.File) (func(), error) { return func() {}, nil }

func readTerminalInput(input *os.File, wait time.Duration) ([]byte, error) {
	poll := []unix.PollFd{{Fd: int32(input.Fd()), Events: unix.POLLIN}}
	n, err := unix.Poll(poll, max(1, int(wait.Milliseconds())))
	if err == unix.EINTR {
		return nil, nil
	}
	if err != nil || n == 0 {
		return nil, err
	}
	var data [4096]byte
	count, err := input.Read(data[:])
	return data[:count], err
}
