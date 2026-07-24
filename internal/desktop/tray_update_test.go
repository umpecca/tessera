package desktop

import (
	"errors"
	"testing"
)

func TestTrayUpdateFinishedState(t *testing.T) {
	tests := []struct {
		name       string
		restarting bool
		err        error
		want       trayUpdateState
	}{
		{
			name:       "restart",
			restarting: true,
			want:       trayUpdateState{title: "Restarting...", enabled: false},
		},
		{
			name: "up to date",
			want: trayUpdateState{title: "Up to Date — Check Again", enabled: true},
		},
		{
			name: "failure",
			err:  errors.New("download failed"),
			want: trayUpdateState{title: "Update Failed — Retry", enabled: true},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := trayUpdateFinishedState(test.restarting, test.err); got != test.want {
				t.Fatalf("state = %#v, want %#v", got, test.want)
			}
		})
	}
}
