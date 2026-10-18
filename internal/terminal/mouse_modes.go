package terminal

import "strconv"

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
			case 1000, 1002, 1003:
				t.modes[value] = enabled
			}
		}
		start = index + 1
	}
}

func (t *mouseModeTracker) enabled() bool {
	return t.modes[1000] || t.modes[1002] || t.modes[1003]
}

// allows reports whether the current modes ask for an SGR mouse report. Mode
// 1000 reports only presses and releases, 1002 adds drags, and 1003 adds
// movement with no button held; a drag sent to a program in mode 1000 is
// input it never asked for. A report that is not SGR is judged by enabled.
func (t *mouseModeTracker) allows(report []byte) bool {
	if !t.enabled() {
		return false
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

func (t *mouseModeTracker) reset() {
	t.state = mouseParserGround
	t.params = t.params[:0]
}
