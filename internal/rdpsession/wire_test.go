package rdpsession

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

func TestConfigEncoding(t *testing.T) {
	got, err := Config{ServerName: "h", Username: "u", Password: "pw", Domain: "", Width: 1216, Height: 640, H264: true, Rejoin: true}.encode()
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{
		1, 0, 'h',
		1, 0, 'u',
		2, 0, 'p', 'w',
		0, 0,
		0xc0, 0x04, 0x80, 0x02,
		configH264 | configRejoin,
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("encode = %v, want %v", got, want)
	}
}

func TestConfigEncodingRejectsOutOfRangeValues(t *testing.T) {
	for _, config := range []Config{
		{Width: 0, Height: 640},
		{Width: 1216, Height: 70000},
		{Width: 1216, Height: 640, Password: strings.Repeat("x", 70000)},
	} {
		if _, err := config.encode(); !errors.Is(err, errConfig) {
			t.Fatalf("%+v: err = %v", config, err)
		}
	}
}

func unicodeRecord(r uint32) []byte {
	return append(binary.LittleEndian.AppendUint32([]byte{inputUnicode}, r), 1)
}

func TestValidInput(t *testing.T) {
	valid := [][]byte{
		nil,
		{inputMouseMove, 10, 0, 20, 0},
		{inputMouseButton, 2, 1, inputWheel, 1, 0x88, 0xff},
		{inputKey, 0x5b, 0xe0, 1, inputReleaseAll},
		unicodeRecord(0x20ac),
	}
	for _, records := range valid {
		if !validInput(records) {
			t.Errorf("rejected %v", records)
		}
	}
	invalid := [][]byte{
		{inputMouseMove, 10, 0, 20},
		{inputMouseButton, 5, 1},
		{inputKey, 0x1e},
		unicodeRecord(0xd800),
		unicodeRecord(0x110000),
		{99},
	}
	for _, records := range invalid {
		if validInput(records) {
			t.Errorf("accepted %v", records)
		}
	}
}
