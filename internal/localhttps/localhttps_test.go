package localhttps

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testConfig() Config {
	return Config{
		Enabled:      true,
		HTTPSAddress: "127.0.0.1:7332",
		DNSNames:     []string{"localhost", "tessera.local"},
		IPAddresses:  []string{"127.0.0.1"},
	}
}

func TestNormalizeConfigRejectsInvalidEnabledSettings(t *testing.T) {
	config := testConfig()
	config.DNSNames = []string{"bad name"}
	if _, err := NormalizeConfig(config); err == nil || !strings.Contains(err.Error(), "invalid DNS") {
		t.Fatalf("NormalizeConfig() error = %v", err)
	}
	config = testConfig()
	config.HTTPSAddress = "0.0.0.0:7331"
	if err := ValidateSeparateListeners(config, "127.0.0.1:7331"); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("ValidateSeparateListeners() error = %v", err)
	}
}

func TestMigrateSeparateListenersUsesLegacyEnrollmentPort(t *testing.T) {
	config := testConfig()
	config.HTTPSAddress = "0.0.0.0:7331"
	config.EnrollmentEnabled = true
	config.EnrollmentAddress = "0.0.0.0:7332"
	migrated := MigrateSeparateListeners(config, "0.0.0.0:7331")
	if migrated.HTTPSAddress != "0.0.0.0:7332" || migrated.EnrollmentEnabled || migrated.EnrollmentAddress != "" {
		t.Fatalf("migrated config = %+v", migrated)
	}
}

func TestEnsurePreservesRootAndRenewsLeafForNames(t *testing.T) {
	directory := Dir(t.TempDir())
	config := testConfig()
	first, err := Ensure(directory, config)
	if err != nil {
		t.Fatalf("first Ensure: %v", err)
	}
	firstLeaf, err := x509.ParseCertificate(first.Certificate.Certificate[0])
	if err != nil {
		t.Fatalf("parse first leaf: %v", err)
	}
	config.DNSNames = append(config.DNSNames, "workspace.local")
	second, err := Ensure(directory, config)
	if err != nil {
		t.Fatalf("second Ensure: %v", err)
	}
	secondLeaf, err := x509.ParseCertificate(second.Certificate.Certificate[0])
	if err != nil {
		t.Fatalf("parse second leaf: %v", err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatalf("root fingerprint changed: %q != %q", first.Fingerprint, second.Fingerprint)
	}
	if first.RootName != RootCommonName() {
		t.Fatalf("root name = %q, want %q", first.RootName, RootCommonName())
	}
	if firstLeaf.SerialNumber.Cmp(secondLeaf.SerialNumber) == 0 {
		t.Fatal("server certificate was not renewed after names changed")
	}
	if err := secondLeaf.VerifyHostname("workspace.local"); err != nil {
		t.Fatalf("renewed certificate missing workspace.local: %v", err)
	}
	if runtime.GOOS != "windows" {
		if mode := fileMode(t, filepath.Join(string(directory), rootKeyName)); mode.Perm()&0o077 != 0 {
			t.Fatalf("root key mode = %o, want owner-only", mode.Perm())
		}
	}
}

func TestEnsureRenamesLegacyRootForCurrentHostname(t *testing.T) {
	directory := Dir(t.TempDir())
	config := testConfig()
	if _, err := Ensure(directory, config); err != nil {
		t.Fatal(err)
	}
	keyBlock, _ := pem.Decode(mustRead(t, filepath.Join(string(directory), rootKeyName)))
	if keyBlock == nil {
		t.Fatal("missing root key PEM")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	legacyRoot, legacyPEM, err := createRootCertificate(key, "Tessera Local Root CA")
	if err != nil {
		t.Fatal(err)
	}
	if err := directory.WriteFile(rootCertName, legacyPEM); err != nil {
		t.Fatal(err)
	}
	if err := createServerCertificate(directory, legacyRoot, key, config); err != nil {
		t.Fatal(err)
	}

	material, err := Ensure(directory, config)
	if err != nil {
		t.Fatal(err)
	}
	if material.RootName != RootCommonName() || bytes.Equal(material.RootPEM, legacyPEM) {
		t.Fatalf("migrated root = %q", material.RootName)
	}
	leaf, err := x509.ParseCertificate(material.Certificate.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if leaf.Issuer.CommonName != material.RootName {
		t.Fatalf("leaf issuer = %q, want %q", leaf.Issuer.CommonName, material.RootName)
	}
}

func TestEnsureRegeneratesMissingServerKeyWithoutReplacingRoot(t *testing.T) {
	directory := Dir(t.TempDir())
	first, err := Ensure(directory, testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(string(directory), serverKeyName)); err != nil {
		t.Fatal(err)
	}
	second, err := Ensure(directory, testConfig())
	if err != nil {
		t.Fatalf("Ensure after missing server key: %v", err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatal("missing server key replaced the root CA")
	}
	if _, err := tls.X509KeyPair(mustRead(t, filepath.Join(string(directory), serverCertName)), mustRead(t, filepath.Join(string(directory), serverKeyName))); err != nil {
		t.Fatalf("regenerated key pair: %v", err)
	}
}

func TestEnrollmentHandlerServesOnlyPublicRootAndInstructions(t *testing.T) {
	material, err := Ensure(Dir(t.TempDir()), testConfig())
	if err != nil {
		t.Fatal(err)
	}
	handler := EnrollmentHandler(material, "https://tessera.local:7331")
	rootResponse := httptest.NewRecorder()
	handler.ServeHTTP(rootResponse, httptest.NewRequest(http.MethodGet, "/tessera-local-ca.crt", nil))
	if rootResponse.Code != http.StatusOK || !strings.Contains(rootResponse.Header().Get("Content-Type"), "x-x509-ca-cert") {
		t.Fatalf("root response = %d, %v", rootResponse.Code, rootResponse.Header())
	}
	block, _ := pem.Decode(rootResponse.Body.Bytes())
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatal("enrollment response was not a public certificate")
	}
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(page.Body.String(), material.Fingerprint) ||
		!strings.Contains(page.Body.String(), material.RootName) ||
		!strings.Contains(page.Body.String(), "Certificate Trust Settings") ||
		!strings.Contains(page.Body.String(), "Installing the profile is not enough") ||
		!strings.Contains(page.Body.String(), "Keychain Access") ||
		!strings.Contains(page.Body.String(), "Trusted Root Certification Authorities") {
		t.Fatalf("enrollment page missing fingerprint or instructions: %s", page.Body.String())
	}
	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/root-ca.key", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("private-key path status = %d", missing.Code)
	}
}

func TestEnsureServesRootAfterLeafInTLSChain(t *testing.T) {
	material, err := Ensure(Dir(t.TempDir()), testConfig())
	if err != nil {
		t.Fatal(err)
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{material.Certificate}})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		if conn, err := listener.Accept(); err == nil {
			_ = conn.(*tls.Conn).Handshake()
			_ = conn.Close()
		}
	}()
	conn, err := tls.Dial("tcp", listener.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	peers := conn.ConnectionState().PeerCertificates
	block, _ := pem.Decode(material.RootPEM)
	if len(peers) != 2 || block == nil || !bytes.Equal(peers[1].Raw, block.Bytes) {
		t.Fatalf("presented %d certificates, want leaf then root", len(peers))
	}
	roots := x509.NewCertPool()
	roots.AddCert(peers[1])
	if _, err := peers[0].Verify(x509.VerifyOptions{DNSName: "tessera.local", Roots: roots}); err != nil {
		t.Fatalf("leaf does not verify against presented root: %v", err)
	}
}

func TestRootProfileCarriesTheRootWithFingerprintIdentifiers(t *testing.T) {
	// The iPad app derives the same values (RootCertificateProfileTests).
	identifier, profileUUID, certificateUUID := ProfileIdentifiers([]byte("tessera root"))
	if identifier != "org.tessera.local-https.f6085ea44df860f8" ||
		profileUUID != "F6085EA4-4DF8-80F8-8382-1BC66279299C" || certificateUUID != "B09F7A32-7104-8DBC-8557-9C7737335650" {
		t.Fatalf("identifiers = %s %s %s", identifier, profileUUID, certificateUUID)
	}
	material, err := Ensure(Dir(t.TempDir()), testConfig())
	if err != nil {
		t.Fatal(err)
	}
	profile, err := RootProfile(material.RootPEM)
	if err != nil {
		t.Fatal(err)
	}
	decoder := xml.NewDecoder(bytes.NewReader(profile))
	for {
		if _, err := decoder.Token(); err == io.EOF {
			break
		} else if err != nil {
			t.Fatalf("profile is not well-formed XML: %v", err)
		}
	}
	block, _ := pem.Decode(material.RootPEM)
	identifier, profileUUID, certificateUUID = ProfileIdentifiers(block.Bytes)
	for _, want := range []string{base64.StdEncoding.EncodeToString(block.Bytes), "com.apple.security.root",
		"<string>" + identifier + "</string>", profileUUID, certificateUUID, material.RootName} {
		if !bytes.Contains(profile, []byte(want)) {
			t.Fatalf("profile missing %q:\n%s", want, profile)
		}
	}
	if bytes.Contains(profile, []byte("PRIVATE KEY")) {
		t.Fatal("profile must carry only the public root")
	}
	handler := EnrollmentHandler(material, "https://tessera.local:7332")
	download := httptest.NewRecorder()
	handler.ServeHTTP(download, httptest.NewRequest(http.MethodGet, "/tessera-local-ca.mobileconfig", nil))
	if download.Code != http.StatusOK || download.Header().Get("Content-Type") != "application/x-apple-aspen-config" ||
		!bytes.Equal(download.Body.Bytes(), profile) {
		t.Fatalf("profile download = %d %v", download.Code, download.Header())
	}
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(page.Body.String(), `href="tessera-local-ca.mobileconfig"`) {
		t.Fatal("enrollment page does not link the profile")
	}
}

func fileMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode()
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestImportKeepsTheRootDevicesTrust(t *testing.T) {
	old := Dir(t.TempDir())
	first, err := Ensure(old, testConfig())
	if err != nil {
		t.Fatal(err)
	}
	moved := Dir(t.TempDir())
	if copied, err := Import(old, moved); err != nil || !copied {
		t.Fatalf("import = %v, %v", copied, err)
	}
	second, err := Ensure(moved, testConfig())
	if err != nil || second.Fingerprint != first.Fingerprint {
		t.Fatalf("root changed: %v", err)
	}
	// A root already there is never replaced.
	if copied, err := Import(Dir(t.TempDir()), moved); err != nil || copied {
		t.Fatalf("empty import = %v, %v", copied, err)
	}
	if copied, err := Import(Dir(t.TempDir()), Dir(t.TempDir())); err != nil || copied {
		t.Fatalf("nothing to import = %v, %v", copied, err)
	}
}
