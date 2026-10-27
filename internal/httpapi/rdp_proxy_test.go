package httpapi

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/store"
)

func TestNormalizeRDPTarget(t *testing.T) {
	tests := map[string]string{
		"example.com":              "example.com:3389",
		"EXAMPLE.com:3390":         "example.com:3390",
		"rdp://desktop.local":      "desktop.local:3389",
		"localhost":                "localhost:3389",
		"192.0.2.10:3399":          "192.0.2.10:3399",
		"[2001:db8::1]":            "[2001:db8::1]:3389",
		"rdp://[2001:db8::1]:3392": "[2001:db8::1]:3392",
	}
	for raw, want := range tests {
		got, err := normalizeRDPTarget(raw)
		if err != nil {
			t.Errorf("normalizeRDPTarget(%q): %v", raw, err)
			continue
		}
		if got != want {
			t.Errorf("normalizeRDPTarget(%q) = %q, want %q", raw, got, want)
		}
	}
	for _, raw := range []string{"", "vnc://example.com", "host:0", "host:65536", "rdp://user:secret@host", "rdp://host/path", "2001:db8::1"} {
		if _, err := normalizeRDPTarget(raw); err == nil {
			t.Errorf("normalizeRDPTarget(%q) succeeded", raw)
		}
	}
}

func TestRDPCapabilityExpiresAndIsConsumedOnce(t *testing.T) {
	manager := &rdpProxyManager{capabilities: make(map[string]rdpCapability)}
	now := time.Now()
	id, err := manager.create("example.com:3389", "ab", now)
	if err != nil {
		t.Fatal(err)
	}
	if capability, ok := manager.consume(id, now.Add(time.Minute)); !ok || capability.target != "example.com:3389" || capability.fingerprint != "ab" {
		t.Fatalf("consume = %+v, %v", capability, ok)
	}
	if _, ok := manager.consume(id, now.Add(time.Minute)); ok {
		t.Fatal("capability was reusable")
	}
	expired, err := manager.create("example.com:3389", "ab", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.consume(expired, now.Add(rdpCapabilityLife)); ok {
		t.Fatal("expired capability was accepted")
	}
}

func TestRDPProxyCreateRequiresWorkspaceAndFingerprint(t *testing.T) {
	api := rdpTestAPI(t)
	fingerprint := strings.Repeat("ab", 32)
	create := func(body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		api.rdpProxyCreate(response, httptest.NewRequest(http.MethodPost, "/api/rdp-proxy", strings.NewReader(body)))
		return response
	}

	response := create(`{"workspaceId":"default","target":"Example.com","fingerprint":"` + strings.ToUpper(fingerprint) + `"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", response.Code, response.Body.String())
	}
	var created struct{ Path, Target string }
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Target != "example.com:3389" || !strings.HasPrefix(created.Path, "/api/rdp-proxy/connect/") {
		t.Fatalf("unexpected create response: %+v", created)
	}
	capability, ok := api.rdpManager().consume(strings.TrimPrefix(created.Path, "/api/rdp-proxy/connect/"), time.Now())
	if !ok || capability.fingerprint != fingerprint {
		t.Fatalf("capability = %+v, %v", capability, ok)
	}

	if response := create(`{"workspaceId":"default","target":"example.com"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("missing fingerprint status = %d", response.Code)
	}
	if response := create(`{"workspaceId":"other","target":"example.com","fingerprint":"` + fingerprint + `"}`); response.Code != http.StatusNotFound {
		t.Fatalf("unknown workspace status = %d", response.Code)
	}
	if response := create(`{"workspaceId":"default","target":"http://example.com","fingerprint":"` + fingerprint + `"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("bad target status = %d", response.Code)
	}
}

func TestRDPProxyConnectRejectsOriginAndUnknownCapability(t *testing.T) {
	api := &API{}
	request := httptest.NewRequest(http.MethodGet, "http://tessera.test/api/rdp-proxy/connect/missing", nil)
	request.Header.Set("Origin", "http://other.test")
	response := httptest.NewRecorder()
	api.rdpProxyConnect(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "http://tessera.test/api/rdp-proxy/connect/missing", nil)
	response = httptest.NewRecorder()
	api.rdpProxyConnect(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("unknown capability status = %d", response.Code)
	}
}

// The DER below is written out by hand from ironrdp-rdcleanpath's
// RDCleanPathPdu definition, so the Go encoding is checked against the
// wire format rather than against itself.
func TestRDCleanPathWireFormat(t *testing.T) {
	x224 := rdpConnectionRequest()
	request := append([]byte{
		0x30, 0x2c,
		0xa0, 0x04, 0x02, 0x02, 0x0d, 0x3e, // [0] version 3390
		0xa2, 0x06, 0x0c, 0x04, 'd', 'e', 's', 't', // [2] destination
		0xa3, 0x05, 0x0c, 0x03, 't', 'o', 'k', // [3] proxy_auth
		0xa6, 0x15, 0x04, 0x13, // [6] x224_connection_pdu
	}, x224...)
	var decoded rdCleanPathPDU
	if rest, err := asn1.Unmarshal(request, &decoded); err != nil || len(rest) != 0 {
		t.Fatalf("decode request: %v (rest %d)", err, len(rest))
	}
	if decoded.Version != rdCleanPathVersion || decoded.Destination != "dest" || decoded.ProxyAuth != "tok" || !bytes.Equal(decoded.X224, x224) {
		t.Fatalf("decoded request = %+v", decoded)
	}
	if total, err := derTotalLength(request[:3]); err != nil || total != len(request) {
		t.Fatalf("derTotalLength = %d, %v", total, err)
	}

	encoded, err := asn1.Marshal(rdCleanPathHTTPError(http.StatusConflict))
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{
		0x30, 0x15,
		0xa0, 0x04, 0x02, 0x02, 0x0d, 0x3e,
		0xa1, 0x0d, 0x30, 0x0b,
		0xa0, 0x03, 0x02, 0x01, 0x01, // error_code 1
		0xa1, 0x04, 0x02, 0x02, 0x01, 0x99, // http_status_code 409
	}
	if !bytes.Equal(encoded, want) {
		t.Fatalf("error PDU = %x, want %x", encoded, want)
	}

	encoded, err = asn1.Marshal(rdCleanPathPDU{Version: rdCleanPathVersion, X224: []byte{1, 2}, ServerCertChain: [][]byte{{3}, {4, 5}}, ServerAddr: "1.2.3.4:3389"})
	if err != nil {
		t.Fatal(err)
	}
	want = []byte{
		0x30, 0x27,
		0xa0, 0x04, 0x02, 0x02, 0x0d, 0x3e,
		0xa6, 0x04, 0x04, 0x02, 1, 2,
		0xa7, 0x09, 0x30, 0x07, 0x04, 0x01, 3, 0x04, 0x02, 4, 5,
		0xa9, 0x0e, 0x0c, 0x0c, '1', '.', '2', '.', '3', '.', '4', ':', '3', '3', '8', '9',
	}
	if !bytes.Equal(encoded, want) {
		t.Fatalf("response PDU = %x, want %x", encoded, want)
	}
}

func TestRDPProxyRelaysThroughTLSAfterRDCleanPath(t *testing.T) {
	server := startFakeRDPServer(t, rdpNegotiationResponse(0x02, rdpProtocolHybrid))
	api := rdpTestAPI(t)
	fingerprint := rdpCertificateFingerprint(server.certificate.Raw)

	probe := httptest.NewRecorder()
	api.rdpProxyCertificate(probe, httptest.NewRequest(http.MethodPost, "/api/rdp-proxy/certificate", strings.NewReader(`{"target":"`+server.address+`"}`)))
	if probe.Code != http.StatusOK {
		t.Fatalf("certificate status = %d: %s", probe.Code, probe.Body.String())
	}
	var certificate struct{ Target, Fingerprint, Subject string }
	if err := json.NewDecoder(probe.Body).Decode(&certificate); err != nil {
		t.Fatal(err)
	}
	if certificate.Fingerprint != fingerprint || !strings.Contains(certificate.Subject, "rdp.test") || certificate.Target != server.address {
		t.Fatalf("certificate = %+v", certificate)
	}
	if got := <-server.requests; !bytes.Equal(got, rdpConnectionRequest()) {
		t.Fatalf("probe X.224 request = %x", got)
	}

	conn := dialRDPProxy(t, api, server.address, fingerprint)
	clientRequest := rdpConnectionRequest()
	clientRequest[15] = rdpProtocolHybridEx
	writeTestRDCleanPath(t, conn, rdCleanPathPDU{Version: rdCleanPathVersion, Destination: "ignored.example:3389", ProxyAuth: "x", X224: clientRequest})
	response := readTestRDCleanPath(t, conn)
	if response.Error.ErrorCode != 0 {
		t.Fatalf("unexpected error response: %+v", response.Error)
	}
	if got := <-server.requests; !bytes.Equal(got, clientRequest) {
		t.Fatalf("forwarded X.224 request = %x, want %x", got, clientRequest)
	}
	if !bytes.Equal(response.X224, server.confirm) || len(response.ServerCertChain) != 1 || !bytes.Equal(response.ServerCertChain[0], server.certificate.Raw) || response.ServerAddr == "" {
		t.Fatalf("response = %+v", response)
	}

	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("credssp")); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, echoed, err := conn.ReadMessage()
	if err != nil || string(echoed) != "echo:credssp" {
		t.Fatalf("relay = %q, %v", echoed, err)
	}
}

func TestRDPProxyRejectsChangedCertificate(t *testing.T) {
	server := startFakeRDPServer(t, rdpNegotiationResponse(0x02, rdpProtocolSSL))
	conn := dialRDPProxy(t, rdpTestAPI(t), server.address, strings.Repeat("0", 64))
	writeTestRDCleanPath(t, conn, rdCleanPathPDU{Version: rdCleanPathVersion, X224: rdpConnectionRequest()})
	response := readTestRDCleanPath(t, conn)
	if response.Error.HTTPStatusCode != http.StatusConflict || response.ServerCertChain != nil {
		t.Fatalf("response = %+v", response)
	}
}

func TestRDPProxyReportsNegotiationFailure(t *testing.T) {
	failure := rdpNegotiationResponse(0x03, 5)
	server := startFakeRDPServer(t, failure)
	api := rdpTestAPI(t)

	probe := httptest.NewRecorder()
	api.rdpProxyCertificate(probe, httptest.NewRequest(http.MethodPost, "/api/rdp-proxy/certificate", strings.NewReader(`{"target":"`+server.address+`"}`)))
	if probe.Code != http.StatusBadGateway || !strings.Contains(probe.Body.String(), "rejected the connection") {
		t.Fatalf("probe = %d %s", probe.Code, probe.Body.String())
	}

	conn := dialRDPProxy(t, api, server.address, strings.Repeat("0", 64))
	writeTestRDCleanPath(t, conn, rdCleanPathPDU{Version: rdCleanPathVersion, X224: rdpConnectionRequest()})
	response := readTestRDCleanPath(t, conn)
	if response.Error.ErrorCode != rdCleanPathNegotiationError || !bytes.Equal(response.X224, failure) {
		t.Fatalf("response = %+v", response)
	}
}

func TestRDPProxyRejectsStandardSecurityAndBadRequests(t *testing.T) {
	server := startFakeRDPServer(t, rdpNegotiationResponse(0x02, 0))
	api := rdpTestAPI(t)
	probe := httptest.NewRecorder()
	api.rdpProxyCertificate(probe, httptest.NewRequest(http.MethodPost, "/api/rdp-proxy/certificate", strings.NewReader(`{"target":"`+server.address+`"}`)))
	if probe.Code != http.StatusBadGateway || !strings.Contains(probe.Body.String(), "Standard RDP Security") {
		t.Fatalf("probe = %d %s", probe.Code, probe.Body.String())
	}

	conn := dialRDPProxy(t, api, server.address, strings.Repeat("0", 64))
	writeTestRDCleanPath(t, conn, rdCleanPathPDU{Version: rdCleanPathVersion, X224: rdpConnectionRequest()})
	if response := readTestRDCleanPath(t, conn); response.Error.HTTPStatusCode != http.StatusNotImplemented {
		t.Fatalf("standard security response = %+v", response.Error)
	}

	for name, pdu := range map[string]rdCleanPathPDU{
		"wrong version": {Version: 3389, X224: rdpConnectionRequest()},
		"no X.224":      {Version: rdCleanPathVersion, PreconnectionBlob: "vm"},
		"bad X.224":     {Version: rdCleanPathVersion, X224: []byte{1, 2, 3}},
	} {
		conn := dialRDPProxy(t, api, server.address, strings.Repeat("0", 64))
		writeTestRDCleanPath(t, conn, pdu)
		if response := readTestRDCleanPath(t, conn); response.Error.HTTPStatusCode != http.StatusBadRequest {
			t.Errorf("%s: response = %+v", name, response.Error)
		}
	}
}

// TestIronRDPClientInterop runs the bundled IronRDP WebAssembly client in
// Node against this gateway and a fake server. It is slow, so it runs only
// with TESSERA_RDP_INTEROP=1, e.g. after upgrading IronRDP.
func TestIronRDPClientInterop(t *testing.T) {
	if os.Getenv("TESSERA_RDP_INTEROP") != "1" {
		t.Skip("set TESSERA_RDP_INTEROP=1 to run the IronRDP client")
	}
	bundle, err := filepath.Abs("../../web/vendor/rdp.js")
	if err != nil {
		t.Fatal(err)
	}
	other := strings.Repeat("0", 64)
	for _, tc := range []struct {
		name    string
		confirm []byte
		trusted bool
		want    string
	}{
		{"handshake", rdpNegotiationResponse(0x02, rdpProtocolHybrid), true, "RESULT handshake"},
		{"changed certificate", rdpNegotiationResponse(0x02, rdpProtocolHybrid), false, "RESULT kind=4 http=409"},
		{"standard security", rdpNegotiationResponse(0x02, 0), true, "RESULT kind=4 http=501"},
		{"negotiation failure", rdpNegotiationResponse(0x03, 5), true, "RESULT kind=6 http="},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := startFakeRDPServer(t, tc.confirm)
			api := rdpTestAPI(t)
			fingerprint := other
			if tc.trusted {
				fingerprint = rdpCertificateFingerprint(server.certificate.Raw)
			}
			id, err := api.rdpManager().create(server.address, fingerprint, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			// Node's WebSocket sends no Origin; stand in for the browser's.
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.Header.Set("Origin", "http://"+r.Host)
				api.rdpProxyConnect(w, r)
			}))
			defer proxy.Close()
			output, err := exec.Command("node", "../../scripts/rdp-interop-client.mjs", bundle, "ws"+strings.TrimPrefix(proxy.URL, "http")+"/api/rdp-proxy/connect/"+id, "rdp.test").CombinedOutput()
			if err != nil || !strings.Contains(string(output), tc.want+"\n") {
				t.Fatalf("client output (err %v), want %q:\n%s", err, tc.want, output)
			}
			// A completed handshake leaves CredSSP's first TSRequest, a DER
			// SEQUENCE, on the server's side of the TLS relay.
			if received := server.receivedOverTLS(); tc.trusted && tc.want == "RESULT handshake" && (len(received) == 0 || received[0] != 0x30) {
				t.Fatalf("server received %x over TLS", received)
			}
		})
	}
}

func rdpTestAPI(t *testing.T) *API {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "rdp.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.LoadDefaultWorkspace(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	return &API{Store: st}
}

func dialRDPProxy(t *testing.T, api *API, target, fingerprint string) *websocket.Conn {
	t.Helper()
	id, err := api.rdpManager().create(target, fingerprint, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(http.HandlerFunc(api.rdpProxyConnect))
	t.Cleanup(httpServer.Close)
	header := http.Header{}
	header.Set("Origin", httpServer.URL)
	conn, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/rdp-proxy/connect/"+id, header)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("dial proxy: %v (status %d)", err, status)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func writeTestRDCleanPath(t *testing.T, conn *websocket.Conn, pdu rdCleanPathPDU) {
	t.Helper()
	encoded, err := asn1.Marshal(pdu)
	if err != nil {
		t.Fatal(err)
	}
	// Split the request across frames, as a stream transport may.
	for _, part := range [][]byte{encoded[:3], encoded[3:]} {
		if err := conn.WriteMessage(websocket.BinaryMessage, part); err != nil {
			t.Fatal(err)
		}
	}
}

func readTestRDCleanPath(t *testing.T, conn *websocket.Conn) rdCleanPathPDU {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, message, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read RDCleanPath response: %v", err)
	}
	var pdu rdCleanPathPDU
	if rest, err := asn1.Unmarshal(message, &pdu); err != nil || len(rest) != 0 {
		t.Fatalf("decode RDCleanPath response %x: %v", message, err)
	}
	if pdu.Version != rdCleanPathVersion {
		t.Fatalf("response version = %d", pdu.Version)
	}
	return pdu
}

// rdpNegotiationResponse builds an X.224 Connection Confirm carrying an
// RDP_NEG_RSP (kind 2) or RDP_NEG_FAILURE (kind 3).
func rdpNegotiationResponse(kind byte, value uint32) []byte {
	confirm := []byte{
		0x03, 0x00, 0x00, 0x13,
		0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00,
		kind, 0x00, 0x08, 0x00,
		0x00, 0x00, 0x00, 0x00,
	}
	binary.LittleEndian.PutUint32(confirm[15:], value)
	return confirm
}

type fakeRDPServer struct {
	address     string
	certificate *x509.Certificate
	confirm     []byte
	requests    chan []byte

	mu       sync.Mutex
	received []byte // what the client sent after TLS
}

func (s *fakeRDPServer) receivedOverTLS() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.received...)
}

// startFakeRDPServer answers each connection's X.224 request with confirm,
// then, when the confirm selects TLS, serves TLS and echoes what it reads.
func startFakeRDPServer(t *testing.T, confirm []byte) *fakeRDPServer {
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
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	server := &fakeRDPServer{address: listener.Addr().String(), certificate: certificate, confirm: confirm, requests: make(chan []byte, 8)}
	config := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				request, err := readX224Response(conn)
				if err != nil {
					return
				}
				server.requests <- request
				if _, err := conn.Write(confirm); err != nil || checkX224Confirm(confirm) != nil {
					return
				}
				tlsConn := tls.Server(conn, config)
				buffer := make([]byte, 1024)
				for {
					count, err := tlsConn.Read(buffer)
					if err != nil {
						return
					}
					server.mu.Lock()
					server.received = append(server.received, buffer[:count]...)
					server.mu.Unlock()
					if _, err := tlsConn.Write(append([]byte("echo:"), buffer[:count]...)); err != nil {
						return
					}
				}
			}()
		}
	}()
	return server
}

func TestRDPCertificateFingerprintIsHexSHA256(t *testing.T) {
	if got := rdpCertificateFingerprint([]byte("x")); len(got) != 64 || !rdpFingerprintPattern.MatchString(got) {
		t.Fatalf("fingerprint = %q", got)
	}
	if _, err := hex.DecodeString(rdpCertificateFingerprint(nil)); err != nil {
		t.Fatal(err)
	}
}
