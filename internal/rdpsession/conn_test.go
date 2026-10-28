package rdpsession

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer answers one RDP client's X.224 request, choosing CredSSP,
// completes TLS with a throwaway certificate, and records the first bytes the
// client sends after TLS.
type fakeServer struct {
	address     string
	fingerprint string

	mu       sync.Mutex
	afterTLS []byte
	finished chan struct{}
}

func startFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "rdp.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	server := &fakeServer{address: listener.Addr().String(), fingerprint: CertificateFingerprint(der), finished: make(chan struct{})}
	go func() {
		defer close(server.finished)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return
		}
		if _, err := io.ReadFull(conn, make([]byte, int(binary.BigEndian.Uint16(header[2:]))-4)); err != nil {
			return
		}
		if _, err := conn.Write(hybridConfirm); err != nil {
			return
		}
		secure := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
		if secure.Handshake() != nil {
			return
		}
		buf := make([]byte, 4096)
		n, _ := secure.Read(buf)
		server.mu.Lock()
		server.afterTLS = append([]byte(nil), buf[:n]...)
		server.mu.Unlock()
	}()
	return server
}

func (s *fakeServer) received(t *testing.T) []byte {
	t.Helper()
	select {
	case <-s.finished:
	case <-time.After(20 * time.Second):
		t.Fatal("the fake server didn't finish")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.afterTLS
}

type eventRecorder struct {
	mu     sync.Mutex
	events []recordedEvent
}

func (l *eventRecorder) record(kind uint32, payload []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, recordedEvent{kind, payload})
}

func (l *eventRecorder) ended(t *testing.T) (End, string) {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, event := range l.events {
		if event.kind == eventEnded {
			return End(event.payload[0]), string(event.payload[1:])
		}
	}
	t.Fatal("no Ended event")
	return 0, ""
}

func TestModuleReachesCredSSPWithTheTrustedCertificate(t *testing.T) {
	server := startFakeServer(t)
	events := &eventRecorder{}
	conn, err := dialServer(context.Background(), server.address, server.fingerprint, events.record)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	end, err := testInstance(t).Run(context.Background(), conn, testConfig())
	if err != nil {
		t.Fatal(err)
	}
	// The fake server stops after the first CredSSP message, which ends the run.
	if end != EndError {
		t.Fatalf("end = %d, want EndError", end)
	}
	if code, reason := events.ended(t); code != EndError || !strings.HasPrefix(reason, "connect:") {
		t.Fatalf("Ended = %d %q", code, reason)
	}
	if conn.tlsErr != nil {
		t.Fatalf("TLS upgrade failed: %v", conn.tlsErr)
	}
	if received := server.received(t); !bytes.Contains(received, []byte("NTLMSSP\x00")) {
		t.Fatalf("expected an NTLM negotiate in CredSSP, got %x", received)
	}
}

func TestModuleStopsAtAnUntrustedCertificate(t *testing.T) {
	server := startFakeServer(t)
	events := &eventRecorder{}
	conn, err := dialServer(context.Background(), server.address, strings.Repeat("0", 64), events.record)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if end, err := testInstance(t).Run(context.Background(), conn, testConfig()); err != nil || end != EndError {
		t.Fatalf("end = %d, err = %v", end, err)
	}
	if !errors.Is(conn.tlsErr, ErrCertificateChanged) {
		t.Fatalf("tlsErr = %v, want ErrCertificateChanged", conn.tlsErr)
	}
	conn.Close()
	if received := server.received(t); len(received) != 0 {
		t.Fatalf("the server received %d bytes after TLS from an untrusted connection", len(received))
	}
}

func TestPostRefusesAfterCloseAndWhenFull(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	conn, err := dialServer(context.Background(), listener.Addr().String(), "", func(uint32, []byte) {})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < controlBacklog; i++ {
		if !conn.post([]byte{tagRefresh}) {
			t.Fatalf("post %d refused", i)
		}
	}
	if conn.post([]byte{tagRefresh}) {
		t.Fatal("post accepted beyond the backlog")
	}
	conn.Close()
	if conn.post([]byte{tagRefresh}) {
		t.Fatal("post accepted after Close")
	}
}
