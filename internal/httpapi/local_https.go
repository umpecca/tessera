package httpapi

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"reflect"
	"strings"
	"time"

	"tessera/internal/localhttps"
)

type localHTTPSResponse struct {
	Config        localhttps.Config `json:"config"`
	HasCA         bool              `json:"hasCA"`
	Fingerprint   string            `json:"fingerprint,omitempty"`
	RootName      string            `json:"rootName,omitempty"`
	HTTPSURL      string            `json:"httpsURL,omitempty"`
	EnrollmentURL string            `json:"enrollmentURL,omitempty"`
	HTTPURL       string            `json:"httpURL,omitempty"`
	Restarting    bool              `json:"restarting"`
}

func (a *API) localHTTPSSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		config, err := a.Store.LoadLocalHTTPSConfig(r.Context(), a.HTTPSDefaultAddress)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		a.writeLocalHTTPSResponse(w, config, false)
	case http.MethodPut:
		var requested localhttps.Config
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&requested); err != nil {
			writeError(w, http.StatusBadRequest, "invalid Local HTTPS settings")
			return
		}
		config, err := localhttps.NormalizeConfig(requested)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := localhttps.ValidateSeparateListeners(config, a.HTTPSDefaultAddress); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		current, err := a.Store.LoadLocalHTTPSConfig(r.Context(), a.HTTPSDefaultAddress)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if config.Enabled {
			if _, err := localhttps.Ensure(a.HTTPSPKIDir, config); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		if err := a.Store.SaveLocalHTTPSConfig(r.Context(), config); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		changed := !reflect.DeepEqual(current, config)
		if !a.writeLocalHTTPSResponse(w, config, changed) {
			return
		}
		if changed && a.RequestRestart != nil {
			time.AfterFunc(350*time.Millisecond, func() { a.RequestRestart(current) })
		}
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}

func (a *API) writeLocalHTTPSResponse(w http.ResponseWriter, config localhttps.Config, restarting bool) bool {
	fingerprint, rootName, hasCA, err := localhttps.Status(a.HTTPSPKIDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	response := localHTTPSResponse{
		Config:      config,
		HasCA:       hasCA,
		Fingerprint: fingerprint,
		RootName:    rootName,
		Restarting:  restarting,
		HTTPURL:     localHTTPURL(a.HTTPSDefaultAddress, config),
	}
	if config.Enabled {
		response.HTTPSURL = localhttps.PublicURL(config, config.HTTPSAddress)
		response.EnrollmentURL = strings.TrimSuffix(response.HTTPURL, "/") + "/local-https/"
	}
	writeJSON(w, http.StatusOK, response)
	return true
}

func (a *API) localHTTPSEnrollment(w http.ResponseWriter, r *http.Request) {
	config, err := a.Store.LoadLocalHTTPSConfig(r.Context(), a.HTTPSDefaultAddress)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !config.Enabled {
		http.NotFound(w, r)
		return
	}
	material, err := localhttps.Ensure(a.HTTPSPKIDir, config)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	handler := http.StripPrefix("/local-https", localhttps.EnrollmentHandler(material, localhttps.PublicURL(config, config.HTTPSAddress)))
	handler.ServeHTTP(w, r)
}

func localHTTPURL(address string, config localhttps.Config) string {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return ""
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil && ip.IsUnspecified() {
		if len(config.DNSNames) > 0 {
			host = config.DNSNames[0]
		} else if len(config.IPAddresses) > 0 {
			host = config.IPAddresses[0]
		} else {
			host = "localhost"
		}
	}
	return "http://" + net.JoinHostPort(host, port)
}

func (a *API) localHTTPSRootCertificate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	root, err := localhttps.ReadRootPEM(a.HTTPSPKIDir)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "Local HTTPS has not created a root certificate")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read Local HTTPS root certificate")
		return
	}
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="tessera-local-ca.crt"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(root)
}
