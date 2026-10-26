package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"tessera/internal/store"
)

// userSnippets serves GET and PUT /api/users/{user}/snippets, the text an
// account keeps to send to terminals from the phone view. A PUT carries
// the revision it replaces and is refused with 409 if another browser saved
// since.
func (a *API) userSnippets(w http.ResponseWriter, r *http.Request, userID, id, action string) {
	if id != "" || action != "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		doc, err := a.Store.LoadSnippets(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, doc)
	case http.MethodPut:
		var doc store.Snippets
		r.Body = http.MaxBytesReader(w, r.Body, 4*1024*1024)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&doc); err != nil {
			writeError(w, http.StatusBadRequest, "invalid or oversized snippets JSON")
			return
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			writeError(w, http.StatusBadRequest, "unexpected trailing JSON")
			return
		}
		if err := a.Store.SaveSnippets(r.Context(), userID, &doc); errors.Is(err, store.ErrSnippetsConflict) {
			writeError(w, http.StatusConflict, err.Error())
			return
		} else if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, doc)
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}
