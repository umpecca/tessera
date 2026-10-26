package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"tessera/internal/terminal"
)

// terminalSummaryWait is the longest a request holding a version waits for
// the summaries to change, and terminalSummaryPoll how often it looks.
var terminalSummaryWait = 25 * time.Second
var terminalSummaryPoll = time.Second

type terminalSummaries struct {
	Version   string             `json:"version"`
	Home      string             `json:"home,omitempty"`
	Terminals []terminal.Summary `json:"terminals"`
}

// workspaceTerminals serves GET /api/workspace/{id}/terminals: what each of
// the workspace's running shells is doing, for the phone view's list. A
// request with ?version= answers when the summaries differ from that
// version, or after terminalSummaryWait with the same one, so a phone keeps
// one request open instead of polling or attaching to every terminal.
func (a *API) workspaceTerminals(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if a.Terminals == nil {
		writeError(w, http.StatusInternalServerError, "terminal manager is not available")
		return
	}
	home, _ := os.UserHomeDir()
	since := r.URL.Query().Get("version")
	deadline := time.Now().Add(terminalSummaryWait)
	for {
		summaries := a.Terminals.Summaries(id)
		version := terminalSummaryVersion(summaries)
		if since == "" || version != since || !time.Now().Before(deadline) {
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, http.StatusOK, terminalSummaries{Version: version, Home: home, Terminals: summaries})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(terminalSummaryPoll):
		}
	}
}

// terminalSummaryVersion names what the summaries say, leaving out the
// clocks that move every second: the phone counts those itself.
func terminalSummaryVersion(summaries []terminal.Summary) string {
	steady := make([]terminal.Summary, len(summaries))
	for i, summary := range summaries {
		summary.RunningSeconds = 0
		summary.OutputSecondsAgo = min(summary.OutputSecondsAgo, 0)
		steady[i] = summary
	}
	data, _ := json.Marshal(steady)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}
