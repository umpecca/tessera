package main

import (
	"bufio"
	"bytes"
	"context"
	"flag"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCLIStartupProcess(t *testing.T) {
	if os.Getenv("TESSERA_STARTUP_TEST_CHILD") == "1" {
		at := slices.Index(os.Args, "--")
		os.Args = append([]string{"tessera"}, os.Args[at+1:]...)
		flag.CommandLine = flag.NewFlagSet("tessera", flag.ExitOnError)
		main()
		os.Exit(0)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCLIStartupProcess$", "--",
		"-tray=false", "-addr=127.0.0.1:0", "-db="+filepath.Join(t.TempDir(), "tessera.sqlite3"),
		"-allowed-host=studio.example.com", "-username=alice", "-password-stdin")
	cmd.Env = append(os.Environ(), "TESSERA_STARTUP_TEST_CHILD=1")
	cmd.Stdin = strings.NewReader("stdin-process-secret\n")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if strings.Contains(stderr.String(), "stdin-process-secret") {
			t.Error("password leaked to stderr")
		}
		if strings.Contains(stderr.String(), "HTTP:") {
			t.Error("endpoint summary went to stderr")
		}
	})
	scanner := bufio.NewScanner(stdout)
	var endpoint string
	var lines []string
	for scanner.Scan() {
		line := scanner.Text()
		lines = append(lines, line)
		if value, ok := strings.CutPrefix(line, "  HTTP:  "); ok {
			endpoint = value
		}
		if strings.HasPrefix(line, "  Sign-in:") {
			break
		}
	}
	summary := strings.Join(lines, "\n")
	if endpoint == "" || strings.HasSuffix(endpoint, ":0") || !strings.Contains(summary, "HTTPS: disabled") || !strings.Contains(summary, `CLI account "alice"`) || strings.Contains(summary, "stdin-process-secret") {
		t.Fatalf("stdout summary = %s", summary)
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, _ := http.NewRequest(http.MethodGet, endpoint+"/api/users", nil)
	request.Host = "studio.example.com"
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("hostname request = %d", response.StatusCode)
	}
	response, err = client.PostForm(endpoint+"/login", url.Values{"username": {"alice"}, "password": {"stdin-process-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusSeeOther || len(response.Cookies()) == 0 {
		t.Fatalf("stdin sign-in = %d", response.StatusCode)
	}
	request, _ = http.NewRequest(http.MethodGet, endpoint+"/api/users", nil)
	for _, cookie := range response.Cookies() {
		request.AddCookie(cookie)
	}
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"signedIn":"alice"`)) {
		t.Fatalf("signed-in request = %d %s", response.StatusCode, body)
	}
}

func TestCLIInvalidCredentialsFailBeforeOpeningStore(t *testing.T) {
	for _, flags := range [][]string{
		{"-username=alice"},
		{"-password=argument-secret"},
		{"-username=alice", "-password-stdin"},
		{"-username=alice", "-password=argument-secret", "-auth=off"},
		{"-username=alice", "-password=argument-secret", "-password-stdin"},
	} {
		path := filepath.Join(t.TempDir(), "must-not-exist.sqlite3")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		args := append([]string{"-test.run=^TestCLIStartupProcess$", "--", "-tray=false", "-db=" + path}, flags...)
		cmd := exec.CommandContext(ctx, os.Args[0], args...)
		cmd.Env = append(os.Environ(), "TESSERA_STARTUP_TEST_CHILD=1")
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		cancel()
		if err == nil || stdout.Len() != 0 || stderr.Len() == 0 {
			t.Fatalf("invalid credential flags: err=%v, stdout=%s", err, &stdout)
		}
		if strings.Contains(stderr.String(), "argument-secret") {
			t.Fatal("secret disclosed in error")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("invalid credentials opened the database")
		}
	}
}
