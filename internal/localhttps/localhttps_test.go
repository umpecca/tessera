package localhttps

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
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
	directory := t.TempDir()
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
		if mode := fileMode(t, filepath.Join(directory, rootKeyName)); mode.Perm()&0o077 != 0 {
			t.Fatalf("root key mode = %o, want owner-only", mode.Perm())
		}
	}
}

func TestEnsureRenamesLegacyRootForCurrentHostname(t *testing.T) {
	directory := t.TempDir()
	config := testConfig()
	if _, err := Ensure(directory, config); err != nil {
		t.Fatal(err)
	}
	keyBlock, _ := pem.Decode(mustRead(t, filepath.Join(directory, rootKeyName)))
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
	if err := writeProtected(filepath.Join(directory, rootCertName), legacyPEM, 0o644); err != nil {
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
	directory := t.TempDir()
	first, err := Ensure(directory, testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(directory, serverKeyName)); err != nil {
		t.Fatal(err)
	}
	second, err := Ensure(directory, testConfig())
	if err != nil {
		t.Fatalf("Ensure after missing server key: %v", err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatal("missing server key replaced the root CA")
	}
	if _, err := tls.X509KeyPair(mustRead(t, filepath.Join(directory, serverCertName)), mustRead(t, filepath.Join(directory, serverKeyName))); err != nil {
		t.Fatalf("regenerated key pair: %v", err)
	}
}

func TestEnrollmentHandlerServesOnlyPublicRootAndInstructions(t *testing.T) {
	material, err := Ensure(t.TempDir(), testConfig())
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
