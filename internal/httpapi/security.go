package httpapi

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"tessera/internal/store"
)

const (
	securityCSP    = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
	maxRateClients = 10000
)

type SecurityOptions struct {
	TrustedProxies    []netip.Prefix
	RatePerMinute     int
	RateBurst         int
	AuditEnabled      bool
	AuditRetention    time.Duration
	AuditWriteTimeout time.Duration
	// ConnectionLog receives one line for each distinct client identity. It
	// defaults to stdout; tests may supply a buffer.
	ConnectionLog io.Writer
}

type securityHandler struct {
	next            http.Handler
	store           *store.Store
	trustedProxies  []netip.Prefix
	limiter         *clientRateLimiter
	auditRetention  time.Duration
	auditEnabled    bool
	auditTimeout    time.Duration
	connectionLog   *log.Logger
	connectionMu    sync.Mutex
	connections     map[[sha256.Size]byte]struct{}
	fingerprintSalt [sha256.Size]byte
}

type requestSecurity struct {
	clientIP string
	scheme   string
	host     string
}

type requestSecurityKey struct{}

func NewSecurityHandler(next http.Handler, st *store.Store, opts SecurityOptions) http.Handler {
	auditTimeout := opts.AuditWriteTimeout
	if auditTimeout <= 0 {
		auditTimeout = 2 * time.Second
	}
	var limiter *clientRateLimiter
	if opts.RatePerMinute > 0 && opts.RateBurst > 0 {
		limiter = newClientRateLimiter(opts.RatePerMinute, opts.RateBurst)
	}
	connectionLog := opts.ConnectionLog
	if connectionLog == nil {
		connectionLog = os.Stdout
	}
	handler := &securityHandler{
		next:           next,
		store:          st,
		trustedProxies: append([]netip.Prefix(nil), opts.TrustedProxies...),
		limiter:        limiter,
		auditRetention: opts.AuditRetention,
		auditEnabled:   opts.AuditEnabled,
		auditTimeout:   auditTimeout,
		connectionLog:  log.New(connectionLog, "", 0),
		connections:    make(map[[sha256.Size]byte]struct{}),
	}
	_, _ = rand.Read(handler.fingerprintSalt[:])
	return handler
}

// ParseTrustedProxies parses exact IP addresses and CIDR ranges. Proxy trust is
// intentionally based only on the immediate TCP peer; forwarded chains are not
// traversed.
func ParseTrustedProxies(values []string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			prefix, err := netip.ParsePrefix(part)
			if err != nil {
				addr, addrErr := netip.ParseAddr(part)
				if addrErr != nil {
					return nil, fmt.Errorf("invalid trusted proxy %q", part)
				}
				addr = addr.Unmap()
				prefix = netip.PrefixFrom(addr, addr.BitLen())
			} else {
				prefix = prefix.Masked()
			}
			prefixes = append(prefixes, prefix)
		}
	}
	return prefixes, nil
}

func (h *securityHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	requestID := newRequestID()
	w.Header().Set("X-Request-ID", requestID)
	setSecurityHeaders(w.Header())

	tracked := &statusResponseWriter{ResponseWriter: w, status: http.StatusOK}
	info, err := h.effectiveRequest(r)
	if err != nil {
		writeError(tracked, http.StatusBadRequest, "invalid forwarded request metadata")
		h.audit(r, tracked.status, requestID, directClientIP(r.RemoteAddr), started)
		return
	}
	if info.scheme == "https" {
		w.Header().Set("Strict-Transport-Security", "max-age=86400")
	}
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy(info))
	r = r.WithContext(context.WithValue(r.Context(), requestSecurityKey{}, info))
	h.logClientConnection(info.clientIP, r.UserAgent())

	if h.limiter != nil && strings.HasPrefix(r.URL.Path, "/api/") && !h.limiter.allow(info.clientIP, time.Now()) {
		w.Header().Set("Retry-After", "1")
		writeError(tracked, http.StatusTooManyRequests, "rate limit exceeded")
		h.audit(r, tracked.status, requestID, info.clientIP, started)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") && stateChangingMethod(r.Method) && !requestOriginAllowed(r) {
		writeError(tracked, http.StatusForbidden, "request origin is not allowed")
		h.audit(r, tracked.status, requestID, info.clientIP, started)
		return
	}

	h.next.ServeHTTP(tracked, r)
	h.audit(r, tracked.status, requestID, info.clientIP, started)
}

func (h *securityHandler) logClientConnection(clientIP, userAgent string) {
	hash := sha256.New()
	_, _ = hash.Write(h.fingerprintSalt[:])
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(clientIP))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(userAgent))
	var identity [sha256.Size]byte
	copy(identity[:], hash.Sum(nil))

	h.connectionMu.Lock()
	if _, exists := h.connections[identity]; exists {
		h.connectionMu.Unlock()
		return
	}
	h.connections[identity] = struct{}{}
	h.connectionMu.Unlock()
	h.connectionLog.Printf("client connected: ip=%s fingerprint=%s", clientIP, hex.EncodeToString(identity[:6]))
}

func contentSecurityPolicy(info requestSecurity) string {
	origin, err := canonicalOrigin(info.scheme, info.host)
	if err != nil {
		return securityCSP
	}
	websocketOrigin := "ws" + strings.TrimPrefix(origin, "http")
	return strings.Replace(securityCSP, "connect-src 'self'", "connect-src 'self' "+websocketOrigin, 1)
}

func setSecurityHeaders(header http.Header) {
	header.Set("Content-Security-Policy", securityCSP)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()")
}

func stateChangingMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func requestOriginAllowed(r *http.Request) bool {
	values := r.Header.Values("Origin")
	if len(values) == 0 {
		return true
	}
	if len(values) != 1 {
		return false
	}
	info, ok := r.Context().Value(requestSecurityKey{}).(requestSecurity)
	if !ok {
		info = requestSecurity{scheme: requestScheme(r), host: r.Host}
	}
	want, err := canonicalOrigin(info.scheme, info.host)
	if err != nil {
		return false
	}
	origin, err := url.Parse(values[0])
	if err != nil || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		return false
	}
	got, err := canonicalOrigin(origin.Scheme, origin.Host)
	return err == nil && got == want
}

func canonicalOrigin(scheme, authority string) (string, error) {
	scheme = strings.ToLower(strings.TrimSpace(scheme))
	if scheme != "http" && scheme != "https" {
		return "", errors.New("unsupported origin scheme")
	}
	parsed, err := url.Parse(scheme + "://" + authority)
	if err != nil || parsed.User != nil || parsed.Hostname() == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("invalid origin authority")
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if addr, err := netip.ParseAddr(host); err == nil {
		host = addr.Unmap().String()
	}
	port := parsed.Port()
	if port != "" {
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65535 {
			return "", errors.New("invalid origin port")
		}
	}
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host, nil
}

func (h *securityHandler) effectiveRequest(r *http.Request) (requestSecurity, error) {
	peer, err := remoteIP(r.RemoteAddr)
	if err != nil {
		return requestSecurity{}, err
	}
	info := requestSecurity{clientIP: peer.String(), scheme: requestScheme(r), host: r.Host}
	if _, err := canonicalOrigin(info.scheme, info.host); err != nil {
		return requestSecurity{}, err
	}
	if !prefixContains(h.trustedProxies, peer) {
		return info, nil
	}

	forwarded, hasForwarded, err := singleHeader(r.Header, "Forwarded")
	if err != nil {
		return requestSecurity{}, err
	}
	hasXForwarded := hasAnyHeader(r.Header, "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto")
	if hasForwarded && hasXForwarded {
		return requestSecurity{}, errors.New("mixed forwarded header formats")
	}
	if hasForwarded {
		return applyForwarded(info, forwarded)
	}
	if hasXForwarded {
		return applyXForwarded(info, r.Header)
	}
	return info, nil
}

func requestScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func remoteIP(remoteAddr string) (netip.Addr, error) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = strings.Trim(remoteAddr, "[]")
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, errors.New("invalid remote address")
	}
	return addr.Unmap(), nil
}

func directClientIP(remoteAddr string) string {
	addr, err := remoteIP(remoteAddr)
	if err != nil {
		return ""
	}
	return addr.String()
}

func prefixContains(prefixes []netip.Prefix, addr netip.Addr) bool {
	addr = addr.Unmap()
	for _, prefix := range prefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func singleHeader(header http.Header, name string) (string, bool, error) {
	values := header.Values(name)
	if len(values) == 0 {
		return "", false, nil
	}
	if len(values) != 1 || strings.Contains(values[0], ",") || strings.TrimSpace(values[0]) == "" {
		return "", true, errors.New("ambiguous forwarded header")
	}
	return strings.TrimSpace(values[0]), true, nil
}

func hasAnyHeader(header http.Header, names ...string) bool {
	for _, name := range names {
		if len(header.Values(name)) != 0 {
			return true
		}
	}
	return false
}

func applyForwarded(info requestSecurity, value string) (requestSecurity, error) {
	seen := map[string]bool{}
	for _, field := range strings.Split(value, ";") {
		name, raw, ok := strings.Cut(field, "=")
		if !ok {
			return requestSecurity{}, errors.New("invalid Forwarded field")
		}
		name = strings.ToLower(strings.TrimSpace(name))
		raw = strings.TrimSpace(raw)
		if seen[name] {
			return requestSecurity{}, errors.New("duplicate Forwarded field")
		}
		seen[name] = true
		if strings.HasPrefix(raw, "\"") {
			unquoted, err := strconv.Unquote(raw)
			if err != nil {
				return requestSecurity{}, errors.New("invalid quoted Forwarded field")
			}
			raw = unquoted
		}
		switch name {
		case "for":
			addr, err := forwardedClientIP(raw)
			if err != nil {
				return requestSecurity{}, err
			}
			info.clientIP = addr.String()
		case "host":
			if _, err := canonicalOrigin(info.scheme, raw); err != nil {
				return requestSecurity{}, err
			}
			info.host = raw
		case "proto":
			raw = strings.ToLower(raw)
			if raw != "http" && raw != "https" {
				return requestSecurity{}, errors.New("invalid forwarded scheme")
			}
			info.scheme = raw
		case "by":
			// The immediate TCP peer establishes trust; the optional by value is
			// informational and is not used to extend a proxy chain.
		default:
			return requestSecurity{}, errors.New("unsupported Forwarded field")
		}
	}
	if !seen["for"] {
		return requestSecurity{}, errors.New("Forwarded header is missing for")
	}
	if _, err := canonicalOrigin(info.scheme, info.host); err != nil {
		return requestSecurity{}, err
	}
	return info, nil
}

func applyXForwarded(info requestSecurity, header http.Header) (requestSecurity, error) {
	client, ok, err := singleHeader(header, "X-Forwarded-For")
	if err != nil || !ok {
		return requestSecurity{}, errors.New("X-Forwarded-For must contain one address")
	}
	addr, err := forwardedClientIP(client)
	if err != nil {
		return requestSecurity{}, err
	}
	info.clientIP = addr.String()
	if host, ok, err := singleHeader(header, "X-Forwarded-Host"); err != nil {
		return requestSecurity{}, err
	} else if ok {
		info.host = host
	}
	if scheme, ok, err := singleHeader(header, "X-Forwarded-Proto"); err != nil {
		return requestSecurity{}, err
	} else if ok {
		scheme = strings.ToLower(scheme)
		if scheme != "http" && scheme != "https" {
			return requestSecurity{}, errors.New("invalid forwarded scheme")
		}
		info.scheme = scheme
	}
	if _, err := canonicalOrigin(info.scheme, info.host); err != nil {
		return requestSecurity{}, err
	}
	return info, nil
}

func forwardedClientIP(value string) (netip.Addr, error) {
	value = strings.TrimSpace(value)
	if host, _, err := net.SplitHostPort(value); err == nil {
		value = host
	} else {
		value = strings.Trim(value, "[]")
	}
	addr, err := netip.ParseAddr(value)
	if err != nil {
		return netip.Addr{}, errors.New("forwarded client is not an IP address")
	}
	return addr.Unmap(), nil
}

func (h *securityHandler) audit(r *http.Request, status int, requestID, clientIP string, started time.Time) {
	if !h.auditEnabled || h.store == nil || h.auditRetention <= 0 || !auditRequest(r) {
		return
	}
	outcome := "success"
	if status >= 400 {
		outcome = "failure"
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusTooManyRequests {
		outcome = "denied"
	}
	ctx, cancel := context.WithTimeout(context.Background(), h.auditTimeout)
	defer cancel()
	err := h.store.RecordAuditEvent(ctx, store.AuditEvent{
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		RequestID:  requestID,
		ClientIP:   clientIP,
		Method:     r.Method,
		Path:       r.URL.Path,
		Status:     status,
		Outcome:    outcome,
		DurationMS: time.Since(started).Milliseconds(),
	}, h.auditRetention)
	if err != nil {
		log.Printf("write audit event: %v", err)
	}
}

func auditRequest(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/api/") && stateChangingMethod(r.Method) {
		return true
	}
	return r.URL.Path == "/api/terminal" && r.Method == http.MethodGet
}

func newRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(value[:])
}

type statusResponseWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusResponseWriter) Write(value []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(value)
}

func (w *statusResponseWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *statusResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	w.status = http.StatusSwitchingProtocols
	w.wroteHeader = true
	return hijacker.Hijack()
}

func (w *statusResponseWriter) Push(target string, opts *http.PushOptions) error {
	if pusher, ok := w.ResponseWriter.(http.Pusher); ok {
		return pusher.Push(target, opts)
	}
	return http.ErrNotSupported
}

func (w *statusResponseWriter) ReadFrom(reader io.Reader) (int64, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return readerFrom.ReadFrom(reader)
	}
	return io.Copy(w.ResponseWriter, reader)
}

func (w *statusResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

type clientRateLimiter struct {
	mu          sync.Mutex
	rate        float64
	burst       float64
	clients     map[string]*clientBucket
	lastCleanup time.Time
}

type clientBucket struct {
	tokens   float64
	updated  time.Time
	lastSeen time.Time
}

func newClientRateLimiter(ratePerMinute, burst int) *clientRateLimiter {
	return &clientRateLimiter{
		rate:        float64(ratePerMinute) / 60,
		burst:       float64(burst),
		clients:     make(map[string]*clientBucket),
		lastCleanup: time.Now(),
	}
}

func (l *clientRateLimiter) allow(client string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastCleanup) >= time.Minute {
		for key, bucket := range l.clients {
			if now.Sub(bucket.lastSeen) > 10*time.Minute {
				delete(l.clients, key)
			}
		}
		l.lastCleanup = now
	}
	bucket := l.clients[client]
	if bucket == nil {
		if len(l.clients) >= maxRateClients {
			oldestKey := ""
			var oldest time.Time
			for key, candidate := range l.clients {
				if oldestKey == "" || candidate.lastSeen.Before(oldest) {
					oldestKey, oldest = key, candidate.lastSeen
				}
			}
			delete(l.clients, oldestKey)
		}
		bucket = &clientBucket{tokens: l.burst, updated: now, lastSeen: now}
		l.clients[client] = bucket
	}
	elapsed := now.Sub(bucket.updated).Seconds()
	bucket.tokens = min(l.burst, bucket.tokens+elapsed*l.rate)
	bucket.updated = now
	bucket.lastSeen = now
	if bucket.tokens < 1 {
		return false
	}
	bucket.tokens--
	return true
}
