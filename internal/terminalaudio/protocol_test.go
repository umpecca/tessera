package terminalaudio

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"
)

func wav(samples int) []byte {
	b := make([]byte, 44+samples*2)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], uint32(len(b)-8))
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 1)
	binary.LittleEndian.PutUint32(b[24:], 8000)
	binary.LittleEndian.PutUint32(b[28:], 16000)
	binary.LittleEndian.PutUint16(b[32:], 2)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], uint32(samples*2))
	return b
}

func TestPlayRoundTripAndValidation(t *testing.T) {
	for _, tc := range []struct {
		format string
		data   []byte
	}{{"wav", wav(80)}, {"mp3", []byte("ID3sample")}} {
		sequence, err := Play("clip_1", tc.format, tc.data)
		if err != nil {
			t.Fatal(err)
		}
		command := strings.TrimSuffix(strings.TrimPrefix(string(sequence), Prefix), Terminator)
		event, reply, ok := Parse(command)
		if !ok || reply != "" || event.Action != "play" || event.ID != "clip_1" || event.Format != tc.format {
			t.Fatalf("bad event: %+v", event)
		}
		decoded, _ := base64.StdEncoding.DecodeString(event.Data)
		if !bytes.Equal(decoded, tc.data) {
			t.Fatal("clip changed")
		}
	}
	for _, command := range []string{"play;bad id;mp3;SUQz", "play;x;ogg;SUQz", "play;x;mp3;====", "play;x;mp3;SUQz\n", "play;x;mp3;SUQ=", "stop;bad;id", "query;", "query;*", "future;x", "capabilities;x;e30="} {
		if _, _, ok := Parse(command); ok {
			t.Fatalf("accepted %q", command)
		}
	}
	for _, data := range [][]byte{wav(0), wav(80001), []byte("RIFF"), wav(1)[:43]} {
		if ValidateClip("wav", data) == nil {
			t.Fatal("accepted invalid WAV")
		}
	}
	if ValidateClip("wav", wav(80000)) != nil {
		t.Fatal("rejected exactly 10 seconds")
	}
	data := make([]byte, MaxClipBytes)
	copy(data, "ID3")
	if _, err := Play("max", "mp3", data); err != nil {
		t.Fatal(err)
	}
	if _, err := Play("large", "mp3", append(data, 0)); err == nil {
		t.Fatal("accepted oversized clip")
	}
	if _, _, ok := Parse("play;x;mp3;" + base64.StdEncoding.EncodeToString(append(data, 0))); ok {
		t.Fatal("accepted oversized OSC")
	}
}

func TestStopAndCapabilities(t *testing.T) {
	for _, id := range []string{"*", "clip", ""} {
		sequence, err := Stop(id)
		if err != nil || !bytes.HasSuffix(sequence, []byte(Terminator)) {
			t.Fatal(err)
		}
	}
	if _, err := Stop("bad id"); err == nil {
		t.Fatal("accepted bad ID")
	}
	_, reply, ok := Parse("query;nonce-1")
	if !ok || !strings.Contains(reply, "capabilities;nonce-1;") {
		t.Fatal("missing capability response")
	}
	for split := 0; split < len(reply); split++ {
		if _, ok := CapabilityReply([]byte(reply[:split]), "nonce-1"); ok {
			t.Fatal("incomplete response accepted")
		}
	}
	if _, ok := CapabilityReply([]byte(reply), "wrong"); ok {
		t.Fatal("unmatched nonce accepted")
	}
	data, ok := CapabilityReply([]byte("noise"+reply), "nonce-1")
	if !ok || !bytes.Contains(data, []byte(`"mixing":true`)) {
		t.Fatal("missing mixing capability")
	}
}
