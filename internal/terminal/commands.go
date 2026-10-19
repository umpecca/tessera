package terminal

import "time"

// A shell that marks its prompts (OSC 133, which Tessera's shell
// integration sets up) says when each command starts and finishes. One that
// ran at least this long and finished while no browser had the pane focused
// becomes a "command" alert, as in Ghostty's notify-on-command-finish.
var commandNoticeAfter = 5 * time.Second

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
		elapsed := now.Sub(command.started)
		if elapsed < commandNoticeAfter || s.focused {
			continue
		}
		alert := Alert{Kind: "command", Title: command.line, Seconds: int(elapsed / time.Second)}
		if event.Status >= 0 {
			status := event.Status
			alert.Status = &status
		}
		alerts = append(alerts, alert)
	}
	return alerts, nil
}

func (s *ManagedSession) publishCommandAlertsLocked(alerts []Alert, now time.Time) {
	for _, alert := range alerts {
		if s.alertLimiter.allowNotification(now) {
			s.publishAlertLocked(alert)
		}
	}
}
