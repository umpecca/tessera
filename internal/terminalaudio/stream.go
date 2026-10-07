package terminalaudio

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
)

const StreamPrefix = "\x1b]777;tessera-audio;2;"
const MaxStreamCommand = 12000
const MaxPacketBytes = 1275
const MaxBatchFrames = 5 // 100 ms of 20 ms Opus packets.

// StreamSequence is also used by applications writing their own terminal I/O.
func StreamSequence(e Event) []byte {
	var command string
	switch e.Action {
	case "stream-start":
		command = fmt.Sprintf("start;%s;%s;opus;%d;%d;%d", e.ID, e.Token, e.Channels, e.BufferMS, e.PreSkip)
	case "stream-data":
		command = fmt.Sprintf("data;%s;%s;%d;%d;%s", e.ID, e.Token, e.Sequence, e.Discard, e.Data)
	case "stream-end":
		command = fmt.Sprintf("end;%s;%s;%d", e.ID, e.Token, e.Sequence)
	case "stream-abort":
		command = fmt.Sprintf("abort;%s;%s", e.ID, e.Token)
	}
	return []byte(StreamPrefix + command + Terminator)
}

func ParseStream(command string) (Event, bool) {
	e := Event{Type: "terminal-audio"}
	if len(command) > MaxStreamCommand {
		return e, false
	}
	p := strings.Split(command, ";")
	if len(p) < 3 || !ValidID(p[1]) || !ValidID(p[2]) {
		return e, false
	}
	e.ID, e.Token = p[1], p[2]
	switch p[0] {
	case "start":
		if len(p) != 7 || p[3] != "opus" {
			return e, false
		}
		var err error
		e.Channels, err = strconv.Atoi(p[4])
		if err != nil || e.Channels < 1 || e.Channels > 2 {
			return e, false
		}
		e.BufferMS, err = strconv.Atoi(p[5])
		if err != nil || e.BufferMS < 100 || e.BufferMS > 2000 {
			return e, false
		}
		e.PreSkip, err = strconv.Atoi(p[6])
		if err != nil || e.PreSkip < 0 || e.PreSkip > 65535 {
			return e, false
		}
		e.Action, e.Format = "stream-start", "opus"
	case "abort":
		if len(p) != 3 {
			return e, false
		}
		e.Action = "stream-abort"
	case "data", "end":
		if p[0] == "data" && len(p) != 6 || p[0] == "end" && len(p) != 4 {
			return e, false
		}
		var err error
		e.Sequence, err = strconv.ParseUint(p[3], 10, 53)
		if err != nil {
			return e, false
		}
		e.Action = "stream-end"
		if p[0] == "data" {
			e.Discard, err = strconv.Atoi(p[4])
			if err != nil || e.Discard < 0 || e.Discard >= 960 {
				return e, false
			}
			if strings.ContainsAny(p[5], "\r\n") {
				return e, false
			}
			bytes, err := base64.StdEncoding.Strict().DecodeString(p[5])
			if err != nil || len(StreamFrames(bytes)) == 0 {
				return e, false
			}
			e.Action, e.Data = "stream-data", p[5]
		}
	default:
		return e, false
	}
	return e, true
}

// Each batch is a series of little-endian uint16 lengths and 20 ms packets.
func StreamFrames(data []byte) [][]byte {
	var frames [][]byte
	for len(data) > 0 {
		if len(data) < 2 || len(frames) >= MaxBatchFrames {
			return nil
		}
		n := int(binary.LittleEndian.Uint16(data))
		data = data[2:]
		if n < 1 || n > MaxPacketBytes || n > len(data) {
			return nil
		}
		packet := data[:n]
		// V2 accepts one 20 ms frame per packet. FFmpeg is configured accordingly.
		config := packet[0] >> 3
		if packet[0]&3 != 0 || !(config >= 16 && config&3 == 3 || config < 12 && config&3 == 1 || config >= 12 && config < 16 && config&1 == 1) {
			return nil
		}
		frames = append(frames, packet)
		data = data[n:]
	}
	return frames
}
