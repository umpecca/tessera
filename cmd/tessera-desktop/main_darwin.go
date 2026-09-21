//go:build darwin && desktop && cgo

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"tessera/internal/nativeapp"
)

func init() {
	// AppKit must run on the process's original thread.
	runtime.LockOSThread()
}

func main() {
	if len(os.Args) > 1 {
		nativeapp.ShowError("Tessera Desktop does not accept server command-line flags.")
		return
	}
	profile, err := nativeapp.ProfileDir()
	if err != nil {
		nativeapp.ShowError(err.Error())
		return
	}
	if err = os.MkdirAll(profile, 0700); err != nil {
		nativeapp.ShowError(err.Error())
		return
	}
	lock, err := os.OpenFile(filepath.Join(profile, "instance.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		nativeapp.ShowError(err.Error())
		return
	}
	defer lock.Close()
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if err == unix.EWOULDBLOCK {
			nativeapp.FocusExisting()
		} else {
			nativeapp.ShowError(fmt.Sprintf("Lock desktop profile: %v", err))
		}
		return
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	if home, err := os.UserHomeDir(); err == nil {
		if err := os.Chdir(home); err != nil {
			nativeapp.ShowError(err.Error())
			return
		}
	}
	// Finder doesn't inherit a terminal's PATH. Ask the user's login shell, with
	// a deadline so a broken shell startup file cannot indefinitely hide the app.
	shell := os.Getenv("SHELL")
	if !filepath.IsAbs(shell) {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	path, pathErr := exec.CommandContext(ctx, shell, "-lc", `printf '%s' "$PATH"`).Output()
	cancel()
	if pathErr == nil && len(path) > 0 && !strings.ContainsAny(string(path), "\r\n") {
		_ = os.Setenv("PATH", string(path))
	} else {
		_ = os.Setenv("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
	}
	host, err := nativeapp.Start(context.Background(), profile)
	if err != nil {
		nativeapp.ShowError(err.Error())
		return
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		select {
		case <-stop:
			nativeapp.RequestClose("")
		case err := <-host.Server.ServeErr():
			nativeapp.RequestClose(fmt.Sprintf("The local host stopped: %v", err))
		case <-done:
		}
	}()
	nativeapp.Run(host.Server.URL, host.Token)
	close(done)
	signal.Stop(stop)
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := host.Server.Shutdown(shutdown); err != nil {
		log.Printf("desktop shutdown: %v", err)
	}
}
