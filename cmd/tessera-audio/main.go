// tessera-audio emits Tessera's private OSC audio extension. It never selects
// files on the Tessera host; bytes come from this command's file or stdin.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/term"
	"tessera/internal/terminalaudio"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	restore, err := prepareOutput(os.Stdout)
	if err == nil {
		err = run(os.Args[1:], os.Stdin, os.Stdout, func() ([]byte, error) { return queryCapabilities(ctx, os.Stdin, os.Stdout) })
		restore()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tessera-audio:", err)
		os.Exit(1)
	}
}

func randomID() (string, error) {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

func run(args []string, input io.Reader, output io.Writer, query func() ([]byte, error)) error {
	if len(args) == 0 {
		return errors.New("usage: tessera-audio play <file|-> [--format wav|mp3] [--id ID] | stream <file|-> [--bitrate 128k] [--buffer-ms 500] | stop [ID] | capabilities")
	}
	switch args[0] {
	case "stream":
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return stream(ctx, args[1:], input, output)
	case "play":
		var file, format, id string
		for i := 1; i < len(args); i++ {
			switch args[i] {
			case "--format", "--id":
				flag := args[i]
				i++
				if i == len(args) {
					return fmt.Errorf("%s requires a value", flag)
				}
				if flag == "--format" {
					format = args[i]
				} else {
					id = args[i]
				}
			default:
				if file != "" || (len(args[i]) > 1 && args[i][0] == '-') {
					return errors.New("play requires one file or - for stdin")
				}
				file = args[i]
			}
		}
		if file == "" {
			return errors.New("play requires one file or - for stdin")
		}
		if file == "-" && format == "" {
			return errors.New("stdin playback requires --format wav or mp3")
		}
		reader := input
		if file != "-" {
			f, err := os.Open(file)
			if err != nil {
				return err
			}
			defer f.Close()
			reader = f
		}
		data, err := io.ReadAll(io.LimitReader(reader, terminalaudio.MaxClipBytes+1))
		if err != nil {
			return err
		}
		if format == "" {
			format = terminalaudio.DetectFormat(data)
		}
		if id == "" {
			id, err = randomID()
			if err != nil {
				return err
			}
		}
		sequence, err := terminalaudio.Play(id, format, data)
		if err != nil {
			return err
		}
		_, err = output.Write(sequence)
		return err
	case "stop":
		if len(args) > 2 {
			return errors.New("usage: tessera-audio stop [ID]")
		}
		id := "*"
		if len(args) == 2 {
			id = args[1]
		}
		sequence, err := terminalaudio.Stop(id)
		if err != nil {
			return err
		}
		_, err = output.Write(sequence)
		return err
	case "capabilities":
		if len(args) != 1 {
			return errors.New("usage: tessera-audio capabilities")
		}
		data, err := query()
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(output, string(data))
		return err
	default:
		return errors.New("unknown command; use play, stream, stop, or capabilities")
	}
}

func queryCapabilities(ctx context.Context, input, output *os.File) ([]byte, error) {
	if !term.IsTerminal(int(input.Fd())) || !term.IsTerminal(int(output.Fd())) {
		return nil, errors.New("capabilities requires terminal stdin and stdout")
	}
	nonce, err := randomID()
	if err != nil {
		return nil, err
	}
	state, err := term.MakeRaw(int(input.Fd()))
	if err != nil {
		return nil, err
	}
	defer term.Restore(int(input.Fd()), state)
	if _, err := io.WriteString(output, terminalaudio.Prefix+"query;"+nonce+terminalaudio.Terminator); err != nil {
		return nil, err
	}
	return readCapabilityResponse(ctx, nonce, time.Now().Add(time.Second), func(wait time.Duration) ([]byte, error) { return readTerminalInput(input, wait) })
}

func readCapabilityResponse(ctx context.Context, nonce string, deadline time.Time, read func(time.Duration) ([]byte, error)) ([]byte, error) {
	var pending []byte
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		data, err := read(min(25*time.Millisecond, time.Until(deadline)))
		if err != nil {
			return nil, err
		}
		for _, b := range data {
			if b == 3 {
				return nil, errors.New("capability query interrupted")
			}
		}
		pending = append(pending, data...)
		if len(pending) > 16*1024 {
			return nil, errors.New("capability response exceeded its limit")
		}
		if reply, ok := terminalaudio.CapabilityReply(pending, nonce); ok {
			return reply, nil
		}
	}
	return nil, errors.New("terminal audio capability query timed out")
}
