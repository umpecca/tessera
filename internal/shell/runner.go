package shell

import (
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
			streamStdout(ctx, events, req.RunID, stdout, func(nextCwd string) {
				mu.Lock()
				cwdAfter = nextCwd
				mu.Unlock()
			}, func(exitCode int) {
				mu.Lock()
				markerExitCode = exitCode
				mu.Unlock()
			})
		}()
		go func() {
			defer wg.Done()
			streamRawOutput(ctx, events, req.RunID, "stderr", stderr)
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

func streamStdout(ctx context.Context, events chan<- Event, runID string, reader io.Reader, setCwd func(string), setExitCode func(int)) {
	buf := make([]byte, 4096)
	pending := ""

	for {
		n, err := reader.Read(buf)
		if n > 0 {
			pending += string(buf[:n])
			pending = flushStdoutPending(ctx, events, runID, pending, false, setCwd, setExitCode)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				send(ctx, events, Event{Type: "error", RunID: runID, Error: err.Error()})
			}
			break
		}
	}

	flushStdoutPending(ctx, events, runID, pending, true, setCwd, setExitCode)
}

func flushStdoutPending(ctx context.Context, events chan<- Event, runID, pending string, final bool, setCwd func(string), setExitCode func(int)) string {
	for {
		newline := strings.IndexByte(pending, '\n')
		if newline < 0 {
			break
		}
		line := pending[:newline+1]
		pending = pending[newline+1:]
		handleStdoutLine(ctx, events, runID, line, setCwd, setExitCode)
	}

	if pending == "" {
		return ""
	}
	if final {
		handleStdoutLine(ctx, events, runID, pending, setCwd, setExitCode)
		return ""
	}
	if possibleMarkerText(pending) {
		return pending
	}
	send(ctx, events, Event{Type: "stdout", RunID: runID, Text: pending})
	return ""
}

func handleStdoutLine(ctx context.Context, events chan<- Event, runID, text string, setCwd func(string), setExitCode func(int)) {
	line := strings.TrimRight(text, "\r\n")
	if strings.HasPrefix(line, cwdMarker) {
		setCwd(strings.TrimSpace(strings.TrimPrefix(line, cwdMarker)))
		return
	}
	if strings.HasPrefix(line, exitMarker) {
		if parsed, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, exitMarker))); err == nil {
			setExitCode(parsed)
		}
		return
	}
	send(ctx, events, Event{Type: "stdout", RunID: runID, Text: text})
}

func possibleMarkerText(text string) bool {
	return strings.HasPrefix(cwdMarker, text) ||
		strings.HasPrefix(exitMarker, text) ||
		strings.HasPrefix(text, cwdMarker) ||
		strings.HasPrefix(text, exitMarker)
}

func streamRawOutput(ctx context.Context, events chan<- Event, runID, eventType string, reader io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			send(ctx, events, Event{Type: eventType, RunID: runID, Text: string(buf[:n])})
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				send(ctx, events, Event{Type: "error", RunID: runID, Error: err.Error()})
			}
			return
		}
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
