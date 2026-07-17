package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"tessera/internal/audio"
)

type audioControlRequest struct {
	Action          string  `json:"action"`
	PositionSeconds float64 `json:"positionSeconds"`
}

func (a *API) audioState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if a.Audio == nil {
		writeError(w, http.StatusServiceUnavailable, "audio manager is not available")
		return
	}
	writeJSON(w, http.StatusOK, a.Audio.State())
}

func (a *API) audioSource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		methodNotAllowed(w, http.MethodPut)
		return
	}
	if a.Audio == nil {
		writeError(w, http.StatusServiceUnavailable, "audio manager is not available")
		return
	}
	var source audio.Source
	if err := json.NewDecoder(r.Body).Decode(&source); err != nil {
		writeError(w, http.StatusBadRequest, "invalid audio source JSON")
		return
	}
	if source.Kind == audio.SourceTerminal && !a.workspaceAllowed(r.Context(), source.WorkspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return
	}
	state, err := a.Audio.SetSource(r.Context(), source)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *API) audioControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if a.Audio == nil {
		writeError(w, http.StatusServiceUnavailable, "audio manager is not available")
		return
	}
	var request audioControlRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid audio control JSON")
		return
	}
	state, err := a.Audio.Control(r.Context(), request.Action, request.PositionSeconds)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *API) audioEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if a.Audio == nil {
		writeError(w, http.StatusServiceUnavailable, "audio manager is not available")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	initial, events, unsubscribe := a.Audio.Subscribe()
	defer unsubscribe()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	writeAudioSSE(w, initial)
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case state, open := <-events:
			if !open {
				return
			}
			writeAudioSSE(w, state)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func writeAudioSSE(w io.Writer, state audio.State) {
	payload, err := json.Marshal(state)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: state\ndata: %s\n\n", payload)
}

func (a *API) audioStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if a.Audio == nil {
		writeError(w, http.StatusServiceUnavailable, "audio manager is not available")
		return
	}
	version, err := strconv.ParseUint(r.URL.Query().Get("sourceVersion"), 10, 64)
	if err != nil || version == 0 {
		writeError(w, http.StatusBadRequest, "sourceVersion is required")
		return
	}
	source, _, err := a.Audio.SourceForStream(version)
	if err != nil {
		status := http.StatusConflict
		if strings.Contains(err.Error(), "not configured") {
			status = http.StatusNotFound
		}
		writeError(w, status, err.Error())
		return
	}
	streamContext, untrack, err := a.Audio.TrackStream(r.Context(), version)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	defer untrack()
	r = r.WithContext(streamContext)

	switch source.Kind {
	case audio.SourceFile:
		a.serveAudioFile(w, r, source)
	case audio.SourceURL:
		a.proxyAudioURL(w, r, source)
	case audio.SourceTerminal:
		a.streamTerminalAudio(w, r, version)
	default:
		writeError(w, http.StatusBadRequest, "unknown audio source")
	}
}

func (a *API) serveAudioFile(w http.ResponseWriter, r *http.Request, source audio.Source) {
	file, err := os.Open(source.Value)
	if err != nil {
		writeError(w, http.StatusNotFound, "audio file is unavailable")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeError(w, http.StatusNotFound, "audio file is unavailable")
		return
	}
	w.Header().Set("Content-Type", audio.MIMEType(source.Value))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func (a *API) proxyAudioURL(w http.ResponseWriter, r *http.Request, source audio.Source) {
	request, err := http.NewRequestWithContext(r.Context(), r.Method, source.Value, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "invalid upstream audio URL")
		return
	}
	if value := r.Header.Get("Range"); value != "" {
		request.Header.Set("Range", value)
	}
	request.Header.Set("User-Agent", "tessera-audio-proxy")

	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		transport = &http.Transport{Proxy: http.ProxyFromEnvironment}
	} else {
		transport = transport.Clone()
	}
	transport.ResponseHeaderTimeout = 15 * time.Second
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= 8 {
				return errors.New("too many audio redirects")
			}
			if next.URL.User != nil || (next.URL.Scheme != "http" && next.URL.Scheme != "https") {
				return errors.New("audio redirect is not allowed")
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, net.ErrClosed) {
			return
		}
		writeError(w, http.StatusBadGateway, "upstream audio is unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeError(w, http.StatusBadGateway, "upstream audio returned "+response.Status)
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if contentType == "application/vnd.apple.mpegurl" || contentType == "application/x-mpegurl" {
		writeError(w, http.StatusUnsupportedMediaType, "HLS playlists are not supported")
		return
	}
	for _, name := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	for name, values := range response.Header {
		if strings.HasPrefix(strings.ToLower(name), "icy-") {
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(response.StatusCode)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, response.Body)
}

func (a *API) streamTerminalAudio(w http.ResponseWriter, r *http.Request, version uint64) {
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.WriteHeader(http.StatusOK)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	replay, chunks, unsubscribe, err := a.Audio.SubscribeStream(version)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	defer unsubscribe()
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if len(replay) > 0 {
		if _, err := w.Write(replay); err != nil {
			return
		}
		flusher.Flush()
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case chunk, open := <-chunks:
			if !open {
				return
			}
			if _, err := w.Write(chunk); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
