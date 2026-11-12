package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"tessera/internal/store"
)

// Signed-in accounts own trust, even when system sign-in shares a workspace.
// With sign-in off, use the workspace's selected user/profile (or "default").
// A legacy pane approval has no recorded actor. File sign-in restricts panes to
// their owner; system sign-in may share profiles, so it needs a new approval.
func (a *API) rdpTrustOwner(r *http.Request, workspaceID string) (userID string, allowPaneTrust bool, err error) {
	if workspaceID == "" {
		workspaceID = store.DefaultWorkspaceID
	}
	owner, err := a.Store.SessionOwner(r.Context(), workspaceID)
	if errors.Is(err, sql.ErrNoRows) {
		owner, err = workspaceID, nil // Same first-load compatibility as workspaceAllowed.
	}
	if err != nil {
		return "", false, err
	}
	if owner == "" {
		owner = store.DefaultWorkspaceID
	}
	if account := SignedInAccount(r.Context()); account != "" {
		return account, a.authMode(r.Context()) == AuthFile && account == owner, nil
	}
	return owner, true, nil
}

func normalizeRDPFingerprint(raw string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(raw), ":", ""))
}

// Only this explicit approval endpoint writes trust. Probing, logging in and
// connection errors never learn or replace a fingerprint automatically.
func (a *API) rdpTrustCertificate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var request struct {
		WorkspaceID         string `json:"workspaceId"`
		Target              string `json:"target"`
		Fingerprint         string `json:"fingerprint"`
		PreviousFingerprint string `json:"previousFingerprint"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid RDP certificate approval")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid RDP certificate approval")
		return
	}
	if !a.workspaceAllowed(r.Context(), request.WorkspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return
	}
	target, err := normalizeRDPTarget(request.Target)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	fingerprint := normalizeRDPFingerprint(request.Fingerprint)
	previous := normalizeRDPFingerprint(request.PreviousFingerprint)
	if !rdpFingerprintPattern.MatchString(fingerprint) || (previous != "" && !rdpFingerprintPattern.MatchString(previous)) {
		writeError(w, http.StatusBadRequest, "a valid SHA-256 RDP certificate fingerprint is required")
		return
	}
	owner, _, err := a.rdpTrustOwner(r, request.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load RDP certificate trust")
		return
	}
	if err := a.Store.TrustRDPCertificate(r.Context(), owner, target, fingerprint, previous); errors.Is(err, store.ErrRDPCertificateConflict) {
		writeError(w, http.StatusConflict, err.Error())
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "could not remember RDP certificate trust")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"target": target, "fingerprint": fingerprint})
}
