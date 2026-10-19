package terminal

import (
	"time"

	"tessera/internal/terminalcore"
)

// Alert is a bell, a desktop notification or a long command finishing in a
// pane, sent to every browser showing it, including ones whose output is
// paused: those are the panes nobody is looking at, which is when an alert
// matters.
type Alert struct {
	Type  string `json:"type"`
	Epoch string `json:"epoch"`
	ID    uint64 `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title,omitempty"`
	Body  string `json:"body,omitempty"`
	// A finished command: its exit status, if the shell gave one, and how
	// long it ran. Title is its command line, if the shell sent one.
	Status  *int `json:"status,omitempty"`
	Seconds int  `json:"seconds,omitempty"`
}

const maximumPendingAlerts = 8

// A program can ring the bell or notify in a loop. Bells reach browsers at
// most once a second; notifications in bursts of five, then one a second.
const bellInterval = time.Second
const notificationBurst = 5
const notificationInterval = time.Second

type alertLimiter struct {
	lastBell      time.Time
	tokens        float64
	tokensUpdated time.Time
}

func (l *alertLimiter) allowBell(now time.Time) bool {
	if !l.lastBell.IsZero() && now.Sub(l.lastBell) < bellInterval {
		return false
	}
	l.lastBell = now
	return true
}

func (l *alertLimiter) allowNotification(now time.Time) bool {
	if l.tokensUpdated.IsZero() {
		l.tokens = notificationBurst
	} else {
		l.tokens = min(notificationBurst, l.tokens+float64(now.Sub(l.tokensUpdated))/float64(notificationInterval))
	}
	l.tokensUpdated = now
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

// readAlertsLocked collects what the program rang or sent since the last
// call.
func (s *ManagedSession) readAlertsLocked() ([]terminalcore.Notification, bool, error) {
	count, err := s.core.BellCount()
	if err != nil {
		return nil, false, err
	}
	rang := count != s.bellCount
	s.bellCount = count
	notifications, err := s.core.Notifications()
	return notifications, rang, err
}

func (s *ManagedSession) publishAlertsLocked(notifications []terminalcore.Notification, rang bool, now time.Time) {
	for _, notification := range notifications {
		if s.alertLimiter.allowNotification(now) {
			s.publishAlertLocked(Alert{Kind: "notification", Title: notification.Title, Body: notification.Body})
		}
	}
	if rang && s.alertLimiter.allowBell(now) {
		s.publishAlertLocked(Alert{Kind: "bell"})
	}
}

func (s *ManagedSession) publishAlertLocked(alert Alert) {
	s.alertSequence++
	alert.Type = "terminal-alert"
	alert.Epoch = s.epoch
	alert.ID = s.alertSequence
	// The latest alert waits for a browser to show the pane, so one that
	// attaches later still hears of it. A bell never hides anything else.
	if s.unseenAlert == nil || alert.Kind != "bell" || s.unseenAlert.Kind == "bell" {
		unseen := alert
		s.unseenAlert = &unseen
	}
	for sub := range s.subscribers {
		if sub.done {
			continue
		}
		if len(sub.alertPending) >= maximumPendingAlerts {
			sub.alertPending = sub.alertPending[1:]
		}
		sub.alertPending = append(sub.alertPending, alert)
		select {
		case sub.alertWake <- struct{}{}:
		default:
		}
	}
}

func (s *ManagedSession) readAlert(sub *subscriber) (Alert, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(sub.alertPending) == 0 {
		return Alert{}, false
	}
	alert := sub.alertPending[0]
	sub.alertPending = sub.alertPending[1:]
	if len(sub.alertPending) > 0 || sub.progressPending != nil {
		select {
		case sub.alertWake <- struct{}{}:
		default:
		}
	}
	return alert, true
}

// UnseenAlert is the latest alert no browser has shown yet, if any.
func (s *ManagedSession) UnseenAlert() *Alert {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unseenAlert == nil {
		return nil
	}
	alert := *s.unseenAlert
	return &alert
}

// SeenAlert records that a browser showed the pane after the given alert
// of this shell.
func (s *ManagedSession) SeenAlert(epoch string, id uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch == s.epoch && s.unseenAlert != nil && s.unseenAlert.ID <= id {
		s.unseenAlert = nil
	}
}

// setFocus records whether one browser has the pane focused. The pane is
// focused while any browser has it focused. The replies are focus reports
// for the shell.
func (s *ManagedSession) setFocus(sub *subscriber, focused bool) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !sub.done {
		sub.focused = focused
	}
	return s.updateFocusLocked()
}

// A browser reconnecting, or replacing its view of the pane, closes its old
// connection before the new one says it is focused. The pane loses focus
// only if no browser claims it within this time.
var focusLeaveDelay = 500 * time.Millisecond

func (s *ManagedSession) focusLeft() {
	time.AfterFunc(focusLeaveDelay, func() {
		s.mu.Lock()
		replies := s.updateFocusLocked()
		s.mu.Unlock()
		if len(replies) > 0 {
			_, _ = s.Write(replies)
		}
	})
}

func (s *ManagedSession) updateFocusLocked() []byte {
	focused := false
	for sub := range s.subscribers {
		focused = focused || sub.focused
	}
	if s.core == nil || focused == s.focused {
		return nil
	}
	s.focused = focused
	if err := s.core.SetFocus(focused); err != nil {
		return nil
	}
	replies, _ := s.core.Replies()
	return replies
}
