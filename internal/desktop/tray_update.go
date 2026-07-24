package desktop

import "context"

const (
	trayUpdateTitle         = "Update..."
	trayUpdateCheckingTitle = "Checking for Updates..."
)

type updateAction func(context.Context) (restarting bool, err error)

type trayUpdateState struct {
	title   string
	enabled bool
}

func trayUpdateFinishedState(restarting bool, err error) trayUpdateState {
	if err != nil {
		return trayUpdateState{title: "Update Failed — Retry", enabled: true}
	}
	if restarting {
		return trayUpdateState{title: "Restarting...", enabled: false}
	}
	return trayUpdateState{title: "Up to Date — Check Again", enabled: true}
}
