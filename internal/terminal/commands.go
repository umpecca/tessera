package terminal

import (
	"strings"
	"time"
)

// A shell that marks its prompts (OSC 133, which Tessera's shell
// integration sets up) says when each command starts and finishes. One that
// ran at least this long and finished while no browser had the pane focused
// becomes a "command" alert, as in Ghostty's notify-on-command-finish.
var commandNoticeAfter = 5 * time.Second

// A shell's recent command lines, newest first and each once, so a phone
// can offer them again. Only whole ones: Tessera's shell integration ends a
// line it shortened (a second line, or past 200 characters) with …, and the
// core cuts a command line to 512 bytes on a character boundary. Running
// part of a command again would run something else.
const recentCommandLimit = 20
const recentCommandBytes = 508

// CommandResult is how the shell's last command ended: its command line,
// if the shell sent one, its exit status, if it gave one, and how long it
// ran.
type CommandResult struct {
	Line     string `json:"line,omitempty"`
	Status   *int   `json:"status,omitempty"`
	Seconds  int    `json:"seconds"`
	finished time.Time
}

type runningCommand struct {
	line    string
	started time.Time
}

// readCommandsLocked follows commands through the events since the last
// call, read at now, and returns the alerts for long ones that finished.
func (s *ManagedSession) readCommandsLocked(now time.Time) ([]Alert, error) {
	events, err := s.core.Commands()
	if err != nil {
		return nil, err
	}
	var alerts []Alert
	for _, event := range events {
		s.marksPrompts = true
		if event.Started {
			// Two sets of prompt hooks (Tessera's and older ones in a
			// startup file) mark the same command twice: keep the first
			// start and whichever command line was sent.
			if s.command != nil {
				if s.command.line == "" {
					s.command.line = event.Line
				}
				continue
			}
			s.command = &runningCommand{line: event.Line, started: now}
			continue
		}
		// An end with no start is a prompt cancelled at the keyboard.
		command := s.command
		s.command = nil
		if command == nil {
			continue
		}
		s.rememberCommandLocked(command.line)
		elapsed := now.Sub(command.started)
		result := &CommandResult{Line: command.line, Seconds: int(elapsed / time.Second), finished: now}
		if event.Status >= 0 {
			status := event.Status
			result.Status = &status
		}
		s.lastCommand = result
		if elapsed < commandNoticeAfter || s.focused {
			continue
		}
		alerts = append(alerts, Alert{Kind: "command", Title: command.line, Status: result.Status, Seconds: result.Seconds})
	}
	return alerts, nil
}

func (s *ManagedSession) rememberCommandLocked(line string) {
	line = strings.TrimSpace(line)
	if line == "" || len(line) > recentCommandBytes || strings.HasSuffix(line, "…") {
		return
	}
	recent := []string{line}
	for _, earlier := range s.recentCommands {
		if earlier != line && len(recent) < recentCommandLimit {
			recent = append(recent, earlier)
		}
	}
	s.recentCommands = recent
}

func (s *ManagedSession) publishCommandAlertsLocked(alerts []Alert, now time.Time) {
	for _, alert := range alerts {
		if s.alertLimiter.allowNotification(now) {
			s.publishAlertLocked(alert)
		}
	}
}
