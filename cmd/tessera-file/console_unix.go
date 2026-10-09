//go:build !windows

package main

import "os"

func openConsole() (*os.File, *os.File, error) {
	input, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}
	output, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0)
	if err != nil {
		input.Close()
		return nil, nil, err
	}
	return input, output, nil
}
