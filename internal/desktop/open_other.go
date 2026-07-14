//go:build !windows && !darwin

package desktop

import "os/exec"

func openURL(url string) error {
	return exec.Command("xdg-open", url).Start()
}
