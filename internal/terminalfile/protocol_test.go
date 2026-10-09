package terminalfile

import (
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestProtocolValidationAndBoundaries(t *testing.T) {
	path := t.TempDir()
	valid := Command{Action: "upload", ID: "A_1.-", Directory: path}
	sequence, err := Serialize(valid)
	if err != nil {
		t.Fatal(err)
	}
	parsed, ok := Parse(strings.TrimSuffix(strings.TrimPrefix(sequence, Prefix), Terminator))
	if !ok || parsed.Error != "" || parsed.Directory != path {
		t.Fatal(parsed)
	}
	metadata := `{"directory":` + stringJSON(path) + `}`
	for _, n := range []int{MaxMetadata, MaxMetadata + 1} {
		body := metadata + strings.Repeat(" ", n-len(metadata))
		p, ok := Parse("upload;x;" + base64.StdEncoding.EncodeToString([]byte(body)))
		if !ok || (p.Error == "") != (n == MaxMetadata) {
			t.Fatalf("boundary %d: %+v", n, p)
		}
	}
	for _, s := range []string{
		"upload;x;!", "upload;x;" + Encode(map[string]string{"directory": "relative"}),
		"upload;x;" + Encode(map[string]string{"directory": path, "other": "x"}),
		"download;x;" + Encode(map[string]any{"paths": []string{filepath.Join(path, "file"), "relative"}}),
		"upload;x;" + base64.StdEncoding.EncodeToString([]byte(metadata+`{}`)),
	} {
		p, ok := Parse(s)
		if !ok || p.Error == "" {
			t.Fatalf("accepted invalid metadata %q", s)
		}
	}

}
func stringJSON(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}
func TestIDsAndReplies(t *testing.T) {
	for _, s := range []string{"", strings.Repeat("a", 65), "a;b", "a b", "ü"} {
		if ValidID(s) {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"a", strings.Repeat("a", 64), "A_1.-"} {
		if !ValidID(s) {
			t.Fatal(s)
		}
	}
	frame := []byte(Reply("id", Result{State: "sent", Bytes: 10}))
	if _, ok := MatchReply(frame, "reply", "wrong"); ok {
		t.Fatal("matched unrelated nonce")
	}
	if _, ok := MatchReply(frame, "reply", "id"); !ok {
		t.Fatal("missing reply")
	}
}

func TestUnsafeUploadNames(t *testing.T) {
	for _, name := range []string{"", ".", "..", "a/b", "a\\b", "a\x00b"} {
		if ValidName(name) {
			t.Fatal(name)
		}
	}
	if runtime.GOOS == "windows" {
		for _, name := range []string{"a:stream", "CON", "NUL.txt", "COM1.txt", "file.", "file ", "a?b"} {
			if ValidName(name) {
				t.Fatal(name)
			}
		}
	}
	if !ValidName("report ü.txt") {
		t.Fatal("valid Unicode filename rejected")
	}
}

func TestVeryLongBatchPathsKeepRepliesBounded(t *testing.T) {
	result := Result{State: "complete", Directory: strings.Repeat("\"", 4000)}
	for range 64 {
		result.Files = append(result.Files, File{Name: "file.txt", Path: strings.Repeat("\"", 4096), Status: "uploaded"})
	}
	data, ok := MatchReply([]byte(Reply("id", result)), "reply", "id")
	if !ok || len(data) > MaxReplyMetadata {
		t.Fatal("unbounded reply")
	}
	var decoded Result
	if json.Unmarshal(data, &decoded) != nil || !decoded.PathsOmitted || len(decoded.Files) != 64 || decoded.Directory != result.Directory {
		t.Fatal("lost batch results")
	}
	if result.Files[0].Path == "" {
		t.Fatal("serialization mutated its caller")
	}
}
