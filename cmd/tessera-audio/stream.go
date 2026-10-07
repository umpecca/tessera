package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"tessera/internal/terminalaudio"
)

type streamOptions struct {
	file, id, encoder string
	bitrate, bufferMS int
}

func parseStreamOptions(args []string) (streamOptions, error) {
	o := streamOptions{encoder: "ffmpeg", bitrate: 128, bufferMS: 500}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "--id", "--ffmpeg", "--bitrate", "--buffer-ms":
			i++
			if i == len(args) {
				return o, fmt.Errorf("%s requires a value", a)
			}
			var err error
			switch a {
			case "--id":
				o.id = args[i]
			case "--ffmpeg":
				o.encoder = args[i]
			case "--bitrate":
				o.bitrate, err = strconv.Atoi(trimK(args[i]))
			case "--buffer-ms":
				o.bufferMS, err = strconv.Atoi(args[i])
			}
			if err != nil {
				return o, fmt.Errorf("invalid %s value", a)
			}
		default:
			if o.file != "" || len(a) > 1 && a[0] == '-' {
				return o, errors.New("stream requires one file or - for stdin")
			}
			o.file = a
		}
	}
	if o.file == "" || o.bitrate < 16 || o.bitrate > 256 || o.bufferMS < 100 || o.bufferMS > 2000 || o.id != "" && !terminalaudio.ValidID(o.id) {
		return o, errors.New("usage: tessera-audio stream <file|-> [--id ID] [--bitrate 16k..256k] [--buffer-ms 100..2000] [--ffmpeg PATH]")
	}
	return o, nil
}

func trimK(s string) string {
	if len(s) > 0 && (s[len(s)-1] == 'k' || s[len(s)-1] == 'K') {
		return s[:len(s)-1]
	}
	return s
}

func stream(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	o, err := parseStreamOptions(args)
	if err != nil {
		return err
	}
	encoder, err := exec.LookPath(o.encoder)
	if err != nil {
		return errors.New("streaming requires FFmpeg with libopus; install FFmpeg or use --ffmpeg PATH")
	}
	if o.id == "" {
		o.id, err = randomID()
		if err != nil {
			return err
		}
	}
	token, err := randomID()
	if err != nil {
		return err
	}
	file := o.file
	if file == "-" {
		file = "pipe:0"
	} else {
		f, err := os.Open(file)
		if err != nil {
			return err
		}
		f.Close()
	}
	// Read-rate pacing and short Ogg pages keep both memory and transport bursts
	// bounded. Arguments are passed directly; filenames cannot become commands.
	argv := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-readrate", "1", "-i", file,
		"-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", strconv.Itoa(o.bitrate) + "k",
		"-frame_duration", "20", "-application", "audio", "-f", "ogg", "-page_duration", "100000", "-flush_packets", "1", "pipe:1"}
	cmd := exec.CommandContext(ctx, encoder, argv...)
	if o.file == "-" {
		cmd.Stdin = input
	}
	cmd.Stderr = os.Stderr
	encoded, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	started := false
	var sequence uint64
	var header []byte
	var batch []byte
	emit := func(e terminalaudio.Event) error {
		e.ID, e.Token = o.id, token
		_, err := output.Write(terminalaudio.StreamSequence(e))
		return err
	}
	flush := func(discard int) error {
		if len(batch) == 0 {
			return nil
		}
		err := emit(terminalaudio.Event{Action: "stream-data", Sequence: sequence, Discard: discard, Data: base64.StdEncoding.EncodeToString(batch)})
		sequence++
		batch = nil
		return err
	}
	var samples uint64
	frames := 0
	err = readOgg(encoded, func(packet []byte, final bool, granule uint64) error {
		if header == nil {
			if len(packet) != 19 || !bytes.Equal(packet[:8], []byte("OpusHead")) || packet[8] != 1 || packet[9] != 2 || packet[18] != 0 || binary.LittleEndian.Uint16(packet[16:]) != 0 {
				return errors.New("FFmpeg produced unsupported Opus setup")
			}
			header = append([]byte(nil), packet...)
			if err := emit(terminalaudio.Event{Action: "stream-start", Channels: 2, BufferMS: o.bufferMS, PreSkip: int(binary.LittleEndian.Uint16(header[10:]))}); err != nil {
				return err
			}
			started = true
			return nil
		}
		if bytes.HasPrefix(packet, []byte("OpusTags")) {
			return nil
		}
		var length [2]byte
		binary.LittleEndian.PutUint16(length[:], uint16(len(packet)))
		one := append(length[:], packet...)
		if len(terminalaudio.StreamFrames(one)) != 1 {
			return errors.New("FFmpeg produced an unsupported Opus packet")
		}
		batch = append(batch, one...)
		frames++
		samples += 960
		discard := 0
		if final {
			if granule > samples || samples-granule >= 960 {
				return errors.New("invalid final Opus granule")
			}
			discard = int(samples - granule)
		}
		if frames == terminalaudio.MaxBatchFrames || final {
			frames = 0
			return flush(discard)
		}
		return nil
	})
	if err != nil {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if err == nil {
		err = waitErr
	}
	if err == nil && !started {
		err = errors.New("input contained no Opus audio")
	}
	if err == nil {
		err = flush(0)
	}
	if started {
		if err == nil {
			err = emit(terminalaudio.Event{Action: "stream-end", Sequence: sequence})
		} else {
			// Stop the generation that failed; a newer stream with this ID survives.
			_ = emit(terminalaudio.Event{Action: "stream-abort"})
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// Ogg framing is needed only in the helper; browsers receive raw Opus packets.
// Validate pages and bound continuations before allocating a packet.
func readOgg(r io.Reader, emit func([]byte, bool, uint64) error) error {
	var packet []byte
	var serial, next uint32
	first := true
	ended := false
	for {
		header := make([]byte, 27)
		_, err := io.ReadFull(r, header)
		if err == io.EOF {
			if ended && len(packet) == 0 {
				return nil
			}
			return errors.New("truncated Opus stream")
		}
		if err != nil {
			return err
		}
		if ended || string(header[:4]) != "OggS" || header[4] != 0 || header[5]&0xf8 != 0 {
			return errors.New("invalid Ogg page")
		}
		pageSerial, seq := binary.LittleEndian.Uint32(header[14:]), binary.LittleEndian.Uint32(header[18:])
		if first {
			serial = pageSerial
			first = false
			if seq != 0 || header[5]&2 == 0 {
				return errors.New("missing Ogg beginning")
			}
		}
		if pageSerial != serial || seq != next || (header[5]&1 != 0) != (len(packet) > 0) {
			return errors.New("discontinuous Ogg stream")
		}
		next++
		laces := make([]byte, int(header[26]))
		if _, err := io.ReadFull(r, laces); err != nil {
			return err
		}
		size := 0
		for _, n := range laces {
			size += int(n)
		}
		body := make([]byte, size)
		if _, err := io.ReadFull(r, body); err != nil {
			return err
		}
		crc := binary.LittleEndian.Uint32(header[22:])
		clear(header[22:26])
		page := append(append(header, laces...), body...)
		if oggCRC(page) != crc {
			return errors.New("invalid Ogg checksum")
		}
		ended = header[5]&4 != 0
		offset := 0
		for i, n := range laces {
			if len(packet)+int(n) > 65536 {
				return errors.New("Ogg packet exceeds limit")
			}
			packet = append(packet, body[offset:offset+int(n)]...)
			offset += int(n)
			if n < 255 {
				if err := emit(packet, ended && i == len(laces)-1, binary.LittleEndian.Uint64(header[6:])); err != nil {
					return err
				}
				packet = nil
			}
		}
	}
}

func oggCRC(data []byte) uint32 {
	var crc uint32
	for _, b := range data {
		crc ^= uint32(b) << 24
		for range 8 {
			if crc&0x80000000 != 0 {
				crc = crc<<1 ^ 0x04c11db7
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}
