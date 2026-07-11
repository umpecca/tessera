package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tessera/internal/store"
)

func (a *API) userResources(w http.ResponseWriter, r *http.Request) {
	userID, resource, id, action, ok := parseUserResourcePath(r.URL.Path)
	if !ok || !a.userAllowed(userID) {
		writeError(w, http.StatusNotFound, "unknown user")
		return
	}
	switch resource {
	case "sessions":
		a.sessions(w, r, userID, id, action)
	case "settings":
		if id != "" || action != "" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		a.userSettings(w, r, userID)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func parseUserResourcePath(path string) (userID, resource, id, action string, ok bool) {
	rest := strings.Trim(strings.TrimPrefix(path, "/api/users/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) < 2 || len(parts) > 4 {
		return "", "", "", "", false
	}
	decoded := make([]string, len(parts))
	for i, part := range parts {
		value, err := url.PathUnescape(part)
		if err != nil || value == "" || strings.ContainsAny(value, "/\\") {
			return "", "", "", "", false
		}
		decoded[i] = value
	}
	userID, resource = decoded[0], decoded[1]
	if len(decoded) > 2 {
		id = decoded[2]
	}
	if len(decoded) > 3 {
		action = decoded[3]
	}
	return userID, resource, id, action, true
}

func (a *API) sessions(w http.ResponseWriter, r *http.Request, userID, sessionID, action string) {
	if action != "" {
		if action != "activate" || sessionID == "" || r.Method != http.MethodPost {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		if err := a.Store.ActivateSession(r.Context(), userID, sessionID); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if sessionID == "" {
		switch r.Method {
		case http.MethodGet:
			if _, err := a.Store.EnsureUserDefaultSession(r.Context(), userID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			sessions, err := a.Store.ListSessions(r.Context(), userID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
		case http.MethodPost:
			var request struct {
				Name string `json:"name"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				writeError(w, http.StatusBadRequest, "invalid session JSON")
				return
			}
			session, err := a.Store.CreateSession(r.Context(), userID, request.Name)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, session)
		default:
			methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
		}
		return
	}

	switch r.Method {
	case http.MethodPatch:
		var request struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid session JSON")
			return
		}
		session, err := a.Store.RenameSession(r.Context(), userID, sessionID, request.Name)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, session)
	case http.MethodDelete:
		if _, err := a.Store.Session(r.Context(), userID, sessionID); err != nil {
			writeStoreError(w, err)
			return
		}
		existing, err := a.Store.ListSessions(r.Context(), userID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if len(existing) <= 1 {
			writeStoreError(w, store.ErrLastSession)
			return
		}
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if a.Terminals != nil {
			a.Terminals.TerminateWorkspace(sessionID)
		}
		if a.Runs != nil {
			if err := a.Runs.StopWorkspace(stopCtx, sessionID); err != nil {
				writeError(w, http.StatusConflict, "session processes did not stop")
				return
			}
		}
		if err := a.Store.DeleteSession(stopCtx, userID, sessionID); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w, http.MethodPatch+", "+http.MethodDelete)
	}
}

func (a *API) userSettings(w http.ResponseWriter, r *http.Request, userID string) {
	switch r.Method {
	case http.MethodGet:
		settings, err := a.Store.LoadUserSettings(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, settings)
	case http.MethodPut:
		var settings store.UserSettings
		if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
			writeError(w, http.StatusBadRequest, "invalid settings JSON")
			return
		}
		settings.UserID = userID
		if err := a.Store.SaveUserSettings(r.Context(), &settings); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, settings)
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, http.StatusNotFound, "session not found")
	case errors.Is(err, store.ErrInvalidSessionName), errors.Is(err, store.ErrSessionNameExists):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, store.ErrLastSession):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
