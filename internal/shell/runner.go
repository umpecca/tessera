package shell

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

const (
	cwdMarker  = "__TESSERA_CWD__"
	exitMarker = "__TESSERA_EXIT__"
)

type Runner struct{}

type RunRequest struct {
	RunID   string
	Command string
	Cwd     string
}

type Event struct {
	Type  string `json:"type"`
	RunID string `json:"runId,omitempty"`
	Text  string `json:"text,omitempty"`
	Cwd   string `json:"cwd,omitempty"`
	Code  *int   `json:"code,omitempty"`
	Error string `json:"error,omitempty"`
}

func (r *Runner) Run(ctx context.Context, req RunRequest) <-chan Event {
	events := make(chan Event, 16)
	go func() {
		defer close(events)

		cwd := req.Cwd
		if cwd == "" {
			cwd, _ = os.Getwd()
		}
		if cwd == "" {
			cwd = "."
		}
		if stat, err := os.Stat(cwd); err != nil || !stat.IsDir() {
			send(ctx, events, Event{Type: "error", RunID: req.RunID, Error: fmt.Sprintf("working directory is not available: %s", cwd)})
			code := 1
			send(ctx, events, Event{Type: "exit", RunID: req.RunID, Cwd: cwd, Code: &code})
			return
		}

		if !send(ctx, events, Event{Type: "start", RunID: req.RunID, Cwd: cwd}) {
			return
		}

		cmd := commandForPlatform(ctx, req.Command)
		cmd.Dir = cwd

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			code := 1
			send(ctx, events, Event{Type: "error", RunID: req.RunID, Error: err.Error()})
			send(ctx, events, Event{Type: "exit", RunID: req.RunID, Cwd: cwd, Code: &code})
			return
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			code := 1
			send(ctx, events, Event{Type: "error", RunID: req.RunID, Error: err.Error()})
			send(ctx, events, Event{Type: "exit", RunID: req.RunID, Cwd: cwd, Code: &code})
			return
		}

		if err := cmd.Start(); err != nil {
			code := 1
			send(ctx, events, Event{Type: "error", RunID: req.RunID, Error: err.Error()})
			send(ctx, events, Event{Type: "exit", RunID: req.RunID, Cwd: cwd, Code: &code})
			return
		}

		var wg sync.WaitGroup
		var mu sync.Mutex
		cwdAfter := cwd
		markerExitCode := -1

		wg.Add(2)
		go func() {
			defer wg.Done()
			scanLines(stdout, func(line string) {
				if strings.HasPrefix(line, cwdMarker) {
					mu.Lock()
					cwdAfter = strings.TrimSpace(strings.TrimPrefix(line, cwdMarker))
					mu.Unlock()
					return
				}
				if strings.HasPrefix(line, exitMarker) {
					if parsed, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, exitMarker))); err == nil {
						mu.Lock()
						markerExitCode = parsed
						mu.Unlock()
					}
					return
				}
				send(ctx, events, Event{Type: "stdout", RunID: req.RunID, Text: line + "\n"})
			})
		}()
		go func() {
			defer wg.Done()
			scanLines(stderr, func(line string) {
				send(ctx, events, Event{Type: "stderr", RunID: req.RunID, Text: line + "\n"})
			})
		}()

		waitErr := cmd.Wait()
		wg.Wait()

		mu.Lock()
		exitCode := markerExitCode
		finalCwd := cwdAfter
		mu.Unlock()
		if exitCode < 0 {
			exitCode = exitCodeFromError(waitErr)
		}
		if waitErr != nil && !errors.Is(ctx.Err(), context.Canceled) && exitCode == 0 {
			exitCode = exitCodeFromError(waitErr)
		}
		send(ctx, events, Event{Type: "exit", RunID: req.RunID, Cwd: finalCwd, Code: &exitCode})
	}()
	return events
}

func commandForPlatform(ctx context.Context, command string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		script := command + "\n" +
			"$__tesseraExitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }\n" +
			"Write-Output \"" + cwdMarker + "$((Get-Location).ProviderPath)\"\n" +
			"Write-Output \"" + exitMarker + "$__tesseraExitCode\"\n" +
			"exit $__tesseraExitCode\n"
		return exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	}

	script := command + "\n" +
		"__tessera_exit_code=$?\n" +
		"printf '" + cwdMarker + "%s\\n' \"$PWD\"\n" +
		"printf '" + exitMarker + "%s\\n' \"$__tessera_exit_code\"\n" +
		"exit \"$__tessera_exit_code\"\n"
	return exec.CommandContext(ctx, "/bin/sh", "-c", script)
}

func scanLines(reader io.Reader, onLine func(string)) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		onLine(scanner.Text())
	}
}

func exitCodeFromError(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return 1
}

func send(ctx context.Context, events chan<- Event, event Event) bool {
	select {
	case <-ctx.Done():
		return false
	case events <- event:
		return true
	}
}
