// tessera-file uses the controlling console for OSC and keeps stdout scriptable.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
	"tessera/internal/terminalfile"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "tessera-file:", err)
		os.Exit(1)
	}
}
func id() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func command(args []string) (terminalfile.Command, error) {
	requestID, err := id()
	if err != nil {
		return terminalfile.Command{}, err
	}
	c := terminalfile.Command{ID: requestID}
	if len(args) == 0 {
		return c, errors.New("usage: tessera-file upload [--to DIR] | download PATH... | cancel ID | capabilities")
	}
	switch args[0] {
	case "upload":
		c.Action = "upload"
		directory := "."
		if len(args) != 1 {
			if len(args) != 3 || args[1] != "--to" {
				return c, errors.New("usage: upload [--to DIR]")
			}
			directory = args[2]
		}
		p, err := filepath.Abs(directory)
		c.Directory = p
		return c, err
	case "download":
		c.Action = "download"
		if len(args) < 2 || len(args) > terminalfile.MaxFiles+1 {
			return c, errors.New("download requires 1–64 file paths")
		}
		for _, path := range args[1:] {
			p, err := filepath.Abs(path)
			if err != nil {
				return c, err
			}
			c.Paths = append(c.Paths, p)
		}
	case "cancel":
		if len(args) != 2 || !terminalfile.ValidID(args[1]) {
			return c, errors.New("cancel requires a request ID")
		}
		c.Action = "cancel"
		c.ID = args[1]
	case "capabilities":
		if len(args) != 1 {
			return c, errors.New("capabilities accepts no arguments")
		}
		c.Action = "query"
	default:
		return c, errors.New("unknown command")
	}
	return c, nil
}
func run(ctx context.Context, args []string, output, diagnostics io.Writer) error {
	c, err := command(args)
	if err != nil {
		return err
	}
	if c.Action != "query" && (os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_CLIENT") != "" || os.Getenv("SSH_TTY") != "") {
		return errors.New("v1 transfers require the Tessera host; SSH file transfers are not supported")
	}
	input, console, err := openConsole()
	if err != nil {
		return err
	}
	defer input.Close()
	defer console.Close()
	restoreOutput, err := prepareOutput(console)
	if err != nil {
		return err
	}
	defer restoreOutput()
	state, err := term.MakeRaw(int(input.Fd()))
	if err != nil {
		return err
	}
	restoreInput := func() { _ = term.Restore(int(input.Fd()), state) }
	defer restoreInput()
	nonce, err := id()
	if err != nil {
		return err
	}
	if _, err := io.WriteString(console, terminalfile.Prefix+"query;"+nonce+terminalfile.Terminator); err != nil {
		return err
	}
	reader := replyReader{input: input}
	data, err := reader.wait(ctx, "capabilities", nonce, time.Now().Add(time.Second))
	if err != nil {
		return err
	}
	var caps terminalfile.Capabilities
	if json.Unmarshal(data, &caps) != nil || caps.Version != 1 || caps.Scope != "host-local" {
		return errors.New("unsupported terminal file capabilities")
	}
	if c.Action == "query" {
		restoreInput()
		restoreOutput()
		_, err = fmt.Fprintln(output, string(data))
		return err
	}
	if !strings.EqualFold(caps.Host, terminalfile.Hostname()) || caps.OS != runtime.GOOS {
		return errors.New("helper and Tessera host identities differ; remote file transfers are not supported")
	}
	sequence, err := terminalfile.Serialize(c)
	if err != nil {
		return err
	}
	if _, err = io.WriteString(console, sequence); err != nil {
		return err
	}
	if c.Action == "cancel" {
		restoreInput()
		restoreOutput()
		_, err = fmt.Fprintf(output, "{\"id\":%q,\"state\":\"cancellation-requested\"}\n", c.ID)
		return err
	}
	fmt.Fprintf(diagnostics, "Request %s: waiting for browser approval\r\n", c.ID)
	complete := false
	defer func() {
		if !complete {
			_, _ = io.WriteString(console, terminalfile.Prefix+"cancel;"+c.ID+terminalfile.Terminator)
		}
	}()
	deadline := time.Now().Add(5*time.Minute + 5*time.Second)
	for {
		data, err := reader.wait(ctx, "reply", c.ID, deadline)
		if err != nil {
			return err
		}
		var result terminalfile.Result
		if json.Unmarshal(data, &result) != nil {
			return errors.New("invalid host reply")
		}
		switch result.State {
		case "pending", "claimed":
			deadline = time.Now().Add(5*time.Minute + 5*time.Second)
		case "transferring":
			fmt.Fprintf(diagnostics, "Transferred %d bytes\r\n", result.Bytes)
			deadline = time.Now().Add(5*time.Minute + 5*time.Second)
		default:
			complete = true
			restoreInput()
			restoreOutput()
			_, err = fmt.Fprintln(output, string(data))
			if err != nil {
				return err
			}
			if result.State != "complete" && result.State != "sent" {
				return fmt.Errorf("transfer %s: %s", result.State, result.Error)
			}
			return nil
		}
	}
}

type replyReader struct {
	read    func(time.Duration) ([]byte, error)
	input   *os.File
	pending []byte
}

func (r *replyReader) wait(ctx context.Context, action, id string, deadline time.Time) ([]byte, error) {
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// Remove every complete OSC, including unrelated nonces and progress.
		for {
			s := string(r.pending)
			start := strings.Index(s, "\x1b]")
			if start < 0 {
				if len(r.pending) > 1 {
					r.pending = r.pending[len(r.pending)-1:]
				}
				break
			}
			end := strings.Index(s[start:], terminalfile.Terminator)
			width := 2
			bel := strings.IndexByte(s[start:], 7)
			if bel >= 0 && (end < 0 || bel < end) {
				end = bel
				width = 1
			}
			if end < 0 {
				r.pending = r.pending[start:]
				break
			}
			end += start
			frame := r.pending[start : end+width]
			r.pending = r.pending[end+width:]
			if data, ok := terminalfile.MatchReply(frame, action, id); ok {
				return data, nil
			}
		}
		read := r.read
		if read == nil {
			read = func(wait time.Duration) ([]byte, error) { return readTerminalInput(r.input, wait) }
		}
		b, err := read(min(25*time.Millisecond, time.Until(deadline)))
		if err != nil {
			return nil, err
		}
		if strings.ContainsRune(string(b), 3) {
			return nil, context.Canceled
		}
		r.pending = append(r.pending, b...)
		if len(r.pending) > 1024*1024 {
			return nil, errors.New("terminal reply exceeded its limit")
		}
	}
	return nil, errors.New("terminal file reply timed out")
}
