package httpapi

import (
	"bytes"
	"compress/flate"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/rdpsession"
)

type rdpCompressionTrace struct {
	bytes   atomic.Int64
	mu      sync.Mutex
	capture bool
	data    []byte
}

type rdpCompressionConn struct {
	net.Conn
	trace *rdpCompressionTrace
}

func (c rdpCompressionConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.trace.bytes.Add(int64(n))
	if c.trace.capture {
		c.trace.mu.Lock()
		c.trace.data = append(c.trace.data, p[:n]...)
		c.trace.mu.Unlock()
	}
	return n, err
}

func rdpCompressionPair(t testing.TB, negotiate, capture bool) (*wsViewer, *websocket.Conn, *rdpCompressionTrace, *http.Response) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{EnableCompression: true}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		accepted <- conn
	}))
	t.Cleanup(server.Close)
	trace := &rdpCompressionTrace{capture: capture}
	dialer := websocket.Dialer{EnableCompression: negotiate,
		NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			return rdpCompressionConn{Conn: conn, trace: trace}, nil
		},
	}
	browser, response, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { browser.Close() })
	viewer := newWSViewer(<-accepted)
	t.Cleanup(viewer.stop)
	go viewer.writeLoop()
	trace.bytes.Store(0)
	trace.mu.Lock()
	trace.data = nil
	trace.mu.Unlock()
	return viewer, browser, trace, response
}

func rdpBitmapFixture(width, height int, pattern string) []byte {
	frame := make([]byte, 9+width*height*4)
	frame[0] = rdpsession.ViewImage
	binary.LittleEndian.PutUint16(frame[5:], uint16(width))
	binary.LittleEndian.PutUint16(frame[7:], uint16(height))
	state := uint32(0x9e3779b9)
	for y := range height {
		for x := range width {
			i := 9 + (y*width+x)*4
			if pattern == "rgb_noise" || pattern == "rgba_noise" {
				for channel := range 4 {
					state ^= state << 13
					state ^= state >> 17
					state ^= state << 5
					frame[i+channel] = byte(state)
				}
			} else {
				// Deterministic desktop/text-like blocks, not captured user pixels.
				shade := byte(24)
				if y%24 >= 5 && y%24 < 17 && x%10 >= 2 && x%10 < 7 {
					shade = 220
				}
				frame[i], frame[i+1], frame[i+2] = shade, shade, shade
			}
			if pattern != "rgba_noise" {
				frame[i+3] = 255
			}
		}
	}
	return frame
}

func TestKeptRDPCompressesOnlyEligibleBitmaps(t *testing.T) {
	for _, negotiate := range []bool{false, true} {
		name := "ordinary_client"
		if negotiate {
			name = "deflate_client"
		}
		t.Run(name, func(t *testing.T) {
			viewer, browser, trace, response := rdpCompressionPair(t, negotiate, true)
			extensions := response.Header.Get("Sec-WebSocket-Extensions")
			if strings.Contains(extensions, "permessage-deflate") != negotiate {
				t.Fatalf("compression negotiation = %q", extensions)
			}
			if negotiate && (!strings.Contains(extensions, "server_no_context_takeover") || !strings.Contains(extensions, "client_no_context_takeover")) {
				t.Fatalf("unexpected compression context sharing: %q", extensions)
			}
			for _, tc := range []struct {
				name       string
				frame      []byte
				compressed bool
			}{
				{"size", []byte{rdpsession.ViewDesktopSize, 8, 0, 8, 0}, false},
				{"below_threshold", rdpBitmapFixture(253, 1, "text"), false},
				{"above_threshold", rdpBitmapFixture(254, 1, "text"), true},
				{"large_bitmap", rdpBitmapFixture(320, 200, "text"), true},
				{"RGB_noise_after_bitmap", rdpBitmapFixture(320, 200, "rgb_noise"), false},
				{"RGBA_noise", rdpBitmapFixture(320, 200, "rgba_noise"), false},
				{"H264_after_bitmap", append([]byte{rdpsession.ViewH264}, bytes.Repeat([]byte{0}, 64*1024)...), false},
				{"small_bitmap_after_H264", rdpBitmapFixture(2, 2, "text"), false},
				{"another_bitmap", rdpBitmapFixture(320, 200, "text"), true},
				{"large_end_after_bitmap", append([]byte{rdpsession.ViewEnded, 0}, bytes.Repeat([]byte("x"), 2048)...), false},
			} {
				trace.bytes.Store(0)
				trace.mu.Lock()
				trace.data = nil
				trace.mu.Unlock()
				viewer.enqueue(tc.frame)
				browser.SetReadDeadline(time.Now().Add(5 * time.Second))
				kind, got, err := browser.ReadMessage()
				if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(got, tc.frame) {
					t.Fatalf("%s did not round-trip exactly: kind=%d error=%v", tc.name, kind, err)
				}
				trace.mu.Lock()
				compressed := len(trace.data) > 0 && trace.data[0]&0x40 != 0 // RSV1
				trace.mu.Unlock()
				if compressed != (tc.compressed && negotiate) {
					t.Fatalf("%s compressed=%v, want %v", tc.name, compressed, tc.compressed && negotiate)
				}
				if tc.name == "large_bitmap" && negotiate && trace.bytes.Load()*4 >= int64(len(tc.frame)) {
					t.Fatalf("bitmap compression saved too little: %d wire bytes for %d bytes", trace.bytes.Load(), len(tc.frame))
				}
			}
		})
	}
}

func TestRDPBitmapCompressionSelection(t *testing.T) {
	for _, size := range []int{0, 1, 9, 1023, 1024, 1025} {
		frame := make([]byte, size)
		if size > 0 {
			frame[0] = rdpsession.ViewImage
		}
		if got := compressRDPBitmap(frame); got != (size >= 1024) {
			t.Errorf("flat bitmap size %d: compression=%v", size, got)
		}
	}
	for _, kind := range []byte{rdpsession.ViewH264, rdpsession.ViewDesktopSize, rdpsession.ViewEnded, rdpsession.ViewDetached} {
		frame := make([]byte, 4096)
		frame[0] = kind
		if compressRDPBitmap(frame) {
			t.Errorf("non-bitmap kind %d selected", kind)
		}
	}
	for _, pattern := range []string{"text", "rgb_noise", "rgba_noise"} {
		frame := rdpBitmapFixture(1920, 1080, pattern)
		before := append([]byte(nil), frame...)
		if got := compressRDPBitmap(frame); got != (pattern == "text") {
			t.Errorf("pattern %s: compression=%v", pattern, got)
		}
		if !bytes.Equal(before, frame) {
			t.Fatal("compression selection changed the queued payload")
		}
		if allocs := testing.AllocsPerRun(100, func() { compressRDPBitmap(frame) }); allocs != 0 {
			t.Fatalf("selection allocated %g objects", allocs)
		}
	}
	// With 513 pixels every adjacent pair is sampled. Check the exact 1/8
	// boundary, including one fewer repeat, without probabilistic fixtures.
	for _, repeats := range []int{63, 64} {
		frame := rdpBitmapFixture(513, 1, "text")
		for i := range 513 {
			value := i
			if i%8 == 1 && i/8 < repeats {
				value--
			}
			binary.LittleEndian.PutUint32(frame[9+i*4:], uint32(value))
		}
		if got := compressRDPBitmap(frame); got != (repeats == 64) {
			t.Errorf("%d/512 repeated pairs: compression=%v", repeats, got)
		}
	}
}

func BenchmarkKeptRDPBitmapSelection(b *testing.B) {
	for _, pattern := range []string{"text", "rgb_noise", "rgba_noise"} {
		frame := rdpBitmapFixture(1920, 1080, pattern)
		b.Run(pattern, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				compressRDPBitmap(frame)
			}
		})
	}
}

func TestKeptRDPEndpointNegotiatesCompressionAndBoundsInflatedInput(t *testing.T) {
	h := newKeptHarness(t)
	if status, body := h.post("alice", "/api/rdp-kept", h.createBody("alice", "pane-1")); status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}
	header := http.Header{"Cookie": {signInCookie + "=" + h.cookies["alice"]}, "Origin": {h.server.URL}}
	address := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/api/rdp-kept/view?workspaceId=" + h.spaces["alice"] + "&pane=pane-1"
	for _, tc := range []struct {
		name      string
		negotiate bool
		size      int
		closeCode int
	}{
		{"inflated_over_limit", true, rdpKeptViewerMaxMessage + 1, websocket.CloseMessageTooBig},
		{"raw_over_limit", false, rdpKeptViewerMaxMessage + 1, websocket.CloseMessageTooBig},
		{"inflated_at_limit_reaches_protocol_validation", true, rdpKeptViewerMaxMessage, websocket.CloseProtocolError},
		{"raw_at_limit_reaches_protocol_validation", false, rdpKeptViewerMaxMessage, websocket.CloseProtocolError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, response, err := (&websocket.Dialer{EnableCompression: tc.negotiate}).Dial(address, header)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if strings.Contains(response.Header.Get("Sec-WebSocket-Extensions"), "permessage-deflate") != tc.negotiate {
				t.Fatal("the actual kept-view endpoint negotiated the wrong compression")
			}
			readFrame(t, conn)
			// Valid compressed controls are processed before the invalid message.
			for _, message := range [][]byte{{rdpsession.ViewShown, 1}, {rdpsession.ViewPressure, 1}, {rdpsession.ViewPressure, 0}} {
				if err := conn.WriteMessage(websocket.BinaryMessage, message); err != nil {
					t.Fatal(err)
				}
			}
			// A malformed pressure message is tiny compressed but large decoded.
			message := bytes.Repeat([]byte{rdpsession.ViewPressure}, tc.size)
			if err := conn.WriteMessage(websocket.BinaryMessage, message); err != nil {
				t.Fatal(err)
			}
			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			if _, _, err := conn.ReadMessage(); !websocket.IsCloseError(err, tc.closeCode) {
				t.Fatalf("input = %v, want close %d", err, tc.closeCode)
			}
		})
	}
	if sessions := h.list("alice"); len(sessions) != 1 || sessions[0].State != rdpsession.StateActive.String() {
		t.Fatalf("rejecting oversized viewer input ended the kept session: %+v", sessions)
	}
}

func BenchmarkKeptRDPBitmapCompression(b *testing.B) {
	for _, dimensions := range []struct {
		name          string
		width, height int
	}{{"rect", 320, 200}, {"1080p", 1920, 1080}, {"4k", 3840, 2160}} {
		for _, pattern := range []string{"text", "rgb_noise", "rgba_noise"} {
			frame := rdpBitmapFixture(dimensions.width, dimensions.height, pattern)
			for _, negotiate := range []bool{false, true} {
				mode := "raw"
				if negotiate {
					mode = "deflate"
				}
				b.Run(dimensions.name+"/"+pattern+"/"+mode, func(b *testing.B) {
					viewer, browser, trace, _ := rdpCompressionPair(b, negotiate, false)
					receive := func() {
						viewer.enqueue(frame)
						kind, got, err := browser.ReadMessage()
						if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(got, frame) {
							b.Fatalf("bitmap round trip failed: %v", err)
						}
					}
					receive() // warm the codec pools before measuring
					trace.bytes.Store(0)
					b.SetBytes(int64(len(frame)))
					b.ReportAllocs()
					for b.Loop() {
						receive()
					}
					wire := float64(trace.bytes.Load()) / float64(b.N)
					b.ReportMetric(wire, "wire_B/op")
					b.ReportMetric(wire/float64(len(frame)), "wire_ratio")
				})
			}
		}
	}
}

func BenchmarkKeptRDPBitmapDeflateCPU(b *testing.B) {
	for _, pattern := range []string{"text", "rgb_noise", "rgba_noise"} {
		frame := rdpBitmapFixture(1920, 1080, pattern)
		b.Run(pattern, func(b *testing.B) {
			writer, err := flate.NewWriter(io.Discard, flate.BestSpeed)
			if err != nil {
				b.Fatal(err)
			}
			defer writer.Close()
			b.SetBytes(int64(len(frame)))
			b.ReportAllocs()
			for b.Loop() {
				// Matches the codec's no-context-takeover reset and sync flush,
				// without network or client decompression in the timed operation.
				writer.Reset(io.Discard)
				if _, err := writer.Write(frame); err != nil {
					b.Fatal(err)
				}
				if err := writer.Flush(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkKeptRDPH264Transport(b *testing.B) {
	frame := make([]byte, 64*1024)
	frame[0] = rdpsession.ViewH264
	for _, negotiate := range []bool{false, true} {
		mode := "raw"
		if negotiate {
			mode = "negotiated"
		}
		b.Run(mode, func(b *testing.B) {
			viewer, browser, trace, _ := rdpCompressionPair(b, negotiate, false)
			receive := func() {
				viewer.enqueue(frame)
				kind, got, err := browser.ReadMessage()
				if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(got, frame) {
					b.Fatalf("H.264 payload round trip: %v", err)
				}
			}
			receive()
			trace.bytes.Store(0)
			b.ReportAllocs()
			for b.Loop() {
				receive()
			}
			b.ReportMetric(float64(trace.bytes.Load())/float64(b.N), "wire_B/op")
		})
	}
}

func TestKeptRDPCompressionInBrowsers(t *testing.T) {
	playwright := os.Getenv("TESSERA_PLAYWRIGHT")
	if playwright == "" {
		t.Skip("set TESSERA_PLAYWRIGHT to run the Chromium/WebKit WebSocket smoke check")
	}
	large := rdpBitmapFixture(320, 200, "text")
	binary.LittleEndian.PutUint16(large[1:], 1)
	binary.LittleEndian.PutUint16(large[3:], 2)
	small := rdpBitmapFixture(2, 2, "text")
	binary.LittleEndian.PutUint16(small[1:], 10)
	binary.LittleEndian.PutUint16(small[3:], 11)
	for i := 9; i < len(small); i += 4 {
		small[i], small[i+1], small[i+2], small[i+3] = 7, 9, 13, 0
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, "<!doctype html><title>RDP compression check</title>")
			return
		}
		if strings.HasSuffix(r.URL.Path, ".mjs") {
			http.ServeFile(w, r, filepath.Join("..", "..", "web", filepath.Base(r.URL.Path)))
			return
		}
		if r.URL.Path != "/view" {
			http.NotFound(w, r)
			return
		}
		conn, err := (&websocket.Upgrader{EnableCompression: r.URL.Query().Get("compression") == "1"}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		viewer := newWSViewer(conn)
		defer viewer.stop()
		go viewer.writeLoop()
		viewer.enqueue([]byte{rdpsession.ViewDesktopSize, 0x44, 1, 0xce, 0}) // 324x206
		viewer.enqueue(large)
		// A valid H.264 surface operation between compressed and raw bitmaps.
		viewer.enqueue([]byte{rdpsession.ViewH264, 0, 0, 16, 0, 0})
		viewer.enqueue(small)
		conn.ReadMessage() // stay alive until the browser closes its view
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join("..", "..", "scripts", "rdp-compression-browser-smoke.mjs"),
		"--playwright="+playwright, "--url="+server.URL)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("browser compression check: %v\n%s", err, output)
	}
	t.Logf("%s", output)
}
