// Package terminalaudio defines Tessera's private terminal audio clip protocol.
package terminalaudio

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
)

const Prefix = "\x1b]777;tessera-audio;1;"
const Terminator = "\x1b\\"
const MaxClipBytes = 512 * 1024
const MaxDurationSeconds = 10

type Capabilities struct {
	Version             int      `json:"version"`
	Formats             []string `json:"formats"`
	MaxClipBytes        int      `json:"maxClipBytes"`
	MaxDurationSeconds  int      `json:"maxDurationSeconds"`
	Mixing              bool     `json:"mixing"`
	MaxClipsPerTerminal int      `json:"maxClipsPerTerminal"`
	MaxClipsPerPage     int      `json:"maxClipsPerPage"`
	Streaming           bool     `json:"streaming"`
	StreamVersion       int      `json:"streamVersion"`
	StreamFormats       []string `json:"streamFormats"`
	MinBufferMS         int      `json:"minBufferMs"`
	MaxBufferMS         int      `json:"maxBufferMs"`
}

func Supported() Capabilities {
	return Capabilities{Version: 1, Formats: []string{"wav", "mp3"}, MaxClipBytes: MaxClipBytes, MaxDurationSeconds: MaxDurationSeconds,
		Mixing: true, MaxClipsPerTerminal: 4, MaxClipsPerPage: 16, Streaming: true, StreamVersion: 2,
		StreamFormats: []string{"opus"}, MinBufferMS: 100, MaxBufferMS: 2000}
}

// Event is live-only; Data contains validated base64, never a host path or URL.
type Event struct {
	Type     string `json:"type"`
	Epoch    string `json:"epoch"`
	Action   string `json:"action"`
	ID       string `json:"id,omitempty"`
	Format   string `json:"format,omitempty"`
	Data     string `json:"data,omitempty"`
	Token    string `json:"token,omitempty"`
	Sequence uint64 `json:"sequence,omitempty"`
	Channels int    `json:"channels,omitempty"`
	BufferMS int    `json:"bufferMs,omitempty"`
	PreSkip  int    `json:"preSkip,omitempty"`
	Discard  int    `json:"discard,omitempty"`
}

func ValidID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for _, c := range []byte(id) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}

// Parse accepts one native effect record, excluding OSC framing. Invalid
// requests produce no effect or reply. Queries are answered by the host only.
func Parse(command string) (Event, string, bool) {
	p := strings.SplitN(command, ";", 4)
	e := Event{Type: "terminal-audio"}
	switch p[0] {
	case "reset":
		if len(p) != 1 {
			return e, "", false
		}
		e.Action = "reset"
	case "stop":
		if len(p) != 2 || (p[1] != "*" && !ValidID(p[1])) {
			return e, "", false
		}
		e.Action, e.ID = "stop", p[1]
	case "query":
		if len(p) != 2 || !ValidID(p[1]) {
			return e, "", false
		}
		data, _ := json.Marshal(Supported())
		return e, Prefix + "capabilities;" + p[1] + ";" + base64.StdEncoding.EncodeToString(data) + Terminator, true
	case "play":
		if len(p) != 4 || !ValidID(p[1]) || len(p[3]) > base64.StdEncoding.EncodedLen(MaxClipBytes) || strings.ContainsAny(p[3], "\r\n") {
			return e, "", false
		}
		data, err := base64.StdEncoding.Strict().DecodeString(p[3])
		if err != nil || ValidateClip(p[2], data) != nil {
			return e, "", false
		}
		e.Action, e.ID, e.Format, e.Data = "play", p[1], p[2], p[3]
	default:
		return e, "", false
	}
	return e, "", true
}

func DetectFormat(data []byte) string {
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE" {
		return "wav"
	}
	if len(data) >= 3 && (string(data[:3]) == "ID3" || data[0] == 0xff && data[1]&0xe0 == 0xe0) {
		return "mp3"
	}
	return ""
}

func ValidateClip(format string, data []byte) error {
	if len(data) == 0 || len(data) > MaxClipBytes {
		return errors.New("audio clip must contain 1–524288 bytes")
	}
	if format != "wav" && format != "mp3" {
		return errors.New("audio format must be wav or mp3")
	}
	if DetectFormat(data) != format {
		return errors.New("audio header does not match its format")
	}
	if format == "mp3" {
		return nil
	} // The browser validates decoding/channels/duration.
	// Validate RIFF chunks before handing PCM to a browser decoder.
	if uint64(binary.LittleEndian.Uint32(data[4:8]))+8 != uint64(len(data)) {
		return errors.New("invalid WAV length")
	}
	size := len(data)
	var rate, align, channels int
	var samples []byte
	for offset := 12; offset < size; {
		if size-offset < 8 {
			return errors.New("invalid WAV chunk")
		}
		length := binary.LittleEndian.Uint32(data[offset+4 : offset+8])
		offset += 8
		if uint64(length) > uint64(size-offset) {
			return errors.New("invalid WAV chunk length")
		}
		n := int(length)
		chunk := data[offset : offset+n]
		switch string(data[offset-8 : offset-4]) {
		case "fmt ":
			if n < 16 || binary.LittleEndian.Uint16(chunk) != 1 || binary.LittleEndian.Uint16(chunk[14:]) != 16 {
				return errors.New("WAV must use PCM16")
			}
			channels = int(binary.LittleEndian.Uint16(chunk[2:]))
			rate = int(binary.LittleEndian.Uint32(chunk[4:]))
			align = int(binary.LittleEndian.Uint16(chunk[12:]))
			if channels < 1 || channels > 2 || rate < 8000 || rate > 48000 || align != channels*2 || int(binary.LittleEndian.Uint32(chunk[8:])) != rate*align {
				return errors.New("unsupported WAV channels or sample rate")
			}
		case "data":
			if samples != nil {
				return errors.New("multiple WAV data chunks are unsupported")
			}
			samples = chunk
		}
		offset += n + n%2
		if offset > size {
			return errors.New("invalid WAV padding")
		}
	}
	if rate == 0 || len(samples) == 0 || len(samples)%align != 0 || len(samples)/align > rate*MaxDurationSeconds {
		return errors.New("WAV must contain up to 10 seconds of PCM16 audio")
	}
	return nil
}

func Play(id, format string, data []byte) ([]byte, error) {
	if !ValidID(id) {
		return nil, errors.New("invalid clip ID")
	}
	if err := ValidateClip(format, data); err != nil {
		return nil, err
	}
	return []byte(Prefix + "play;" + id + ";" + format + ";" + base64.StdEncoding.EncodeToString(data) + Terminator), nil
}

func Stop(id string) ([]byte, error) {
	if id == "" {
		id = "*"
	}
	if id != "*" && !ValidID(id) {
		return nil, errors.New("invalid clip ID")
	}
	return []byte(Prefix + "stop;" + id + Terminator), nil
}

// CapabilityReply matches only a complete response to the caller's nonce.
func CapabilityReply(data []byte, nonce string) ([]byte, bool) {
	prefix := []byte(Prefix + "capabilities;" + nonce + ";")
	start := bytes.Index(data, prefix)
	if start < 0 {
		return nil, false
	}
	rest := data[start+len(prefix):]
	end := bytes.Index(rest, []byte(Terminator))
	if bell := bytes.IndexByte(rest, 7); bell >= 0 && (end < 0 || bell < end) {
		end = bell
	}
	if end < 0 || end > 4096 {
		return nil, false
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(string(rest[:end]))
	var caps Capabilities
	if err != nil || json.Unmarshal(decoded, &caps) != nil || caps.Version != 1 {
		return nil, false
	}
	return decoded, true
}
