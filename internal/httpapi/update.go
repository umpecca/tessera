package httpapi

import (
	"net/http"

	"tessera/internal/version"
)

// selfUpdate serves GET /api/update (check for a newer release) and
// POST /api/update (download, swap the executable, then restart). The restart
// is signalled after the response is written so the client receives it.
func (a *API) selfUpdate(w http.ResponseWriter, r *http.Request) {
	if a.Updater == nil {
		writeError(w, http.StatusNotFound, "self-update not available")
		return
	}
	switch r.Method {
	case http.MethodGet:
		result, err := a.Updater.Check(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, result)
	case http.MethodPost:
		result, err := a.Updater.Apply(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		if !result.UpdateAvailable {
			writeJSON(w, http.StatusOK, map[string]any{
				"status":         "up-to-date",
				"currentVersion": version.Version,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":         "restarting",
			"currentVersion": result.CurrentVersion,
			"latestVersion":  result.LatestVersion,
		})
		// Put the restart acknowledgement on the wire before main begins a
		// graceful shutdown. The client can still recover from a lost response,
		// but flushing makes that the exceptional path.
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		a.Updater.RequestRestart()
	default:
		methodNotAllowed(w, "GET, POST")
	}
}
