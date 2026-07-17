// Package audio owns Tessera's one host-wide audio station.
package audio

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"tessera/internal/store"
)

const (
	StatusStopped = "stopped"
	StatusPaused  = "paused"
	StatusPlaying = "playing"

	SourceFile     = "file"
	SourceURL      = "url"
	SourceTerminal = "terminal"

	streamReplayLimit = 256 * 1024
)

type Source struct {
	Kind        string `json:"kind"`
	Value       string `json:"value,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	PaneID      string `json:"paneId,omitempty"`
	Label       string `json:"label"`
}

type State struct {
	Source           *Source `json:"source"`
	Status           string  `json:"status"`
	PositionSeconds  float64 `json:"positionSeconds"`
	StartedAt        string  `json:"startedAt,omitempty"`
	Seekable         bool    `json:"seekable"`
	SourceVersion    uint64  `json:"sourceVersion"`
	StateVersion     uint64  `json:"stateVersion"`
	Error            string  `json:"error,omitempty"`
	Warning          string  `json:"warning,omitempty"`
	CaptureAvailable bool    `json:"captureAvailable"`
	CaptureError     string  `json:"captureError,omitempty"`
}

type Options struct {
	CaptureHelper string
	Encoder       string
	ReadyTimeout  time.Duration
	Now           func() time.Time
	EnsureEncoder func(context.Context) error
	captureArgs   []string
	encoderArgs   []string
	captureEnv    []string
	encoderEnv    []string
}

type terminalProcesses interface {
	ProcessID(workspaceID, paneID string) (int, bool)
	SetCloseHandler(func(workspaceID, paneID string))
}

type Manager struct {
	mu        sync.Mutex
	store     *store.Store
	terminals terminalProcesses
	opts      Options

	state     State
	startedAt time.Time
	closed    bool

	subscribers       map[chan State]struct{}
	streamSubscribers map[chan []byte]struct{}
	streamReplay      []byte
	streamCancels     map[uint64]context.CancelFunc
	nextStreamID      uint64

	pipelineCancel context.CancelFunc
	pipelineDone   <-chan struct{}
	pipelineID     uint64
}

func NewManager(st *store.Store, terminals terminalProcesses, opts Options) *Manager {
	if opts.ReadyTimeout <= 0 {
		opts.ReadyTimeout = 10 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	m := &Manager{
		store:             st,
		terminals:         terminals,
		opts:              opts,
		subscribers:       map[chan State]struct{}{},
		streamSubscribers: map[chan []byte]struct{}{},
		streamCancels:     map[uint64]context.CancelFunc{},
		state:             State{Status: StatusStopped},
	}
	if st != nil {
		persisted, err := st.LoadAudioStation(context.Background())
		if err != nil {
			m.state.Error = err.Error()
		} else {
			m.state.SourceVersion = persisted.SourceVersion
			m.state.StateVersion = persisted.StateVersion
			m.state.PositionSeconds = max(0, persisted.PositionSeconds)
			if persisted.SourceKind != "" {
				source := Source{
					Kind:        persisted.SourceKind,
					Value:       persisted.SourceValue,
					WorkspaceID: persisted.WorkspaceID,
					PaneID:      persisted.PaneID,
				}
				source.Label = sourceLabel(source)
				m.state.Source = &source
				m.state.Status = StatusPaused
				m.state.Seekable = source.Kind == SourceFile
			}
		}
	}
	if terminals != nil {
		terminals.SetCloseHandler(m.TerminalClosed)
	}
	return m
}

func (m *Manager) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager) SetSource(ctx context.Context, source Source) (State, error) {
	source, err := m.validateSource(source)
	if err != nil {
		return State{}, err
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return State{}, errors.New("audio manager is closed")
	}
	m.stopPipelineLocked()
	m.stopSourceStreamsLocked()
	m.state.SourceVersion++
	m.state.StateVersion++
	m.state.Source = &source
	m.state.Status = StatusPaused
	m.state.PositionSeconds = 0
	m.state.Seekable = source.Kind == SourceFile
	m.state.Error = ""
	m.state.Warning = ""
	m.startedAt = time.Time{}
	m.persistLocked(ctx)
	state := m.snapshotLocked()
	m.broadcastLocked(state)
	m.mu.Unlock()
	return state, nil
}

func (m *Manager) Control(ctx context.Context, action string, positionSeconds float64) (State, error) {
	action = strings.ToLower(strings.TrimSpace(action))
	if action == "play" {
		return m.play(ctx)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return State{}, errors.New("audio manager is closed")
	}
	if m.state.Source == nil {
		return State{}, errors.New("audio source is not configured")
	}

	switch action {
	case "pause":
		m.freezePositionLocked()
		m.state.Status = StatusPaused
		m.startedAt = time.Time{}
		m.stopPipelineLocked()
	case "stop":
		m.state.Status = StatusStopped
		m.state.PositionSeconds = 0
		m.startedAt = time.Time{}
		m.stopPipelineLocked()
	case "seek":
		if !m.state.Seekable {
			return State{}, errors.New("audio source is not seekable")
		}
		if positionSeconds < 0 {
			return State{}, errors.New("positionSeconds must not be negative")
		}
		m.state.PositionSeconds = positionSeconds
		if m.state.Status == StatusPlaying {
			m.startedAt = m.opts.Now()
		}
	default:
		return State{}, fmt.Errorf("unknown audio action %q", action)
	}
	m.state.StateVersion++
	m.state.Error = ""
	m.state.Warning = ""
	m.persistLocked(ctx)
	state := m.snapshotLocked()
	m.broadcastLocked(state)
	return state, nil
}

func (m *Manager) play(ctx context.Context) (State, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return State{}, errors.New("audio manager is closed")
	}
	if m.state.Source == nil {
		m.mu.Unlock()
		return State{}, errors.New("audio source is not configured")
	}
	if m.state.Status == StatusPlaying {
		state := m.snapshotLocked()
		m.mu.Unlock()
		return state, nil
	}
	source := *m.state.Source
	version := m.state.SourceVersion
	m.mu.Unlock()

	if source.Kind == SourceTerminal {
		if err := m.startTerminalCapture(source, version); err != nil {
			m.mu.Lock()
			if m.state.SourceVersion == version {
				m.state.Error = err.Error()
				m.state.Status = StatusPaused
				m.state.StateVersion++
				m.persistLocked(ctx)
				state := m.snapshotLocked()
				m.broadcastLocked(state)
			}
			m.mu.Unlock()
			return State{}, err
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.state.SourceVersion != version {
		m.stopPipelineLocked()
		return State{}, errors.New("audio source changed while starting")
	}
	if m.state.Status != StatusPlaying {
		m.state.Status = StatusPlaying
		if m.state.Seekable {
			m.startedAt = m.opts.Now()
		}
		m.state.StateVersion++
		m.state.Error = ""
		m.state.Warning = ""
		m.persistLocked(ctx)
	}
	state := m.snapshotLocked()
	m.broadcastLocked(state)
	return state, nil
}

func (m *Manager) validateSource(source Source) (Source, error) {
	source.Kind = strings.ToLower(strings.TrimSpace(source.Kind))
	source.Value = strings.TrimSpace(source.Value)
	source.WorkspaceID = strings.TrimSpace(source.WorkspaceID)
	source.PaneID = strings.TrimSpace(source.PaneID)
	source.Label = strings.TrimSpace(source.Label)

	switch source.Kind {
	case SourceFile:
		if !filepath.IsAbs(source.Value) {
			return Source{}, errors.New("audio file path must be absolute")
		}
		info, err := os.Stat(source.Value)
		if err != nil {
			return Source{}, fmt.Errorf("open audio file: %w", err)
		}
		if !info.Mode().IsRegular() {
			return Source{}, errors.New("audio file must be a regular file")
		}
		if MIMEType(source.Value) == "" {
			return Source{}, errors.New("audio file type is not supported")
		}
		source.Value = filepath.Clean(source.Value)
	case SourceURL:
		parsed, err := url.Parse(source.Value)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return Source{}, errors.New("audio URL must use http or https")
		}
		if parsed.User != nil {
			return Source{}, errors.New("authenticated audio URLs are not supported")
		}
		if strings.EqualFold(filepath.Ext(parsed.Path), ".m3u8") {
			return Source{}, errors.New("HLS playlists are not supported")
		}
		source.Value = parsed.String()
	case SourceTerminal:
		if source.WorkspaceID == "" || source.PaneID == "" {
			return Source{}, errors.New("workspaceId and paneId are required for terminal audio")
		}
		if m.terminals == nil {
			return Source{}, errors.New("terminal manager is not available")
		}
		if _, ok := m.terminals.ProcessID(source.WorkspaceID, source.PaneID); !ok {
			return Source{}, errors.New("Terminal is not running")
		}
	default:
		return Source{}, errors.New("audio source kind must be file, url, or terminal")
	}
	if source.Label == "" {
		source.Label = sourceLabel(source)
	}
	return source, nil
}

func MIMEType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	case ".wav":
		return "audio/wav"
	case ".ogg", ".oga", ".opus":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	default:
		return ""
	}
}

func sourceLabel(source Source) string {
	switch source.Kind {
	case SourceFile:
		return filepath.Base(source.Value)
	case SourceURL:
		parsed, err := url.Parse(source.Value)
		if err == nil {
			name := filepath.Base(parsed.Path)
			if name != "." && name != "/" && name != "" {
				return name
			}
			return parsed.Host
		}
		return source.Value
	case SourceTerminal:
		return "Terminal " + source.PaneID
	default:
		return "Audio"
	}
}

func (m *Manager) SourceForStream(version uint64) (Source, State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.Source == nil {
		return Source{}, State{}, errors.New("audio source is not configured")
	}
	if version != 0 && version != m.state.SourceVersion {
		return Source{}, State{}, errors.New("audio source version is stale")
	}
	return *m.state.Source, m.snapshotLocked(), nil
}

// TrackStream ties an HTTP listener to the selected source version. Replacing
// the source cancels every old proxy/file/live response before the new state
// is published.
func (m *Manager) TrackStream(parent context.Context, version uint64) (context.Context, func(), error) {
	m.mu.Lock()
	if m.closed || m.state.Source == nil || version != m.state.SourceVersion {
		m.mu.Unlock()
		return nil, nil, errors.New("audio source version is stale")
	}
	ctx, cancel := context.WithCancel(parent)
	m.nextStreamID++
	id := m.nextStreamID
	m.streamCancels[id] = cancel
	m.mu.Unlock()
	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			cancel()
			m.mu.Lock()
			delete(m.streamCancels, id)
			m.mu.Unlock()
		})
	}, nil
}

func (m *Manager) Subscribe() (State, <-chan State, func()) {
	ch := make(chan State, 8)
	m.mu.Lock()
	initial := m.snapshotLocked()
	if m.closed {
		close(ch)
		m.mu.Unlock()
		return initial, ch, func() {}
	}
	m.subscribers[ch] = struct{}{}
	m.mu.Unlock()
	var once sync.Once
	return initial, ch, func() {
		once.Do(func() {
			m.mu.Lock()
			if _, ok := m.subscribers[ch]; ok {
				delete(m.subscribers, ch)
				close(ch)
			}
			m.mu.Unlock()
		})
	}
}

func (m *Manager) SubscribeStream(version uint64) ([]byte, <-chan []byte, func(), error) {
	ch := make(chan []byte, 64)
	m.mu.Lock()
	if m.closed || m.state.Source == nil || m.state.Source.Kind != SourceTerminal {
		m.mu.Unlock()
		return nil, nil, nil, errors.New("terminal audio is not configured")
	}
	if version != m.state.SourceVersion {
		m.mu.Unlock()
		return nil, nil, nil, errors.New("audio source version is stale")
	}
	if m.state.Status != StatusPlaying || m.pipelineCancel == nil {
		m.mu.Unlock()
		return nil, nil, nil, errors.New("terminal audio is not playing")
	}
	replay := append([]byte(nil), m.streamReplay...)
	m.streamSubscribers[ch] = struct{}{}
	m.mu.Unlock()
	var once sync.Once
	return replay, ch, func() {
		once.Do(func() {
			m.mu.Lock()
			if _, ok := m.streamSubscribers[ch]; ok {
				delete(m.streamSubscribers, ch)
				close(ch)
			}
			m.mu.Unlock()
		})
	}, nil
}

func (m *Manager) TerminalClosed(workspaceID, paneID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.Source == nil || m.state.Source.Kind != SourceTerminal ||
		m.state.Source.WorkspaceID != workspaceID || m.state.Source.PaneID != paneID {
		return
	}
	m.stopPipelineLocked()
	m.state.Status = StatusPaused
	m.state.Error = "Terminal is not running"
	m.state.Warning = ""
	m.state.StateVersion++
	m.persistLocked(context.Background())
	state := m.snapshotLocked()
	m.broadcastLocked(state)
}

func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	m.stopPipelineLocked()
	m.stopSourceStreamsLocked()
	for ch := range m.subscribers {
		close(ch)
		delete(m.subscribers, ch)
	}
	m.mu.Unlock()
}

// StopForUpdate quiesces a live terminal pipeline before its encoder sidecar
// is replaced. File and URL listeners are unaffected.
func (m *Manager) StopForUpdate() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pipelineCancel == nil {
		return nil
	}
	m.stopPipelineLocked()
	m.state.Status = StatusPaused
	m.state.Error = "Capture stopped for server update"
	m.state.Warning = ""
	m.state.StateVersion++
	m.persistLocked(context.Background())
	state := m.snapshotLocked()
	m.broadcastLocked(state)
	return nil
}

func (m *Manager) snapshotLocked() State {
	state := m.state
	if state.Source != nil {
		copySource := *state.Source
		state.Source = &copySource
	}
	if state.Seekable && state.Status == StatusPlaying && !m.startedAt.IsZero() {
		state.PositionSeconds += max(0, m.opts.Now().Sub(m.startedAt).Seconds())
		state.StartedAt = m.startedAt.UTC().Format(time.RFC3339Nano)
	} else {
		state.StartedAt = ""
	}
	available, reason := m.captureCapability()
	state.CaptureAvailable = available
	state.CaptureError = reason
	return state
}

func (m *Manager) freezePositionLocked() {
	if m.state.Seekable && m.state.Status == StatusPlaying && !m.startedAt.IsZero() {
		m.state.PositionSeconds += max(0, m.opts.Now().Sub(m.startedAt).Seconds())
	}
}

func (m *Manager) persistLocked(ctx context.Context) {
	if m.store == nil {
		return
	}
	if ctx == nil || ctx.Err() != nil {
		ctx = context.Background()
	}
	station := store.AudioStation{
		PositionSeconds: m.state.PositionSeconds,
		SourceVersion:   m.state.SourceVersion,
		StateVersion:    m.state.StateVersion,
	}
	if m.state.Source != nil {
		station.SourceKind = m.state.Source.Kind
		station.SourceValue = m.state.Source.Value
		station.WorkspaceID = m.state.Source.WorkspaceID
		station.PaneID = m.state.Source.PaneID
	}
	if err := m.store.SaveAudioStation(ctx, station); err != nil {
		m.state.Error = err.Error()
	}
}

func (m *Manager) broadcastLocked(state State) {
	for ch := range m.subscribers {
		select {
		case ch <- state:
		default:
		}
	}
}

func (m *Manager) publishStream(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pipelineCancel == nil || m.closed {
		return
	}
	m.streamReplay = append(m.streamReplay, chunk...)
	if len(m.streamReplay) > streamReplayLimit {
		m.streamReplay = append([]byte(nil), m.streamReplay[len(m.streamReplay)-streamReplayLimit:]...)
	}
	for ch := range m.streamSubscribers {
		copyChunk := append([]byte(nil), chunk...)
		select {
		case ch <- copyChunk:
		default:
			delete(m.streamSubscribers, ch)
			close(ch)
		}
	}
}

func (m *Manager) stopPipelineLocked() {
	done := m.pipelineDone
	if m.pipelineCancel != nil {
		m.pipelineCancel()
		m.pipelineCancel = nil
	}
	m.pipelineDone = nil
	m.pipelineID++
	m.streamReplay = nil
	for ch := range m.streamSubscribers {
		close(ch)
		delete(m.streamSubscribers, ch)
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(3 * time.Second):
		}
	}
}

func (m *Manager) stopSourceStreamsLocked() {
	for id, cancel := range m.streamCancels {
		cancel()
		delete(m.streamCancels, id)
	}
}

type processResult struct {
	done chan struct{}
	err  error
}

func waitProcess(cmd *exec.Cmd) *processResult {
	result := &processResult{done: make(chan struct{})}
	go func() {
		result.err = cmd.Wait()
		close(result.done)
	}()
	return result
}

type helperEvent struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func (m *Manager) startTerminalCapture(source Source, version uint64) error {
	if m.terminals == nil {
		return errors.New("terminal manager is not available")
	}
	pid, ok := m.terminals.ProcessID(source.WorkspaceID, source.PaneID)
	if !ok {
		return errors.New("Terminal is not running")
	}
	helperPath, encoderPath, err := m.captureTools()
	if err != nil && m.opts.Encoder == "" && m.opts.EnsureEncoder != nil && err.Error() == "Encoder unavailable" {
		if ensureErr := m.opts.EnsureEncoder(context.Background()); ensureErr == nil {
			helperPath, encoderPath, err = m.captureTools()
		} else {
			return fmt.Errorf("Encoder unavailable: %w", ensureErr)
		}
	}
	if err != nil {
		return err
	}

	pipelineCtx, cancel := context.WithCancel(context.Background())
	helperArgs := append(append([]string(nil), m.opts.captureArgs...),
		"capture",
		"--pid", fmt.Sprintf("%d", pid),
		"--include-tree",
		"--format", "s16le",
		"--sample-rate", "48000",
		"--channels", "2",
	)
	helper := exec.Command(helperPath, helperArgs...)
	helper.Env = append(os.Environ(), m.opts.captureEnv...)
	helperOut, err := helper.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("capture helper stdout: %w", err)
	}
	helperErr, err := helper.StderrPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("capture helper stderr: %w", err)
	}

	encoderArgs := append(append([]string(nil), m.opts.encoderArgs...),
		"--silent", "-r", "--signed", "--little-endian",
		"-s", "48", "--bitwidth", "16", "-m", "j", "-b", "192", "-", "-",
	)
	encoder := exec.Command(encoderPath, encoderArgs...)
	encoder.Env = append(os.Environ(), m.opts.encoderEnv...)
	encoder.Stdin = helperOut
	encoderOut, err := encoder.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("encoder stdout: %w", err)
	}
	encoderErr, err := encoder.StderrPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("encoder stderr: %w", err)
	}

	ready := make(chan struct{}, 1)
	readyError := make(chan error, 1)
	warnings := make(chan string, 8)
	go func() {
		scanner := bufio.NewScanner(helperErr)
		for scanner.Scan() {
			var event helperEvent
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				continue
			}
			switch event.Type {
			case "ready":
				select {
				case ready <- struct{}{}:
				default:
				}
			case "error":
				message := strings.TrimSpace(event.Message)
				if message == "" {
					message = "capture helper failed"
				}
				select {
				case readyError <- errors.New(message):
				default:
				}
			case "warning":
				if message := strings.TrimSpace(event.Message); message != "" {
					select {
					case warnings <- message:
					default:
					}
				}
			}
		}
	}()
	go io.Copy(io.Discard, encoderErr)

	if err := helper.Start(); err != nil {
		cancel()
		return fmt.Errorf("start capture helper: %w", err)
	}
	if err := encoder.Start(); err != nil {
		cancel()
		_ = helper.Wait()
		return fmt.Errorf("start encoder: %w", err)
	}
	helperResult := waitProcess(helper)
	encoderResult := waitProcess(encoder)
	go stopProcessesOnCancel(pipelineCtx, helper, helperResult, encoder, encoderResult)

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 32*1024)
		for {
			n, readErr := encoderOut.Read(buf)
			if n > 0 {
				m.publishStream(buf[:n])
			}
			if readErr != nil {
				return
			}
		}
	}()

	timer := time.NewTimer(m.opts.ReadyTimeout)
	defer timer.Stop()
	select {
	case <-ready:
	case readyErr := <-readyError:
		cancel()
		<-helperResult.done
		<-encoderResult.done
		return readyErr
	case <-helperResult.done:
		cancel()
		<-encoderResult.done
		if helperResult.err != nil {
			return fmt.Errorf("capture helper exited: %w", helperResult.err)
		}
		return errors.New("capture helper exited before it became ready")
	case <-timer.C:
		cancel()
		<-helperResult.done
		<-encoderResult.done
		return errors.New("capture helper did not become ready within 10 seconds")
	}

	m.mu.Lock()
	if m.closed || m.state.SourceVersion != version || m.state.Source == nil || m.state.Source.Kind != SourceTerminal {
		m.mu.Unlock()
		cancel()
		<-helperResult.done
		<-encoderResult.done
		return errors.New("audio source changed while capture was starting")
	}
	m.stopPipelineLocked()
	m.pipelineCancel = cancel
	m.pipelineID++
	pipelineID := m.pipelineID
	pipelineDone := make(chan struct{})
	m.pipelineDone = pipelineDone
	m.streamReplay = nil
	m.mu.Unlock()
	go func() {
		for {
			select {
			case <-pipelineCtx.Done():
				return
			case warning := <-warnings:
				m.pipelineWarning(version, pipelineID, warning)
			}
		}
	}()

	go func() {
		var first string
		select {
		case <-pipelineCtx.Done():
			first = ""
		case <-helperResult.done:
			first = "capture helper"
		case <-encoderResult.done:
			first = "encoder"
		}
		intentional := pipelineCtx.Err() != nil
		cancel()
		<-helperResult.done
		<-encoderResult.done
		<-readDone
		close(pipelineDone)
		if intentional {
			return
		}
		message := first + " exited"
		if first == "capture helper" && helperResult.err != nil {
			message += ": " + helperResult.err.Error()
		}
		if first == "encoder" && encoderResult.err != nil {
			message += ": " + encoderResult.err.Error()
		}
		m.pipelineFailed(version, pipelineID, message)
	}()
	return nil
}

func stopProcessesOnCancel(ctx context.Context, helper *exec.Cmd, helperResult *processResult, encoder *exec.Cmd, encoderResult *processResult) {
	<-ctx.Done()
	requestGracefulStop(helper, helperResult)
	requestGracefulStop(encoder, encoderResult)
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for helperResult != nil || encoderResult != nil {
		select {
		case <-doneChannel(helperResult):
			helperResult = nil
		case <-doneChannel(encoderResult):
			encoderResult = nil
		case <-timer.C:
			forceStop(helper, helperResult)
			forceStop(encoder, encoderResult)
			return
		}
	}
}

func doneChannel(result *processResult) <-chan struct{} {
	if result == nil {
		return nil
	}
	return result.done
}

func requestGracefulStop(cmd *exec.Cmd, result *processResult) {
	if cmd == nil || cmd.Process == nil || result == nil {
		return
	}
	select {
	case <-result.done:
		return
	default:
		_ = cmd.Process.Signal(os.Interrupt)
	}
}

func forceStop(cmd *exec.Cmd, result *processResult) {
	if cmd == nil || cmd.Process == nil || result == nil {
		return
	}
	select {
	case <-result.done:
		return
	default:
		_ = cmd.Process.Kill()
	}
}

func (m *Manager) pipelineFailed(version, pipelineID uint64, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.state.SourceVersion != version || m.pipelineID != pipelineID {
		return
	}
	m.pipelineCancel = nil
	m.pipelineDone = nil
	m.streamReplay = nil
	for ch := range m.streamSubscribers {
		close(ch)
		delete(m.streamSubscribers, ch)
	}
	m.state.Status = StatusPaused
	m.state.Error = message
	m.state.Warning = ""
	m.state.StateVersion++
	m.persistLocked(context.Background())
	state := m.snapshotLocked()
	m.broadcastLocked(state)
}

func (m *Manager) pipelineWarning(version, pipelineID uint64, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.state.SourceVersion != version || m.pipelineID != pipelineID || m.state.Warning == message {
		return
	}
	m.state.Warning = message
	m.state.StateVersion++
	state := m.snapshotLocked()
	m.broadcastLocked(state)
}

func (m *Manager) captureCapability() (bool, string) {
	_, _, err := m.captureTools()
	if err != nil {
		return false, err.Error()
	}
	return true, ""
}

func (m *Manager) captureTools() (string, string, error) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		return "", "", errors.New("Terminal audio capture is not supported on this platform")
	}
	helper, err := resolveTool(m.opts.CaptureHelper, "tessera-audio-capture")
	if err != nil {
		return "", "", errors.New("Capture helper not found")
	}
	encoder, err := resolveTool(m.opts.Encoder, "tessera-lame")
	if err != nil {
		return "", "", errors.New("Encoder unavailable")
	}
	return helper, encoder, nil
}

func resolveTool(explicit, base string) (string, error) {
	if explicit != "" {
		if filepath.IsAbs(explicit) || strings.ContainsAny(explicit, `/\\`) {
			if info, err := os.Stat(explicit); err == nil && !info.IsDir() {
				return explicit, nil
			}
			return "", os.ErrNotExist
		}
		return exec.LookPath(explicit)
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	names := []string{
		fmt.Sprintf("%s-%s-%s%s", base, runtime.GOOS, runtime.GOARCH, ext),
		base + ext,
	}
	if base == "tessera-lame" {
		names = append(names, "lame"+ext)
	}
	if executable, err := os.Executable(); err == nil {
		dir := filepath.Dir(executable)
		for _, name := range names {
			candidate := filepath.Join(dir, name)
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return candidate, nil
			}
		}
	}
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", os.ErrNotExist
}
