package terminal

import (
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// summaryTailRows is how many of the last non-blank rows on screen a
// summary carries, and summaryRowBytes how much of each.
const summaryTailRows = 3
const summaryRowBytes = 240

// Summary is what a phone's list of terminals shows about one running
// shell, without attaching to it.
type Summary struct {
	PaneID string `json:"paneId"`
	// MarksPrompts says the shell has sent prompt marks (OSC 133), so
	// Running means a command is running and its absence an idle prompt.
	// A shell that has shown its prompt but run nothing yet counts.
	MarksPrompts bool `json:"marksPrompts"`
	Running      bool `json:"running"`
	// Command is the running command's line and RunningSeconds how long it
	// has run, when Running.
	Command        string         `json:"command,omitempty"`
	RunningSeconds int            `json:"runningSeconds,omitempty"`
	LastCommand    *CommandResult `json:"lastCommand,omitempty"`
	// RecentCommands are the shell's last command lines, newest first.
	RecentCommands []string  `json:"recentCommands,omitempty"`
	Progress       *Progress `json:"progress,omitempty"`
	// Alert is the latest alert no browser has shown yet.
	Alert *Alert `json:"alert,omitempty"`
	// Directory is the path from the shell's last OSC 7 report.
	Directory string   `json:"directory,omitempty"`
	Tail      []string `json:"tail"`
	// OutputSecondsAgo is how long ago the shell last printed, or -1.
	OutputSecondsAgo int  `json:"outputSecondsAgo"`
	Exited           bool `json:"exited,omitempty"`
	Cols             int  `json:"cols"`
	Rows             int  `json:"rows"`
}

// Summaries describes the running shells of one workspace, in pane order.
func (m *Manager) Summaries(workspaceID string) []Summary {
	if m == nil {
		return nil
	}
	if workspaceID == "" {
		workspaceID = "default"
	}
	m.mu.Lock()
	var sessions []*ManagedSession
	for _, session := range m.sessions {
		if session.workspaceID == workspaceID && !session.isClosed() {
			sessions = append(sessions, session)
		}
	}
	m.mu.Unlock()
	now := time.Now()
	summaries := make([]Summary, 0, len(sessions))
	for _, session := range sessions {
		summaries = append(summaries, session.summary(now))
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].PaneID < summaries[j].PaneID })
	return summaries
}

func (s *ManagedSession) summary(now time.Time) Summary {
	exited, _ := s.Exited()
	progress := s.CurrentProgress()
	alert := s.UnseenAlert()
	s.mu.Lock()
	defer s.mu.Unlock()
	summary := Summary{
		PaneID:           s.paneID,
		MarksPrompts:     s.marksPrompts,
		Running:          s.command != nil,
		LastCommand:      s.lastCommand,
		RecentCommands:   append([]string(nil), s.recentCommands...),
		Progress:         progress,
		Alert:            alert,
		OutputSecondsAgo: -1,
		Exited:           exited,
		Cols:             s.cols,
		Rows:             s.rows,
		Tail:             []string{},
	}
	if s.command != nil {
		summary.Command = s.command.line
		summary.RunningSeconds = int(now.Sub(s.command.started) / time.Second)
	}
	if !s.lastOutput.IsZero() {
		summary.OutputSecondsAgo = int(now.Sub(s.lastOutput) / time.Second)
	}
	if s.core == nil {
		return summary
	}
	if report, err := s.core.WorkingDirectory(); err == nil {
		summary.Directory = directoryFromReport(report)
	}
	if at, err := s.core.AtPrompt(); err == nil && at {
		summary.MarksPrompts = true
	}
	if lines, err := s.core.ScreenText(); err == nil {
		summary.Tail = screenTail(lines, summaryTailRows)
	}
	return summary
}

// directoryFromReport takes the path from an OSC 7 file:// URL.
func directoryFromReport(report string) string {
	parsed, err := url.Parse(report)
	if err != nil || parsed.Scheme != "file" {
		return ""
	}
	return parsed.Path
}

// screenTail is the last n non-blank rows, each cut to summaryRowBytes on
// a character boundary.
func screenTail(lines []string, n int) []string {
	tail := []string{}
	for i := len(lines) - 1; i >= 0 && len(tail) < n; i-- {
		line := strings.TrimRight(lines[i], " ")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if len(line) > summaryRowBytes {
			cut := summaryRowBytes
			for cut > 0 && !utf8.RuneStart(line[cut]) {
				cut--
			}
			line = line[:cut]
		}
		tail = append(tail, line)
	}
	for i, j := 0, len(tail)-1; i < j; i, j = i+1, j-1 {
		tail[i], tail[j] = tail[j], tail[i]
	}
	return tail
}
