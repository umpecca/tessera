// Package terminalfile implements Tessera's private host-local file extension.
package terminalfile

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const Prefix = "\x1b]777;tessera-file;1;"
const Terminator = "\x1b\\"
const MaxMetadata = 64 * 1024
const MaxFiles = 64
const MaxReplyMetadata = 512 * 1024
const ApprovalTimeoutSeconds = 300
const IdleTimeoutSeconds = 120

type Command struct {
	Action    string
	ID        string
	Directory string   `json:"directory,omitempty"`
	Paths     []string `json:"paths,omitempty"`
	Error     string   `json:"-"`
}
type File struct {
	Name   string `json:"name"`
	Path   string `json:"path,omitempty"`
	Bytes  int64  `json:"bytes"`
	Status string `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}
type Result struct {
	Directory    string `json:"directory,omitempty"`
	PathsOmitted bool   `json:"pathsOmitted,omitempty"`
	State        string `json:"state"`
	Error        string `json:"error,omitempty"`
	Bytes        int64  `json:"bytes,omitempty"`
	Files        []File `json:"files,omitempty"`
}
type Event struct {
	Type      string `json:"type"`
	Epoch     string `json:"epoch"`
	ID        string `json:"id,omitempty"`
	Action    string `json:"action"`
	Operation string `json:"operation,omitempty"`
	Directory string `json:"directory,omitempty"`
	Files     []File `json:"files,omitempty"`
	Bytes     int64  `json:"bytes,omitempty"`
	Error     string `json:"error,omitempty"`
}
type Capabilities struct {
	Version                int    `json:"version"`
	Host                   string `json:"host"`
	OS                     string `json:"os"`
	Scope                  string `json:"scope"`
	Batch                  bool   `json:"batch"`
	ZIP                    bool   `json:"zip"`
	MaxFiles               int    `json:"maxFiles"`
	MaxMetadataBytes       int    `json:"maxMetadataBytes"`
	MaxUploadBytes         int64  `json:"maxUploadBytes"`
	ApprovalTimeoutSeconds int    `json:"approvalTimeoutSeconds"`
	IdleTimeoutSeconds     int    `json:"idleTimeoutSeconds"`
}

func ValidID(s string) bool {
	if len(s) < 1 || len(s) > 64 {
		return false
	}
	for _, c := range []byte(s) {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}
func Encode(v any) string { b, _ := json.Marshal(v); return base64.StdEncoding.EncodeToString(b) }
func Reply(id string, result Result) string {
	data, _ := json.Marshal(result)
	if len(data) > MaxReplyMetadata {
		// Very long destinations need not be repeated for every uploaded file.
		result.Files = append([]File(nil), result.Files...)
		for i := range result.Files {
			result.Files[i].Path = ""
		}
		result.PathsOmitted = true
		data, _ = json.Marshal(result)
	}
	return Prefix + "reply;" + id + ";" + base64.StdEncoding.EncodeToString(data) + Terminator
}
func Serialize(c Command) (string, error) {
	if !ValidID(c.ID) {
		return "", errors.New("invalid request ID")
	}
	switch c.Action {
	case "query", "cancel":
		return Prefix + c.Action + ";" + c.ID + Terminator, nil
	case "upload", "download":
		data := Encode(struct {
			Directory string   `json:"directory,omitempty"`
			Paths     []string `json:"paths,omitempty"`
		}{c.Directory, c.Paths})
		parsed, ok := Parse(c.Action + ";" + c.ID + ";" + data)
		if !ok || parsed.Error != "" {
			return "", errors.New("invalid transfer metadata")
		}
		return Prefix + c.Action + ";" + c.ID + ";" + data + Terminator, nil
	}
	return "", errors.New("unsupported command")
}
func Parse(s string) (Command, bool) {
	if s == "reset" {
		return Command{Action: "reset"}, true
	}
	p := strings.SplitN(s, ";", 3)
	if len(p) < 2 || !ValidID(p[1]) {
		return Command{}, false
	}
	c := Command{Action: p[0], ID: p[1]}
	if c.Action == "query" || c.Action == "cancel" {
		return c, len(p) == 2
	}
	if c.Action != "upload" && c.Action != "download" {
		return Command{}, false
	}
	c.Error = "invalid transfer metadata"
	if len(p) != 3 || len(p[2]) > base64.StdEncoding.EncodedLen(MaxMetadata) {
		return c, true
	}
	b, err := base64.StdEncoding.Strict().DecodeString(p[2])
	if err != nil || len(b) > MaxMetadata || !utf8.Valid(b) || base64.StdEncoding.EncodeToString(b) != p[2] {
		return c, true
	}
	var metadata struct {
		Directory string   `json:"directory"`
		Paths     []string `json:"paths"`
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if d.Decode(&metadata) != nil || d.Decode(new(any)) != io.EOF {
		return c, true
	}
	c.Directory, c.Paths = metadata.Directory, metadata.Paths
	if c.Action == "upload" {
		if !validPath(c.Directory) || len(c.Paths) != 0 {
			return c, true
		}
	} else {
		if c.Directory != "" || len(c.Paths) < 1 || len(c.Paths) > MaxFiles {
			return c, true
		}
		for _, path := range c.Paths {
			if !validPath(path) {
				return c, true
			}
		}
	}
	c.Error = ""
	return c, true
}
func validPath(s string) bool {
	return filepath.IsAbs(s) && !strings.ContainsRune(s, 0) && len(s) <= 4096
}
func Hostname() string { s, _ := os.Hostname(); return s }

// MatchReply consumes complete replies only; callers bound the input buffer.
func MatchReply(data []byte, action, id string) ([]byte, bool) {
	prefix := Prefix + action + ";" + id + ";"
	s := string(data)
	start := strings.Index(s, prefix)
	if start < 0 {
		return nil, false
	}
	s = s[start+len(prefix):]
	end := strings.Index(s, Terminator)
	bel := strings.IndexByte(s, 7)
	if bel >= 0 && (end < 0 || bel < end) {
		end = bel
	}
	if end < 0 {
		return nil, false
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s[:end])
	return b, err == nil && len(b) <= MaxReplyMetadata && json.Valid(b)
}
