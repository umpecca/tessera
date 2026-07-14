//go:build darwin

package desktop

import "os/exec"

func openURL(url string) error {
	return exec.Command("open", url).Start()
}
