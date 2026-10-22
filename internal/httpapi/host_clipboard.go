package httpapi

import (
	"errors"
	"io"
	"net/http"
	"time"

	"tessera/internal/hostclipboard"
)

// Swapped by tests, which must not touch the real clipboard.
var (
	detectHostClipboard = hostclipboard.Detect
	writeHostClipboard  = hostclipboard.WriteImage
)

type hostClipboardWrite struct {
	At    time.Time `json:"at"`
	OK    bool      `json:"ok"`
	Error string    `json:"error,omitempty"`
}

type hostClipboardResponse struct {
	hostclipboard.Status
	LastWrite *hostClipboardWrite `json:"lastWrite,omitempty"`
}

// hostClipboard reports (GET) or replaces (POST) the host clipboard. The
// browser posts an image pasted into a terminal; the program running there
// then reads it from the clipboard when the browser sends its paste key.
// Writing never reveals what was on the clipboard before.
func (a *API) hostClipboard(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.writeHostClipboardStatus(w, http.StatusOK)
	case http.MethodPost:
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, hostclipboard.MaxImageBytes+1))
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "image is larger than 32 MiB")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "could not read the image")
			return
		}
		img, err := hostclipboard.ParseImage(data)
		if err != nil {
			writeError(w, http.StatusUnsupportedMediaType, err.Error())
			return
		}
		err = writeHostClipboard(r.Context(), img)
		a.noteHostClipboardWrite(err)
		switch {
		case errors.Is(err, hostclipboard.ErrUnavailable):
			a.writeHostClipboardStatus(w, http.StatusServiceUnavailable)
		case err != nil:
			writeError(w, http.StatusInternalServerError, err.Error())
		default:
			a.writeHostClipboardStatus(w, http.StatusOK)
		}
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
	}
}

func (a *API) noteHostClipboardWrite(err error) {
	result := &hostClipboardWrite{At: time.Now().UTC(), OK: err == nil}
	if err != nil {
		result.Error = err.Error()
	}
	a.hostClipboardMu.Lock()
	a.hostClipboardLast = result
	a.hostClipboardMu.Unlock()
}

func (a *API) writeHostClipboardStatus(w http.ResponseWriter, status int) {
	a.hostClipboardMu.Lock()
	last := a.hostClipboardLast
	a.hostClipboardMu.Unlock()
	writeJSON(w, status, hostClipboardResponse{Status: detectHostClipboard(), LastWrite: last})
}
