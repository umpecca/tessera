//go:build windows

package main

import (
	"bytes"
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"strings"
	"tessera/internal/terminalaudio"
	conpty "tessera/internal/winconpty"
	"testing"
	"time"
)

func TestAudioQueryChild(t *testing.T) {
	scenario := os.Getenv("TESSERA_AUDIO_QUERY_TEST")
	if scenario == "" {
		return
	}
	var before, after uint32
	if err := windows.GetConsoleMode(windows.Handle(os.Stdin.Fd()), &before); err != nil {
		t.Fatal(err)
	}
	restore, err := prepareOutput(os.Stdout)
	if err != nil {
		t.Fatal(err)
	}
	_, queryErr := queryCapabilities(context.Background(), os.Stdin, os.Stdout)
	restore()
	if err := windows.GetConsoleMode(windows.Handle(os.Stdin.Fd()), &after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("raw input mode was not restored: %d != %d", before, after)
	}
	if (scenario == "success") != (queryErr == nil) {
		t.Fatalf("query result: %v", queryErr)
	}
	if scenario == "timeout" && !strings.Contains(queryErr.Error(), "timed out") {
		t.Fatal(queryErr)
	}
	fmt.Println("AUDIO_QUERY_RESTORED:" + scenario)
}

func TestConsoleCapabilityQueryRestoresModes(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"success", "timeout", "interrupt"} {
		t.Run(scenario, func(t *testing.T) {
			pty, err := conpty.Start(fmt.Sprintf("%q -test.run=^TestAudioQueryChild$ -test.v", executable), conpty.ConPtyEnv(append(os.Environ(), "TESSERA_AUDIO_QUERY_TEST="+scenario)))
			if err != nil {
				t.Fatal(err)
			}
			defer pty.Close()
			result := make(chan []byte, 1)
			go func() {
				var output []byte
				var responded bool
				chunk := make([]byte, 4096)
				for {
					n, readErr := pty.Read(chunk)
					output = append(output, chunk[:n]...)
					prefix := []byte(terminalaudio.Prefix + "query;")
					if start := bytes.Index(output, prefix); !responded && start >= 0 {
						rest := output[start+len(prefix):]
						if end := bytes.Index(rest, []byte(terminalaudio.Terminator)); end >= 0 {
							responded = true
							if scenario == "success" {
								_, reply, _ := terminalaudio.Parse("query;" + string(rest[:end]))
								pty.Write([]byte(reply))
							} else if scenario == "interrupt" {
								pty.Write([]byte{3})
							}
						}
					}
					if readErr != nil || bytes.Contains(output, []byte("AUDIO_QUERY_RESTORED:"+scenario)) {
						result <- output
						return
					}
				}
			}()
			select {
			case output := <-result:
				if !bytes.Contains(output, []byte("AUDIO_QUERY_RESTORED:"+scenario)) {
					t.Fatalf("query/restoration failed: %q", output)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("query test timed out")
			}
		})
	}
}
