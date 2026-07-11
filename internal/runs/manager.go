package runs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"tessera/internal/shell"
	"tessera/internal/store"
)

type Manager struct {
	store  *store.Store
	runner *shell.Runner
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	runs   map[string]*Run
}

type StartRequest struct {
	WorkspaceID  string
	PaneID       string
	Command      string
	Cwd          string
	InsertPos    int
	OutputPrefix string
}

type Summary struct {
	RunID       string `json:"runId"`
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
	Command     string `json:"command"`
	Cwd         string `json:"cwd"`
}

type Event struct {
	Type        string `json:"type"`
	RunID       string `json:"runId,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	PaneID      string `json:"paneId,omitempty"`
	Text        string `json:"text,omitempty"`
	From        int    `json:"from"`
	BufferText  string `json:"bufferText,omitempty"`
	Cwd         string `json:"cwd,omitempty"`
	Code        *int   `json:"code,omitempty"`
	Error       string `json:"error,omitempty"`
}

type Run struct {
	id                 string
	workspaceID        string
	paneID             string
	command            string
	cwd                string
	bufferText         string
	cursor             int
	outputPrefix       string
	commandOutputChars int
	lastInsertedChar   string
	ctx                context.Context
	cancel             context.CancelFunc
	done               chan struct{}
	subscribers        map[chan Event]struct{}
	mu                 sync.Mutex
}

func NewManager(st *store.Store, runner *shell.Runner) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	if runner == nil {
		runner = &shell.Runner{}
	}
	return &Manager{
		store:  st,
		runner: runner,
		ctx:    ctx,
		cancel: cancel,
		runs:   map[string]*Run{},
	}
}

func (m *Manager) Close() {
	if m != nil && m.cancel != nil {
		m.cancel()
	}
}

func (m *Manager) Start(req StartRequest) (<-chan Event, func(), string, error) {
	if m == nil {
		return nil, nil, "", errors.New("run manager is not available")
	}
	req.Command = strings.TrimRight(req.Command, "\r\n")
	if strings.TrimSpace(req.Command) == "" {
		return nil, nil, "", errors.New("command is required")
	}
	if req.WorkspaceID == "" {
		req.WorkspaceID = store.DefaultWorkspaceID
	}
	if req.PaneID == "" {
		return nil, nil, "", errors.New("paneId is required")
	}
	if req.InsertPos < 0 {
		return nil, nil, "", errors.New("insertPos cannot be negative")
	}

	pane, err := m.store.LoadPane(m.ctx, req.WorkspaceID, req.PaneID)
	if err != nil {
		return nil, nil, "", fmt.Errorf("load pane: %w", err)
	}
	if req.InsertPos > len(pane.BufferText) {
		req.InsertPos = len(pane.BufferText)
	}
	if req.Cwd == "" {
		req.Cwd = pane.Cwd
	}

	runID := store.NewID("run")
	if err := m.store.StartCommandRun(m.ctx, runID, req.WorkspaceID, req.PaneID, req.Command, req.Cwd); err != nil {
		return nil, nil, "", err
	}

	run := &Run{
		id:               runID,
		workspaceID:      req.WorkspaceID,
		paneID:           req.PaneID,
		command:          req.Command,
		cwd:              req.Cwd,
		bufferText:       pane.BufferText,
		cursor:           req.InsertPos,
		outputPrefix:     req.OutputPrefix,
		lastInsertedChar: "\n",
		done:             make(chan struct{}),
		subscribers:      map[chan Event]struct{}{},
	}
	run.ctx, run.cancel = context.WithCancel(m.ctx)

	ch, unsubscribe := run.subscribe(false)
	m.mu.Lock()
	m.runs[runID] = run
	m.mu.Unlock()

	go m.run(run)
	return ch, unsubscribe, runID, nil
}

func (m *Manager) ActiveRuns(workspaceID string) []Summary {
	if m == nil {
		return nil
	}
	if workspaceID == "" {
		workspaceID = store.DefaultWorkspaceID
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	summaries := make([]Summary, 0, len(m.runs))
	for _, run := range m.runs {
		if run.workspaceID != workspaceID {
			continue
		}
		run.mu.Lock()
		summary := Summary{
			RunID:       run.id,
			WorkspaceID: run.workspaceID,
			PaneID:      run.paneID,
			Command:     run.command,
			Cwd:         run.cwd,
		}
		run.mu.Unlock()
		summaries = append(summaries, summary)
	}
	return summaries
}

func (m *Manager) ActivePaneIDs(workspaceID string) map[string]bool {
	active := map[string]bool{}
	for _, run := range m.ActiveRuns(workspaceID) {
		active[run.PaneID] = true
	}
	return active
}

func (m *Manager) Subscribe(runID string, includeSnapshot bool) (<-chan Event, func(), bool) {
	if m == nil {
		return nil, nil, false
	}
	m.mu.Lock()
	run := m.runs[runID]
	m.mu.Unlock()
	if run == nil {
		return nil, nil, false
	}
	ch, unsubscribe := run.subscribe(includeSnapshot)
	return ch, unsubscribe, true
}

func (m *Manager) StopWorkspace(ctx context.Context, workspaceID string) error {
	if m == nil {
		return nil
	}
	if workspaceID == "" {
		workspaceID = store.DefaultWorkspaceID
	}
	m.mu.Lock()
	runs := make([]*Run, 0)
	for _, run := range m.runs {
		if run.workspaceID == workspaceID {
			runs = append(runs, run)
		}
	}
	m.mu.Unlock()
	for _, run := range runs {
		run.cancel()
	}
	for _, run := range runs {
		select {
		case <-run.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (m *Manager) run(run *Run) {
	defer close(run.done)
	run.insert(run.ctx, "\n", 0, m.store)

	for event := range m.runner.Run(run.ctx, shell.RunRequest{
		RunID:   run.id,
		Command: run.command,
		Cwd:     run.cwd,
	}) {
		switch event.Type {
		case "start":
			run.setCwd(run.ctx, event.Cwd, m.store)
			run.broadcast(Event{Type: "start", RunID: run.id, WorkspaceID: run.workspaceID, PaneID: run.paneID, Cwd: event.Cwd})
		case "stdout", "stderr":
			run.appendCommandOutput(run.ctx, event.Text, m.store)
		case "error":
			run.appendHostMessage(run.ctx, event.Error, m.store)
		case "exit":
			code := 0
			if event.Code != nil {
				code = *event.Code
			}
			if event.Cwd != "" {
				run.setCwd(run.ctx, event.Cwd, m.store)
			}
			run.finishTranscript(run.ctx, code, m.store)
			_ = m.store.FinishCommandRun(run.ctx, run.id, event.Cwd, code)
			run.broadcast(Event{Type: "exit", RunID: run.id, WorkspaceID: run.workspaceID, PaneID: run.paneID, Cwd: event.Cwd, Code: &code})
		}
	}

	m.mu.Lock()
	delete(m.runs, run.id)
	m.mu.Unlock()
	run.closeSubscribers()
}

func (r *Run) subscribe(includeSnapshot bool) (<-chan Event, func()) {
	ch := make(chan Event, 128)
	r.mu.Lock()
	r.subscribers[ch] = struct{}{}
	if includeSnapshot {
		ch <- Event{
			Type:        "snapshot",
			RunID:       r.id,
			WorkspaceID: r.workspaceID,
			PaneID:      r.paneID,
			BufferText:  r.bufferText,
			Cwd:         r.cwd,
		}
	}
	r.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			r.mu.Lock()
			if _, ok := r.subscribers[ch]; ok {
				delete(r.subscribers, ch)
				close(ch)
			}
			r.mu.Unlock()
		})
	}
	return ch, unsubscribe
}

func (r *Run) closeSubscribers() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subscribers {
		close(ch)
		delete(r.subscribers, ch)
	}
}

func (r *Run) appendCommandOutput(ctx context.Context, text string, st *store.Store) {
	r.insert(ctx, r.textAtOutputColumn(text), len(text), st)
}

func (r *Run) appendHostMessage(ctx context.Context, message string, st *store.Store) {
	if message == "" {
		message = "run error"
	}
	if r.lastChar() != "\n" {
		r.insert(ctx, "\n", 0, st)
	}
	r.insert(ctx, r.textAtOutputColumn("["+message+"]\n"), 0, st)
}

func (r *Run) finishTranscript(ctx context.Context, exitCode int, st *store.Store) {
	if r.outputCount() == 0 || exitCode != 0 {
		if r.lastChar() != "\n" {
			r.insert(ctx, "\n", 0, st)
		}
		r.insert(ctx, r.textAtOutputColumn(fmt.Sprintf("[exit %d]\n", exitCode)), 0, st)
	}
}

func (r *Run) insert(ctx context.Context, text string, commandOutputCharCount int, st *store.Store) {
	if text == "" {
		return
	}
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")

	r.mu.Lock()
	from := r.cursor
	if from < 0 {
		from = 0
	}
	if from > len(r.bufferText) {
		from = len(r.bufferText)
	}
	r.bufferText = r.bufferText[:from] + text + r.bufferText[from:]
	r.cursor = from + len(text)
	r.lastInsertedChar = text[len(text)-1:]
	r.commandOutputChars += commandOutputCharCount
	cwd := r.cwd
	event := Event{
		Type:        "insert",
		RunID:       r.id,
		WorkspaceID: r.workspaceID,
		PaneID:      r.paneID,
		From:        from,
		Text:        text,
		Cwd:         cwd,
	}
	r.mu.Unlock()

	if err := st.UpdatePaneBufferAndCwd(ctx, r.workspaceID, r.paneID, r.buffer(), cwd); err != nil {
		r.broadcast(Event{Type: "error", RunID: r.id, WorkspaceID: r.workspaceID, PaneID: r.paneID, Error: err.Error()})
	}
	r.broadcast(event)
}

func (r *Run) setCwd(ctx context.Context, cwd string, st *store.Store) {
	if cwd == "" {
		return
	}
	r.mu.Lock()
	r.cwd = cwd
	bufferText := r.bufferText
	r.mu.Unlock()
	if err := st.UpdatePaneBufferAndCwd(ctx, r.workspaceID, r.paneID, bufferText, cwd); err != nil {
		r.broadcast(Event{Type: "error", RunID: r.id, WorkspaceID: r.workspaceID, PaneID: r.paneID, Error: err.Error()})
	}
}

func (r *Run) textAtOutputColumn(text string) string {
	if r.outputPrefix == "" || text == "" {
		return text
	}

	var prefixed strings.Builder
	atLineStart := r.lastChar() == "\n"
	for _, char := range text {
		if atLineStart && char != '\n' {
			prefixed.WriteString(r.outputPrefix)
			atLineStart = false
		}
		prefixed.WriteRune(char)
		if char == '\n' {
			atLineStart = true
		}
	}
	return prefixed.String()
}

func (r *Run) broadcast(event Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

func (r *Run) buffer() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bufferText
}

func (r *Run) lastChar() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastInsertedChar
}

func (r *Run) outputCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.commandOutputChars
}
