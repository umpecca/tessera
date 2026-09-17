package localhttps

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"html/template"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	rootCertName   = "root-ca.crt"
	rootKeyName    = "root-ca.key"
	serverCertName = "server.crt"
	serverKeyName  = "server.key"
)

type Config struct {
	Enabled      bool     `json:"enabled"`
	HTTPSAddress string   `json:"httpsAddress"`
	DNSNames     []string `json:"dnsNames"`
	IPAddresses  []string `json:"ipAddresses"`
	// Deprecated enrollment fields are retained only to migrate configurations
	// written before the primary HTTP listener became the enrollment path.
	EnrollmentEnabled bool   `json:"enrollmentEnabled,omitempty"`
	EnrollmentAddress string `json:"enrollmentAddress,omitempty"`
}

type Material struct {
	Certificate tls.Certificate
	RootPEM     []byte
	Fingerprint string
	RootName    string
}

func DefaultConfig(address string) Config {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		host, port = "127.0.0.1", "7331"
	}
	hostname, _ := os.Hostname()
	dnsNames := []string{"localhost"}
	if hostname = strings.TrimSpace(strings.ToLower(hostname)); hostname != "" && hostname != "localhost" {
		dnsNames = append([]string{hostname + ".local"}, dnsNames...)
	}
	ipAddresses := []string{"127.0.0.1"}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil && !ip.IsUnspecified() && !ip.IsLoopback() {
		ipAddresses = append([]string{ip.String()}, ipAddresses...)
	} else if ip != nil && ip.IsUnspecified() {
		if addresses, lookupErr := net.InterfaceAddrs(); lookupErr == nil {
			for _, address := range addresses {
				candidate, _, parseErr := net.ParseCIDR(address.String())
				if parseErr == nil && !candidate.IsLoopback() && !candidate.IsLinkLocalUnicast() {
					ipAddresses = appendUnique(ipAddresses, candidate.String())
				}
			}
		}
	}
	httpsPort := "7332"
	if parsed, err := net.LookupPort("tcp", port); err == nil && parsed > 0 && parsed < 65535 {
		httpsPort = fmt.Sprintf("%d", parsed+1)
	} else if port == "0" {
		httpsPort = "0"
	}
	return Config{
		HTTPSAddress: net.JoinHostPort(host, httpsPort),
		DNSNames:     dnsNames,
		IPAddresses:  ipAddresses,
	}
}

func NormalizeConfig(config Config) (Config, error) {
	config.HTTPSAddress = strings.TrimSpace(config.HTTPSAddress)
	config.EnrollmentAddress = strings.TrimSpace(config.EnrollmentAddress)
	config.DNSNames = normalizeStrings(config.DNSNames)
	config.IPAddresses = normalizeStrings(config.IPAddresses)
	for index := range config.DNSNames {
		config.DNSNames[index] = strings.ToLower(config.DNSNames[index])
		if !validDNSName(config.DNSNames[index]) {
			return Config{}, fmt.Errorf("invalid DNS name %q", config.DNSNames[index])
		}
	}
	config.DNSNames = normalizeStrings(config.DNSNames)
	for index, raw := range config.IPAddresses {
		ip := net.ParseIP(strings.Trim(raw, "[]"))
		if ip == nil {
			return Config{}, fmt.Errorf("invalid IP address %q", raw)
		}
		config.IPAddresses[index] = ip.String()
	}
	config.EnrollmentEnabled = false
	config.EnrollmentAddress = ""
	if !config.Enabled {
		return config, nil
	}
	if err := validateListenAddress("HTTPS", config.HTTPSAddress); err != nil {
		return Config{}, err
	}
	if len(config.DNSNames) == 0 && len(config.IPAddresses) == 0 {
		return Config{}, errors.New("at least one DNS name or IP address is required")
	}
	return config, nil
}

// MigrateSeparateListeners converts the original HTTPS/enrollment layout into
// the dual app-listener layout. The old enrollment port is the natural HTTPS
// port, so existing installations move from HTTP-replacing HTTPS on 7331 to
// HTTP on 7331 plus HTTPS on 7332 without replacing their CA.
func MigrateSeparateListeners(config Config, httpAddress string) Config {
	if listenAddressesConflict(config.HTTPSAddress, httpAddress) {
		candidate := strings.TrimSpace(config.EnrollmentAddress)
		if err := validateListenAddress("HTTPS", candidate); err != nil || listenAddressesConflict(candidate, httpAddress) {
			candidate = DefaultConfig(httpAddress).HTTPSAddress
		}
		config.HTTPSAddress = candidate
	}
	config.EnrollmentEnabled = false
	config.EnrollmentAddress = ""
	return config
}

func ValidateSeparateListeners(config Config, httpAddress string) error {
	if config.Enabled && listenAddressesConflict(config.HTTPSAddress, httpAddress) {
		return errors.New("HTTP and HTTPS listener addresses overlap")
	}
	return nil
}

func listenAddressesConflict(left, right string) bool {
	leftHost, leftPort, leftErr := net.SplitHostPort(left)
	rightHost, rightPort, rightErr := net.SplitHostPort(right)
	if leftErr != nil || rightErr != nil || leftPort != rightPort || leftPort == "0" {
		return false
	}
	leftHost = strings.Trim(leftHost, "[]")
	rightHost = strings.Trim(rightHost, "[]")
	if leftHost == rightHost {
		return true
	}
	leftIP := net.ParseIP(leftHost)
	rightIP := net.ParseIP(rightHost)
	return leftHost == "" || rightHost == "" ||
		(leftIP != nil && leftIP.IsUnspecified()) || (rightIP != nil && rightIP.IsUnspecified())
}

func validateListenAddress(label, address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || strings.TrimSpace(port) == "" {
		return fmt.Errorf("%s address must be in host:port form", label)
	}
	if _, err := net.LookupPort("tcp", port); err != nil {
		return fmt.Errorf("%s address has an invalid port", label)
	}
	host = strings.Trim(host, "[]")
	if host != "" && net.ParseIP(host) == nil && !validDNSName(strings.ToLower(host)) {
		return fmt.Errorf("%s address has an invalid host", label)
	}
	return nil
}

func validDNSName(name string) bool {
	if name == "" || len(name) > 253 || strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".") {
		return false
	}
	for _, label := range strings.Split(name, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func normalizeStrings(values []string) []string {
	seen := make(map[string]bool)
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		normalized = append(normalized, value)
	}
	return normalized
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func Ensure(directory string, config Config) (*Material, error) {
	config, err := NormalizeConfig(config)
	if err != nil {
		return nil, err
	}
	if !config.Enabled {
		return nil, errors.New("local HTTPS is disabled")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create PKI directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil && !errors.Is(err, os.ErrPermission) {
		return nil, fmt.Errorf("protect PKI directory: %w", err)
	}

	root, rootKey, rootPEM, err := loadOrCreateRoot(directory)
	if err != nil {
		return nil, err
	}
	if !serverCertificateCurrent(directory, root, config) {
		if err := createServerCertificate(directory, root, rootKey, config); err != nil {
			return nil, err
		}
	}
	certificate, err := tls.LoadX509KeyPair(filepath.Join(directory, serverCertName), filepath.Join(directory, serverKeyName))
	if err != nil {
		return nil, fmt.Errorf("load server certificate: %w", err)
	}
	fingerprint := sha256.Sum256(root.Raw)
	return &Material{
		Certificate: certificate,
		RootPEM:     rootPEM,
		Fingerprint: strings.ToUpper(strings.Join(groupHex(hex.EncodeToString(fingerprint[:])), ":")),
		RootName:    root.Subject.CommonName,
	}, nil
}

func Status(directory string) (fingerprint, rootName string, hasCA bool, err error) {
	data, err := ReadRootPEM(directory)
	if errors.Is(err, os.ErrNotExist) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", "", false, errors.New("Tessera root certificate is invalid")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", "", false, err
	}
	digest := sha256.Sum256(cert.Raw)
	return strings.ToUpper(strings.Join(groupHex(hex.EncodeToString(digest[:])), ":")), cert.Subject.CommonName, true, nil
}

func ReadRootPEM(directory string) ([]byte, error) {
	return os.ReadFile(filepath.Join(directory, rootCertName))
}

func groupHex(value string) []string {
	groups := make([]string, 0, len(value)/2)
	for len(value) >= 2 {
		groups = append(groups, value[:2])
		value = value[2:]
	}
	return groups
}

func loadOrCreateRoot(directory string) (*x509.Certificate, *ecdsa.PrivateKey, []byte, error) {
	certPath := filepath.Join(directory, rootCertName)
	keyPath := filepath.Join(directory, rootKeyName)
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		certBlock, _ := pem.Decode(certPEM)
		keyBlock, _ := pem.Decode(keyPEM)
		if certBlock == nil || keyBlock == nil {
			return nil, nil, nil, errors.New("Tessera root CA files are invalid; restore or explicitly reset them")
		}
		cert, err := x509.ParseCertificate(certBlock.Bytes)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("parse root certificate: %w", err)
		}
		key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("parse root private key: %w", err)
		}
		if cert.Subject.CommonName == RootCommonName() {
			return cert, key, certPEM, nil
		}
		cert, certPEM, err = createRootCertificate(key, RootCommonName())
		if err != nil {
			return nil, nil, nil, err
		}
		if err := writeProtected(certPath, certPEM, 0o644); err != nil {
			return nil, nil, nil, err
		}
		return cert, key, certPEM, nil
	}
	if !errors.Is(certErr, os.ErrNotExist) || !errors.Is(keyErr, os.ErrNotExist) {
		return nil, nil, nil, errors.New("Tessera root CA is incomplete; restore or explicitly reset the PKI directory")
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("generate root key: %w", err)
	}
	cert, certPEM, err := createRootCertificate(key, RootCommonName())
	if err != nil {
		return nil, nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("marshal root key: %w", err)
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := writeProtected(certPath, certPEM, 0o644); err != nil {
		return nil, nil, nil, err
	}
	if err := writeProtected(keyPath, keyPEM, 0o600); err != nil {
		return nil, nil, nil, err
	}
	return cert, key, certPEM, nil
}

func RootCommonName() string {
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "Local"
	}
	return "Tessera " + strings.TrimSpace(hostname) + " Root CA"
}

func createRootCertificate(key *ecdsa.PrivateKey, commonName string) (*x509.Certificate, []byte, error) {
	now := time.Now().UTC()
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: commonName, Organization: []string{"Tessera"}},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(10, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("create root certificate: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, fmt.Errorf("parse generated root certificate: %w", err)
	}
	return cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), nil
}

func serverCertificateCurrent(directory string, root *x509.Certificate, config Config) bool {
	pair, err := tls.LoadX509KeyPair(filepath.Join(directory, serverCertName), filepath.Join(directory, serverKeyName))
	if err != nil {
		return false
	}
	if len(pair.Certificate) == 0 {
		return false
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil || time.Until(cert.NotAfter) < 7*24*time.Hour || cert.CheckSignatureFrom(root) != nil || !bytes.Equal(cert.RawIssuer, root.RawSubject) {
		return false
	}
	dnsNames := append([]string(nil), cert.DNSNames...)
	ipAddresses := make([]string, len(cert.IPAddresses))
	for index, ip := range cert.IPAddresses {
		ipAddresses[index] = ip.String()
	}
	sort.Strings(dnsNames)
	sort.Strings(ipAddresses)
	expectedDNSNames := append([]string(nil), config.DNSNames...)
	expectedIPAddresses := append([]string(nil), config.IPAddresses...)
	sort.Strings(expectedDNSNames)
	sort.Strings(expectedIPAddresses)
	return slicesEqual(dnsNames, expectedDNSNames) && slicesEqual(ipAddresses, expectedIPAddresses)
}

func slicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func createServerCertificate(directory string, root *x509.Certificate, rootKey *ecdsa.PrivateKey, config Config) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate server key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	commonName := "Tessera"
	if len(config.DNSNames) > 0 {
		commonName = config.DNSNames[0]
	} else if len(config.IPAddresses) > 0 {
		commonName = config.IPAddresses[0]
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: commonName, Organization: []string{"Tessera"}},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.AddDate(0, 1, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     append([]string(nil), config.DNSNames...),
	}
	for _, raw := range config.IPAddresses {
		template.IPAddresses = append(template.IPAddresses, net.ParseIP(raw))
	}
	der, err := x509.CreateCertificate(rand.Reader, template, root, &key.PublicKey, rootKey)
	if err != nil {
		return fmt.Errorf("create server certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("marshal server key: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := writeProtected(filepath.Join(directory, serverCertName), certPEM, 0o644); err != nil {
		return err
	}
	return writeProtected(filepath.Join(directory, serverKeyName), keyPEM, 0o600)
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("generate certificate serial: %w", err)
	}
	return serial, nil
}

func writeProtected(path string, data []byte, mode os.FileMode) error {
	if err := os.WriteFile(path, data, mode); err != nil {
		return fmt.Errorf("write %s: %w", filepath.Base(path), err)
	}
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("protect %s: %w", filepath.Base(path), err)
	}
	return nil
}

func PublicURL(config Config, actualAddress string) string {
	_, port, _ := net.SplitHostPort(actualAddress)
	host := "localhost"
	if len(config.DNSNames) > 0 {
		host = config.DNSNames[0]
	} else if len(config.IPAddresses) > 0 {
		host = config.IPAddresses[0]
	}
	if port == "443" {
		return "https://" + host
	}
	return "https://" + net.JoinHostPort(host, port)
}

var enrollmentPage = template.Must(template.New("enrollment").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tessera Local HTTPS</title><style>body{max-width:760px;margin:40px auto;padding:0 20px;font:16px system-ui;line-height:1.5;color:#17202a}code{overflow-wrap:anywhere}a.button{display:inline-block;padding:10px 14px;background:#275dad;color:white;text-decoration:none;border-radius:6px}.platform{margin:18px 0;padding:4px 16px 12px;border:1px solid #ccd3da;border-radius:8px;background:#f8fafb}.platform h2{font-size:18px}.trust{padding:12px;border:2px solid #b86b00;border-radius:6px;background:#fff5df}.fingerprint{font:12px ui-monospace,monospace;overflow-wrap:anywhere;background:#f2f3f4;padding:10px}</style></head>
<body><h1>Set up Tessera Local HTTPS</h1><p>This server's certificate authority is <strong>{{.RootName}}</strong>.</p><p><a class="button" href="tessera-local-ca.crt">Download Tessera CA</a></p><p>Verify this SHA-256 fingerprint before trusting the certificate:</p><p class="fingerprint">{{.Fingerprint}}</p>
<section class="platform"><h2>iPadOS</h2><ol><li>Open the <strong>Settings app</strong>, go to <strong>General → VPN &amp; Device Management</strong>, and install the downloaded profile.</li><li class="trust"><strong>Installing the profile is not enough.</strong> Go to <strong>General → About → Certificate Trust Settings</strong>, turn on full trust for <strong>{{.RootName}}</strong>, and confirm the warning.</li><li>Close the Safari tab, then <a href="{{.HTTPSURL}}">open Tessera over HTTPS</a>.</li></ol></section>
<section class="platform"><h2>macOS</h2><ol><li>Open <strong>Keychain Access</strong> and import the downloaded certificate into the <strong>System</strong> keychain.</li><li>Double-click <strong>{{.RootName}}</strong>, expand <strong>Trust</strong>, and set <strong>When using this certificate</strong> to <strong>Always Trust</strong>.</li><li>Close the certificate window, authenticate when asked, then reopen <a href="{{.HTTPSURL}}">Tessera over HTTPS</a>.</li></ol></section>
<section class="platform"><h2>Windows</h2><ol><li>Open the downloaded certificate and choose <strong>Install Certificate</strong>.</li><li>Select <strong>Current User</strong>, choose <strong>Place all certificates in the following store</strong>, and select <strong>Trusted Root Certification Authorities</strong>.</li><li>Finish the wizard, accept the security warning, then reopen <a href="{{.HTTPSURL}}">Tessera over HTTPS</a>. Firefox installations using their own certificate store may require importing the certificate in Firefox settings too.</li></ol></section></body></html>`))

func EnrollmentHandler(material *Material, httpsURL string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/tessera-local-ca.crt", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="tessera-local-ca.crt"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(material.RootPEM)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_ = enrollmentPage.Execute(w, map[string]string{"HTTPSURL": httpsURL, "Fingerprint": material.Fingerprint, "RootName": material.RootName})
	})
	return mux
}

func ParsePublicURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, errors.New("invalid HTTPS URL")
	}
	return parsed, nil
}
