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
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"tessera/internal/version"
)

const defaultAPIBase = "https://api.github.com"

const (
	replacementReadyEnvironment = "TESSERA_UPDATE_READY_FILE"
	replacementReadyTimeout     = 30 * time.Second
)

type Updater struct {
	Repo    string // e.g. "umpecca/tessera"
	APIBase string // GitHub API base; TESSERA_UPDATE_API overrides for testing

	// exePath is resolved at startup: on Windows the swap renames the running
	// executable, after which os.Executable would report the ".old" path.
	exePath string

	restart       chan struct{}
	restartOnce   sync.Once
	mu            sync.Mutex
	beforeInstall func() error
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

	companionURL  string
	companionName string
	companionSize int64
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
	companionWanted := companionAssetName()
	for _, asset := range rel.Assets {
		if asset.Name == wanted {
			result.assetURL = asset.BrowserDownloadURL
			result.assetName = asset.Name
			result.assetSize = asset.Size
		}
		if needsCompanion() && asset.Name == companionWanted {
			result.companionURL = asset.BrowserDownloadURL
			result.companionName = asset.Name
			result.companionSize = asset.Size
		}
	}
	if result.assetURL == "" {
		return nil, fmt.Errorf("release %s has no asset named %q", rel.TagName, wanted)
	}
	if needsCompanion() && result.companionURL == "" {
		return nil, fmt.Errorf("release %s has no companion asset named %q", rel.TagName, companionWanted)
	}
	return result, nil
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
	if err := u.downloadAsset(ctx, result.assetURL, result.assetName, result.assetSize, newPath); err != nil {
		_ = os.Remove(newPath)
		return nil, err
	}
	companionNewPath := ""
	if needsCompanion() {
		companionNewPath = u.companionPath() + ".new"
		if err := u.downloadAsset(ctx, result.companionURL, result.companionName, result.companionSize, companionNewPath); err != nil {
			_ = os.Remove(newPath)
			_ = os.Remove(companionNewPath)
			return nil, err
		}
	}
	if u.beforeInstall != nil {
		if err := u.beforeInstall(); err != nil {
			_ = os.Remove(newPath)
			_ = os.Remove(companionNewPath)
			return nil, fmt.Errorf("prepare update: %w", err)
		}
	}
	if err := u.installPair(newPath, companionNewPath); err != nil {
		_ = os.Remove(newPath)
		_ = os.Remove(companionNewPath)
		return nil, err
	}
	return result, nil
}

func (u *Updater) downloadAsset(ctx context.Context, assetURL, name string, size int64, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, assetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "tessera-updater")

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: %s", name, resp.Status)
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
	if size > 0 && written != size {
		return fmt.Errorf("download %s: got %d bytes, expected %d", name, written, size)
	}
	if written == 0 {
		return fmt.Errorf("download %s: empty asset", name)
	}
	return nil
}

// swap moves the downloaded binary into place. Windows cannot overwrite a
// running executable but can rename it, so the running exe moves aside to
// ".old" first; a failure after that rolls it back.
func (u *Updater) swap(newPath string) error {
	installed, err := installFile(newPath, u.exePath)
	if err != nil {
		return fmt.Errorf("install new executable: %w", err)
	}
	if runtime.GOOS != "windows" {
		installed.commit()
	}
	return nil
}

type installedFile struct {
	destination string
	backup      string
	hadPrevious bool
}

func installFile(newPath, destination string) (*installedFile, error) {
	installed := &installedFile{destination: destination, backup: destination + ".old"}
	_ = os.Remove(installed.backup)
	if _, err := os.Stat(destination); err == nil {
		if err := os.Rename(destination, installed.backup); err != nil {
			return nil, err
		}
		installed.hadPrevious = true
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if err := os.Rename(newPath, destination); err != nil {
		installed.rollback()
		return nil, err
	}
	if err := os.Chmod(destination, 0o755); err != nil {
		installed.rollback()
		return nil, err
	}
	return installed, nil
}

func (installed *installedFile) rollback() {
	if installed == nil {
		return
	}
	_ = os.Remove(installed.destination)
	if installed.hadPrevious {
		_ = os.Rename(installed.backup, installed.destination)
	}
}

func (installed *installedFile) commit() {
	if installed != nil && installed.hadPrevious {
		_ = os.Remove(installed.backup)
	}
}

func (u *Updater) installPair(executableNew, companionNew string) error {
	var companion *installedFile
	var err error
	if companionNew != "" {
		companion, err = installFile(companionNew, u.companionPath())
		if err != nil {
			return fmt.Errorf("install encoder companion: %w", err)
		}
	}
	executable, err := installFile(executableNew, u.exePath)
	if err != nil {
		companion.rollback()
		return fmt.Errorf("install new executable: %w", err)
	}
	companion.commit()
	if runtime.GOOS != "windows" {
		executable.commit()
	}
	return nil
}

// SetBeforeInstall registers a short hook used by the server to stop a live
// encoder before the updater replaces its executable.
func (u *Updater) SetBeforeInstall(hook func() error) {
	u.beforeInstall = hook
}

// EnsureCompanion repairs a legacy binary-only upgrade by fetching the LAME
// asset from the exact release matching the running Tessera version.
func (u *Updater) EnsureCompanion(ctx context.Context) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !needsCompanion() || normalizeVersion(version.Version) == "dev" {
		return nil
	}
	if info, err := os.Stat(u.companionPath()); err == nil && !info.IsDir() {
		return nil
	}
	endpoint := fmt.Sprintf("%s/repos/%s/releases/tags/%s", u.APIBase, u.Repo, url.PathEscape(version.Version))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "tessera-updater")
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch exact release: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch exact release: %s", response.Status)
	}
	var rel release
	if err := json.NewDecoder(response.Body).Decode(&rel); err != nil {
		return fmt.Errorf("decode exact release: %w", err)
	}
	wanted := companionAssetName()
	for _, asset := range rel.Assets {
		if asset.Name != wanted {
			continue
		}
		newPath := u.companionPath() + ".new"
		if err := u.downloadAsset(ctx, asset.BrowserDownloadURL, asset.Name, asset.Size, newPath); err != nil {
			_ = os.Remove(newPath)
			return err
		}
		if u.beforeInstall != nil {
			if err := u.beforeInstall(); err != nil {
				_ = os.Remove(newPath)
				return err
			}
		}
		installed, err := installFile(newPath, u.companionPath())
		if err != nil {
			_ = os.Remove(newPath)
			return err
		}
		installed.commit()
		return nil
	}
	return fmt.Errorf("release %s has no companion asset named %q", version.Version, wanted)
}

func (u *Updater) companionPath() string {
	return filepath.Join(filepath.Dir(u.exePath), companionAssetName())
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

// SpawnReplacement starts the updated executable with the same arguments and
// waits for it to acknowledge that the server started. The caller must release
// the listen socket and other process resources via graceful shutdown first.
func (u *Updater) SpawnReplacement() error {
	return u.spawnReplacement(replacementReadyTimeout)
}

func (u *Updater) spawnReplacement(timeout time.Duration) error {
	ready, err := os.CreateTemp("", "tessera-update-ready-*")
	if err != nil {
		return fmt.Errorf("create replacement readiness marker: %w", err)
	}
	readyPath := ready.Name()
	if err := ready.Close(); err != nil {
		_ = os.Remove(readyPath)
		return fmt.Errorf("close replacement readiness marker: %w", err)
	}
	if err := os.Remove(readyPath); err != nil {
		return fmt.Errorf("prepare replacement readiness marker: %w", err)
	}
	defer os.Remove(readyPath)

	env := environmentWithout(os.Environ(), replacementReadyEnvironment)
	env = append(env, replacementReadyEnvironment+"="+readyPath)
	if err := restartReplacement(u.exePath, os.Args[1:], env); err != nil {
		return fmt.Errorf("start replacement: %w", err)
	}

	deadline := time.Now().Add(timeout)
	for {
		if marker, err := os.ReadFile(readyPath); err == nil {
			message := strings.TrimSpace(string(marker))
			if message == "ready" {
				return nil
			}
			if detail, ok := strings.CutPrefix(message, "error\n"); ok {
				return fmt.Errorf("replacement failed to start: %s", detail)
			}
			return fmt.Errorf("replacement wrote an invalid readiness marker")
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("read replacement readiness marker: %w", err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("replacement did not report ready within %s", timeout)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// SignalReplacementReady acknowledges a self-update handoff after the new
// server has successfully started. It is a no-op during an ordinary launch.
func SignalReplacementReady() error {
	return signalReplacement("ready\n")
}

// SignalReplacementFailure reports a server startup error to the stopped
// parent so it can fail the update handoff immediately with useful context.
func SignalReplacementFailure(startErr error) error {
	if startErr == nil {
		return nil
	}
	return signalReplacement("error\n" + startErr.Error() + "\n")
}

func signalReplacement(message string) error {
	readyPath := os.Getenv(replacementReadyEnvironment)
	if readyPath == "" {
		return nil
	}
	if err := os.Unsetenv(replacementReadyEnvironment); err != nil {
		return fmt.Errorf("clear replacement readiness environment: %w", err)
	}
	if err := os.WriteFile(readyPath, []byte(message), 0o600); err != nil {
		return fmt.Errorf("write replacement readiness marker: %w", err)
	}
	return nil
}

func environmentWithout(env []string, name string) []string {
	prefix := name + "="
	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			filtered = append(filtered, entry)
		}
	}
	return filtered
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

func companionAssetName() string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("tessera-lame-%s-%s%s", runtime.GOOS, runtime.GOARCH, ext)
}

func needsCompanion() bool {
	return runtime.GOOS == "windows" || runtime.GOOS == "linux" || runtime.GOOS == "darwin"
}
