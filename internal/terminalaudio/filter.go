package terminalaudio

// StreamFilter removes v2 OSC from the PTY before both the native core and
// retained output. V1 and every unrelated byte pass through unchanged. Its
// partial stream requests are transient, so snapshots cannot carry audio.
type StreamFilter struct {
	state      byte
	stringKind byte
	pending    []byte
	command    []byte
	oversized  bool
}

type Part struct {
	Text  []byte
	Audio *Event
}

func (f *StreamFilter) Feed(input []byte) []Part {
	var parts []Part
	var text []byte
	emit := func() {
		if len(text) > 0 {
			parts = append(parts, Part{Text: text})
			text = nil
		}
	}
	for _, b := range input {
		switch f.state {
		case 'p': // A possible OSC prefix; hold only until the namespace is known.
			f.pending = append(f.pending, b)
			prefix := []byte(StreamPrefix)
			if len(f.pending) <= len(prefix) && string(f.pending) == string(prefix[:len(f.pending)]) {
				if len(f.pending) == len(prefix) {
					f.state = 'a'
					f.pending = nil
					f.command = nil
					f.oversized = false
				}
				continue
			}
			text = append(text, f.pending...)
			f.pending = nil
			f.state, f.stringKind = 's', ']'
			if b == 7 || b == 0x18 || b == 0x1a {
				f.state = 0
			} else if b == 0x1b {
				text = text[:len(text)-1]
				f.state = 'e'
			}
		case 'a', 't': // Consumed stream OSC and its possible ST.
			if f.state == 't' && b != '\\' {
				f.command = nil
				f.state = 'e'
				// Reprocess the escape's following byte, preserving ordinary parsing.
				if b == ']' {
					f.pending = []byte{0x1b, ']'}
					f.state = 'p'
				} else {
					text = append(text, 0x1b, b)
					f.state = 0
					if b == 'P' || b == '_' || b == '^' || b == 'X' {
						f.state, f.stringKind = 's', b
					} else if b == 0x1b {
						text = text[:len(text)-1]
						f.state = 'e'
					}
				}
				continue
			}
			if b == 7 || f.state == 't' && b == '\\' {
				if !f.oversized {
					if e, ok := ParseStream(string(f.command)); ok {
						emit()
						parts = append(parts, Part{Audio: &e})
					}
				}
				f.state = 0
				f.command = nil
			} else if b == 0x18 || b == 0x1a {
				f.state = 0
				f.command = nil
				text = append(text, b)
			} else if b == 0x1b {
				f.state = 't'
			} else if len(f.command) < MaxStreamCommand {
				f.command = append(f.command, b)
			} else {
				f.oversized = true
			}
		case 'e':
			if b == ']' {
				f.pending = []byte{0x1b, ']'}
				f.state = 'p'
				continue
			}
			text = append(text, 0x1b, b)
			f.state = 0
			if b == 'P' || b == '_' || b == '^' || b == 'X' {
				f.state, f.stringKind = 's', b
			} else if b == 0x1b {
				text = text[:len(text)-1]
				f.state = 'e'
			}
		case 's':
			if b == 0x1b {
				f.state = 'e'
				continue
			}
			text = append(text, b)
			if b == 0x18 || b == 0x1a || b == 7 && f.stringKind == ']' {
				f.state = 0
			}
		default:
			if b == 0x1b {
				f.state = 'e'
			} else {
				text = append(text, b)
			}
		}
	}
	emit()
	return parts
}
