// Package shellintegration sets up zsh and bash, when Tessera starts them,
// to mark prompts and commands (OSC 133) and report the working directory
// (OSC 7), so prompt jumps, Copy Command Output, the pane's directory and
// command-finished notices work without editing any startup file.
//
// zsh starts with ZDOTDIR pointing at Tessera's .zshenv, which puts ZDOTDIR
// back before the rest of startup; bash 4.4 and later starts with
// --rcfile pointing at a file that reads ~/.bashrc first. Other shells start
// as they would anyway.
package shellintegration

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

//go:embed all:scripts
var scripts embed.FS

var installMu sync.Mutex

// Root writes the scripts to a folder named after their contents under the
// user cache folder (or the temporary folder), and returns it. It checks
// them each time, since a cache folder can be cleared while Tessera runs,
// and zsh pointed at a missing folder would skip the user's own startup
// files too.
func Root() (string, error) {
	installMu.Lock()
	defer installMu.Unlock()
	return install(cacheBase())
}

func cacheBase() string {
	if dir, err := os.UserCacheDir(); err == nil {
		return filepath.Join(dir, "tessera", "shell-integration")
	}
	return filepath.Join(os.TempDir(), "tessera-shell-integration")
}

func install(base string) (string, error) {
	sum := sha256.New()
	var files []string
	err := fs.WalkDir(scripts, "scripts", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := scripts.ReadFile(name)
		if err != nil {
			return err
		}
		sum.Write([]byte(name))
		sum.Write(data)
		files = append(files, name)
		return nil
	})
	if err != nil {
		return "", err
	}
	root := filepath.Join(base, hex.EncodeToString(sum.Sum(nil))[:16])
	for _, name := range files {
		data, _ := scripts.ReadFile(name)
		target := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(name, "scripts/")))
		if existing, err := os.ReadFile(target); err == nil && string(existing) == string(data) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return "", err
		}
		// Another Tessera may be writing the same file: write a private copy
		// and rename it into place.
		temporary, err := os.CreateTemp(filepath.Dir(target), "."+path.Base(name)+".*")
		if err != nil {
			return "", err
		}
		_, writeErr := temporary.Write(data)
		closeErr := temporary.Close()
		if writeErr == nil {
			writeErr = closeErr
		}
		if writeErr == nil {
			writeErr = os.Chmod(temporary.Name(), 0o644)
		}
		if writeErr == nil {
			writeErr = os.Rename(temporary.Name(), target)
		}
		if writeErr != nil {
			_ = os.Remove(temporary.Name())
			return "", writeErr
		}
	}
	return root, nil
}

// Configure returns the arguments and environment to start shell with so
// that it loads the integration in root. Shells other than zsh and bash are
// returned unchanged. env is not modified.
func Configure(shell string, args, env []string, root string) ([]string, []string) {
	switch strings.TrimPrefix(filepath.Base(shell), "-") {
	case "zsh":
		result := make([]string, 0, len(env)+2)
		for _, entry := range env {
			if value, ok := strings.CutPrefix(entry, "ZDOTDIR="); ok {
				result = append(result, "TESSERA_ZSH_ZDOTDIR="+value)
				continue
			}
			if strings.HasPrefix(entry, "TESSERA_ZSH_ZDOTDIR=") {
				continue
			}
			result = append(result, entry)
		}
		return args, append(result, "ZDOTDIR="+filepath.Join(root, "zsh"))
	case "bash":
		return append([]string{"--rcfile", filepath.Join(root, "bash", "tessera.bash")}, args...), env
	}
	return args, env
}
