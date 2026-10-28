package rdpsession

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"errors"
	"net"
	"sync"
	"time"
)

const (
	connectTimeout   = 10 * time.Second
	handshakeTimeout = 15 * time.Second
	// controlBacklog bounds the host messages (input, resize, display
	// requests) waiting for the module.
	controlBacklog = 256
)

// ErrCertificateChanged means the server presented a certificate other than
// the one the user trusted.
var ErrCertificateChanged = errors.New("the RDP server's certificate changed")

// CertificateFingerprint is the lowercase hex SHA-256 of a DER certificate,
// the form the RDP pane stores for the certificate the user trusted.
func CertificateFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// serverConn is one TCP connection to an RDP server, the Link a module run
// uses. Until the module reports Connected, Recv reads the server directly;
// after that a reader goroutine feeds it, so host messages can reach the
// module while the server is silent.
type serverConn struct {
	host        string
	fingerprint string
	onEvent     func(kind uint32, payload []byte)

	tcp     net.Conn
	conn    net.Conn // tcp, then the TLS connection
	tlsErr  error
	active  bool
	data    chan []byte
	control chan []byte
	done    chan struct{} // closed when the reader stops
	closed  chan struct{}
	once    sync.Once
}

// dialServer opens a TCP connection to target ("host:port"). The TLS upgrade
// happens when the module asks for it, and accepts only the certificate whose
// fingerprint is trusted.
func dialServer(ctx context.Context, target, trusted string, onEvent func(uint32, []byte)) (*serverConn, error) {
	host, _, err := net.SplitHostPort(target)
	if err != nil {
		return nil, err
	}
	tcp, err := (&net.Dialer{Timeout: connectTimeout, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", target)
	if err != nil {
		return nil, err
	}
	return &serverConn{
		host: host, fingerprint: trusted, onEvent: onEvent,
		tcp: tcp, conn: tcp,
		data: make(chan []byte, 64), control: make(chan []byte, controlBacklog),
		done: make(chan struct{}), closed: make(chan struct{}),
	}, nil
}

// post queues a host message for the module. It returns false once the
// connection is closed or when the backlog is full.
func (c *serverConn) post(message []byte) bool {
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.control <- message:
		return true
	default:
		return false
	}
}

// Close ends the connection; the module's next Recv sees it gone.
func (c *serverConn) Close() {
	c.once.Do(func() {
		close(c.closed)
		_ = c.tcp.Close()
	})
}

func (c *serverConn) startReader() {
	c.active = true
	go func() {
		defer close(c.done)
		for {
			buf := make([]byte, 32*1024)
			n, err := c.conn.Read(buf)
			if n > 0 {
				select {
				case c.data <- buf[:n]:
				case <-c.closed:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
}

func (c *serverConn) Recv() []byte {
	if !c.active {
		_ = c.conn.SetReadDeadline(time.Now().Add(handshakeTimeout))
		buf := make([]byte, 32*1024)
		n, _ := c.conn.Read(buf[1:])
		_ = c.conn.SetReadDeadline(time.Time{})
		if n == 0 {
			return nil
		}
		buf[0] = tagServerBytes
		return buf[:n+1]
	}
	select {
	case bytes := <-c.data:
		return append([]byte{tagServerBytes}, bytes...)
	case message := <-c.control:
		return message
	case <-c.done:
		select {
		case bytes := <-c.data:
			return append([]byte{tagServerBytes}, bytes...)
		default:
			return nil
		}
	}
}

func (c *serverConn) Send(bytes []byte) error {
	_, err := c.conn.Write(bytes)
	return err
}

func (c *serverConn) UpgradeTLS() ([]byte, error) {
	config := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, //nolint:gosec // the certificate is checked against the fingerprint the user trusted
	}
	if net.ParseIP(c.host) == nil {
		config.ServerName = c.host
	}
	client := tls.Client(c.tcp, config)
	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	defer cancel()
	if err := client.HandshakeContext(ctx); err != nil {
		c.tlsErr = err
		return nil, err
	}
	chain := client.ConnectionState().PeerCertificates
	if len(chain) == 0 {
		c.tlsErr = errors.New("the RDP server sent no certificate")
		return nil, c.tlsErr
	}
	if CertificateFingerprint(chain[0].Raw) != c.fingerprint {
		c.tlsErr = ErrCertificateChanged
		return nil, c.tlsErr
	}
	var info struct {
		Algorithm pkix.AlgorithmIdentifier
		PublicKey asn1.BitString
	}
	if _, err := asn1.Unmarshal(chain[0].RawSubjectPublicKeyInfo, &info); err != nil {
		c.tlsErr = err
		return nil, err
	}
	c.conn = client
	return info.PublicKey.Bytes, nil
}

func (c *serverConn) Event(kind uint32, payload []byte) {
	if kind == eventConnected {
		c.startReader()
	}
	c.onEvent(kind, payload)
}
