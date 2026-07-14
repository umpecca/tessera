// Package update implements self-update against GitHub releases: it checks the
// latest release for a newer version, downloads the matching binary asset, and
// swaps it over the running executable so main can restart into it.
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"tessera/internal/version"
)

const defaultAPIBase = "https://api.github.com"

type Updater struct {
	Repo    string // e.g. "umpecca/tessera"
	APIBase string // GitHub API base; TESSERA_UPDATE_API overrides for testing

	// exePath is resolved at startup: on Windows the swap renames the running
	// executable, after which os.Executable would report the ".old" path.
	exePath string

	restart     chan struct{}
	restartOnce sync.Once
	mu          sync.Mutex
}

func New(repo string) (*Updater, error) {
	exePath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}
	apiBase := os.Getenv("TESSERA_UPDATE_API")
	if apiBase == "" {
		apiBase = defaultAPIBase
	}
	return &Updater{
		Repo:    repo,
		APIBase: apiBase,
		exePath: exePath,
		restart: make(chan struct{}),
	}, nil
}

// CleanupOld removes the ".old" executable a previous update left behind.
// Best effort: right after an update the exiting old process may still hold
// the file on Windows; the next startup gets it.
func (u *Updater) CleanupOld() {
	_ = os.Remove(u.exePath + ".old")
}

type CheckResult struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`

	assetURL  string
	assetName string
	assetSize int64
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type release struct {
	TagName string         `json:"tag_name"`
	Assets  []releaseAsset `json:"assets"`
}

// Check queries the latest GitHub release and reports whether it differs from
// the running version. "dev" builds always report an update as available.
func (u *Updater) Check(ctx context.Context) (*CheckResult, error) {
	url := fmt.Sprintf("%s/repos/%s/releases/latest", u.APIBase, u.Repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "tessera-updater")
	req.Header.Set("Accept", "application/vnd.github+json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch latest release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("fetch latest release: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var rel release
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("decode release: %w", err)
	}
	if rel.TagName == "" {
		return nil, errors.New("latest release has no tag name")
	}

	result := &CheckResult{
		CurrentVersion:  version.Version,
		LatestVersion:   rel.TagName,
		UpdateAvailable: normalizeVersion(rel.TagName) != normalizeVersion(version.Version),
	}
	if !result.UpdateAvailable {
		return result, nil
	}

	wanted := assetName()
	for _, asset := range rel.Assets {
		if asset.Name == wanted {
			result.assetURL = asset.BrowserDownloadURL
			result.assetName = asset.Name
			result.assetSize = asset.Size
			return result, nil
		}
	}
	return nil, fmt.Errorf("release %s has no asset named %q", rel.TagName, wanted)
}

// Apply re-checks the latest release, downloads the matching asset, and swaps
// it over the running executable. It does not restart; the caller signals the
// restart after responding to the client.
func (u *Updater) Apply(ctx context.Context) (*CheckResult, error) {
	if !u.mu.TryLock() {
		return nil, errors.New("update already in progress")
	}
	defer u.mu.Unlock()

	result, err := u.Check(ctx)
	if err != nil {
		return nil, err
	}
	if !result.UpdateAvailable {
		return result, nil
	}

	newPath := u.exePath + ".new"
	if err := u.download(ctx, result, newPath); err != nil {
		_ = os.Remove(newPath)
		return nil, err
	}
	if err := u.swap(newPath); err != nil {
		_ = os.Remove(newPath)
		return nil, err
	}
	return result, nil
}

func (u *Updater) download(ctx context.Context, result *CheckResult, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, result.assetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "tessera-updater")

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", result.assetName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: %s", result.assetName, resp.Status)
	}

	f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	written, err := io.Copy(f, resp.Body)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write %s: %w", dest, err)
	}
	if result.assetSize > 0 && written != result.assetSize {
		return fmt.Errorf("download %s: got %d bytes, expected %d", result.assetName, written, result.assetSize)
	}
	if written == 0 {
		return fmt.Errorf("download %s: empty asset", result.assetName)
	}
	return nil
}

// swap moves the downloaded binary into place. Windows cannot overwrite a
// running executable but can rename it, so the running exe moves aside to
// ".old" first; a failure after that rolls it back.
func (u *Updater) swap(newPath string) error {
	if runtime.GOOS == "windows" {
		oldPath := u.exePath + ".old"
		_ = os.Remove(oldPath)
		if err := os.Rename(u.exePath, oldPath); err != nil {
			return fmt.Errorf("move current executable aside: %w", err)
		}
		if err := os.Rename(newPath, u.exePath); err != nil {
			if rollback := os.Rename(oldPath, u.exePath); rollback != nil {
				return fmt.Errorf("install new executable: %w (rollback failed: %v)", err, rollback)
			}
			return fmt.Errorf("install new executable: %w", err)
		}
		return nil
	}
	if err := os.Rename(newPath, u.exePath); err != nil {
		return fmt.Errorf("install new executable: %w", err)
	}
	return os.Chmod(u.exePath, 0o755)
}

// RestartRequested is closed once an update has been applied and the process
// should shut down and re-exec.
func (u *Updater) RestartRequested() <-chan struct{} {
	return u.restart
}

// RequestRestart signals main to shut down and spawn the replacement. Safe to
// call multiple times.
func (u *Updater) RequestRestart() {
	u.restartOnce.Do(func() { close(u.restart) })
}

// SpawnReplacement starts the updated executable with the same arguments.
// The caller must have released the listen socket (via Shutdown) first. If
// Tessera runs under a supervisor, this briefly overlaps with the exiting
// process; acceptable for interactive use.
func (u *Updater) SpawnReplacement() error {
	cmd := exec.Command(u.exePath, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Start()
}

func normalizeVersion(v string) string {
	return strings.TrimPrefix(strings.TrimSpace(v), "v")
}

func assetName() string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("tessera-%s-%s%s", runtime.GOOS, runtime.GOARCH, ext)
}
