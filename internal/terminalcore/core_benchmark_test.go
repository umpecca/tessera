package terminalcore

import (
	"bytes"
	"testing"
)

// Include the reply and clipboard drains performed after every host PTY read.
// CoreTextOutput measures the parser alone; this measures the full core path.
func BenchmarkCoreHostOutput(b *testing.B) {
	for _, workload := range []struct {
		name string
		data []byte
	}{
		{"progress", []byte("\r\x1b[2K\x1b[32mBuilding package 123/456\x1b[0m")},
		{"build_8KiB", bytes.Repeat([]byte("ordinary build output for module\r\n"), 248)},
		{"effects", []byte("\rstatus\x1b[6n\x1b]52;c;aG9zdCBjbGlwYm9hcmQ=\a")},
	} {
		b.Run(workload.name, func(b *testing.B) {
			c, err := New(80, 24)
			if err != nil {
				b.Fatal(err)
			}
			defer c.Close()
			// Warm the parser, function cache, and reusable scratch buffers.
			if err := c.Write(workload.data); err != nil {
				b.Fatal(err)
			}
			if _, err := c.Replies(); err != nil {
				b.Fatal(err)
			}
			if _, err := c.Clipboard(); err != nil {
				b.Fatal(err)
			}
			b.SetBytes(int64(len(workload.data)))
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if err := c.Write(workload.data); err != nil {
					b.Fatal(err)
				}
				if _, err := c.Replies(); err != nil {
					b.Fatal(err)
				}
				if _, err := c.Clipboard(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
