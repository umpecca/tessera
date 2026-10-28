package rdpsession

import (
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

// The byte formats shared with the headless module (ironrdp-headless's
// wire.rs in third_party/ironrdp/patches). Integers are little-endian and
// strings are [u16 length][UTF-8].

// Host message tags, the first byte of what recv hands the module.
const (
	tagServerBytes    = 0
	tagSuppressOutput = 1
	tagQuit           = 2
	tagInput          = 3
	tagResize         = 4
	tagRefresh        = 5
)

// Event kinds the module reports.
const (
	eventLog             = 1
	eventConnected       = 2
	eventH264            = 3
	eventImage           = 4
	eventReconnectCookie = 5
	eventSessionID       = 6
	eventEnded           = 7
	eventDesktopSize     = 8
)

// End is how a module run ended, the first byte of its Ended event.
type End uint8

const (
	EndQuit End = iota
	// EndConnectionLost means the connection failed without the server
	// ending the session, which a rejoin can resume.
	EndConnectionLost
	EndServer
	EndError
)

const (
	configH264   = 1
	configRejoin = 2
)

// Config is what one run of the module connects with.
type Config struct {
	ServerName string
	Username   string
	Password   string
	Domain     string
	Width      int
	Height     int
	H264       bool
	// Rejoin presents the module's last auto-reconnect cookie.
	Rejoin bool
}

var errConfig = errors.New("RDP session configuration is invalid")

func appendString(out []byte, value string) ([]byte, bool) {
	if len(value) > 0xffff {
		return out, false
	}
	out = binary.LittleEndian.AppendUint16(out, uint16(len(value)))
	return append(out, value...), true
}

// encode lays out c as the module's parse_config reads it.
func (c Config) encode() ([]byte, error) {
	if c.Width < 1 || c.Width > 0xffff || c.Height < 1 || c.Height > 0xffff {
		return nil, errConfig
	}
	var out []byte
	for _, field := range []string{c.ServerName, c.Username, c.Password, c.Domain} {
		var ok bool
		if out, ok = appendString(out, field); !ok {
			return nil, errConfig
		}
	}
	out = binary.LittleEndian.AppendUint16(out, uint16(c.Width))
	out = binary.LittleEndian.AppendUint16(out, uint16(c.Height))
	var flags byte
	if c.H264 {
		flags |= configH264
	}
	if c.Rejoin {
		flags |= configRejoin
	}
	return append(out, flags), nil
}

// Input record kinds, as the module's parse_input reads them.
const (
	inputMouseMove   = 1
	inputMouseButton = 2
	inputWheel       = 3
	inputKey         = 4
	inputUnicode     = 5
	inputReleaseAll  = 6
)

// validInput reports whether records is a sequence of whole, valid input
// records. The module ends the session on a record it can't parse, so a
// viewer's input must be checked before it is forwarded.
func validInput(records []byte) bool {
	for len(records) > 0 {
		var size int
		switch records[0] {
		case inputMouseMove:
			size = 5
		case inputMouseButton:
			size = 3
			if len(records) >= 2 && records[1] > 4 {
				return false
			}
		case inputWheel:
			size = 4
		case inputKey:
			size = 4
		case inputUnicode:
			size = 6
			if len(records) >= size && !utf8.ValidRune(rune(binary.LittleEndian.Uint32(records[1:5]))) {
				return false
			}
		case inputReleaseAll:
			size = 1
		default:
			return false
		}
		if len(records) < size {
			return false
		}
		records = records[size:]
	}
	return true
}
