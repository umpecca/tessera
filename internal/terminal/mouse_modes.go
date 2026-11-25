package terminal

import (
	"strconv"
	"unicode/utf8"
)

const (
	mouseParserGround = iota
	mouseParserEscape
	mouseParserCSI
	mouseParserPrivate
)

// mouseModeTracker follows the DEC mouse tracking modes that make browser
// pointer events meaningful. Its parser state is retained across PTY reads so
// a mode sequence split between chunks is still applied before input is gated.
type mouseModeTracker struct {
	state  int
	params []byte
	modes  map[int]bool
}

func (t *mouseModeTracker) consume(data []byte) {
	for _, b := range data {
		switch t.state {
		case mouseParserGround:
			if b == 0x1b {
				t.state = mouseParserEscape
			}
		case mouseParserEscape:
			if b == '[' {
				t.state = mouseParserCSI
			} else if b == 'c' {
				// A full reset (RIS) turns mouse tracking and formats off.
				clear(t.modes)
				t.state = mouseParserGround
			} else if b != 0x1b {
				t.state = mouseParserGround
			}
		case mouseParserCSI:
			if b == '?' {
				t.state = mouseParserPrivate
				t.params = t.params[:0]
			} else if b == 0x1b {
				t.state = mouseParserEscape
			} else {
				t.state = mouseParserGround
			}
		case mouseParserPrivate:
			if (b >= '0' && b <= '9') || b == ';' {
				if len(t.params) < 64 {
					t.params = append(t.params, b)
				} else {
					t.reset()
				}
				continue
			}
			if b == 'h' || b == 'l' {
				t.apply(b == 'h')
			}
			if b == 0x1b {
				t.state = mouseParserEscape
				t.params = t.params[:0]
			} else {
				t.reset()
			}
		}
	}
}

func (t *mouseModeTracker) apply(enabled bool) {
	if t.modes == nil {
		t.modes = map[int]bool{}
	}
	start := 0
	for index := 0; index <= len(t.params); index++ {
		if index < len(t.params) && t.params[index] != ';' {
			continue
		}
		if value, err := strconv.Atoi(string(t.params[start:index])); err == nil {
			switch value {
			case 9, 1000, 1002, 1003, 1005, 1006, 1015, 1016:
				t.modes[value] = enabled
			}
		}
		start = index + 1
	}
}

func (t *mouseModeTracker) enabled() bool {
	return t.modes[9] || t.modes[1000] || t.modes[1002] || t.modes[1003]
}

// x10Only reports whether X10 compatibility tracking (mode 9) is the only
// tracking mode on. With 1000, 1002 or 1003 also set, those win, as the most
// capable format does in encode.
func (t *mouseModeTracker) x10Only() bool {
	return t.modes[9] && !t.modes[1000] && !t.modes[1002] && !t.modes[1003]
}

// allows reports whether the current modes ask for an SGR mouse report. Mode
// 9 reports only presses of the first three buttons, as Ghostty does: no
// releases, drags, movement or wheel. Mode 1000 reports presses and
// releases, 1002 adds drags, and 1003 adds movement with no button held; a
// drag sent to a program in mode 1000 is input it never asked for. A report
// that is not SGR is judged by enabled.
func (t *mouseModeTracker) allows(report []byte) bool {
	if !t.enabled() {
		return false
	}
	if t.x10Only() {
		code, _, _, release, ok := parseSGRMouseReport(report)
		return !ok || (!release && code&(32|64|128) == 0 && code&3 != 3)
	}
	code, ok := sgrMouseButtonCode(report)
	if !ok || code&64 != 0 || code&32 == 0 {
		return true
	}
	if code&3 == 3 {
		return t.modes[1003]
	}
	return t.modes[1002] || t.modes[1003]
}

// encode rewrites a browser's SGR report in the format the program asked
// for, or returns nil when that format cannot carry it. The browser always
// sends SGR (in pixels while it sees mode 1016), so SGR and SGR-Pixels pass
// through. With several formats set the most capable wins, which is the
// browser's choice for 1016 too: 1016, then 1006, 1015 (urxvt), 1005
// (UTF-8), and X10 when none is set. The legacy formats have no release
// final byte; like xterm and Ghostty they report a release as button 3 with
// the modifier bits. Mode 9 alone reports the button without modifiers.
// Reports that are not SGR pass through.
func (t *mouseModeTracker) encode(report []byte) []byte {
	x10 := t.x10Only()
	if (t.modes[1016] || t.modes[1006]) && !x10 {
		return report
	}
	code, col, row, release, ok := parseSGRMouseReport(report)
	if !ok {
		return report
	}
	if x10 {
		code &= 3
		if t.modes[1016] || t.modes[1006] {
			return []byte("\x1b[<" + strconv.Itoa(code) + ";" + strconv.Itoa(col) + ";" + strconv.Itoa(row) + "M")
		}
	}
	if release {
		code = 3 | code&(4|8|16)
	}
	switch {
	case t.modes[1015]:
		return []byte("\x1b[" + strconv.Itoa(32+code) + ";" + strconv.Itoa(col) + ";" + strconv.Itoa(row) + "M")
	case t.modes[1005]:
		// UTF-8 extends X10 up to code point 2047, as xterm does.
		if col > 2015 || row > 2015 || 32+code > 2047 {
			return nil
		}
		out := []byte("\x1b[M")
		for _, value := range []int{32 + code, 32 + col, 32 + row} {
			out = utf8.AppendRune(out, rune(value))
		}
		return out
	default:
		// One byte each: cells past 223 cannot be written.
		if col > 223 || row > 223 || 32+code > 255 {
			return nil
		}
		return []byte{0x1b, '[', 'M', byte(32 + code), byte(32 + col), byte(32 + row)}
	}
}

// sgrMouseButtonCode reads the button code of an `ESC [ < code ; col ; row M`
// report.
func sgrMouseButtonCode(report []byte) (int, bool) {
	const prefix = "\x1b[<"
	if len(report) <= len(prefix) || string(report[:len(prefix)]) != prefix {
		return 0, false
	}
	end := len(prefix)
	for end < len(report) && report[end] >= '0' && report[end] <= '9' {
		end++
	}
	if end == len(prefix) || end == len(report) || report[end] != ';' {
		return 0, false
	}
	code, err := strconv.Atoi(string(report[len(prefix):end]))
	return code, err == nil
}

// parseSGRMouseReport reads a whole `ESC [ < code ; col ; row M` or `m`
// report; `m` is a release.
func parseSGRMouseReport(report []byte) (code, col, row int, release, ok bool) {
	const prefix = "\x1b[<"
	if len(report) < len(prefix)+6 || string(report[:len(prefix)]) != prefix {
		return 0, 0, 0, false, false
	}
	final := report[len(report)-1]
	if final != 'M' && final != 'm' {
		return 0, 0, 0, false, false
	}
	var values [3]int
	field, digits := 0, 0
	for _, b := range report[len(prefix) : len(report)-1] {
		switch {
		case b >= '0' && b <= '9' && digits < 6:
			values[field] = values[field]*10 + int(b-'0')
			digits++
		case b == ';' && digits > 0 && field < 2:
			field++
			digits = 0
		default:
			return 0, 0, 0, false, false
		}
	}
	if field != 2 || digits == 0 || values[1] < 1 || values[2] < 1 {
		return 0, 0, 0, false, false
	}
	return values[0], values[1], values[2], final == 'm', true
}

func (t *mouseModeTracker) reset() {
	t.state = mouseParserGround
	t.params = t.params[:0]
}
