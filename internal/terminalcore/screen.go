package terminalcore

import (
	"encoding/binary"
	"errors"
	"strings"
)

// Cells as the pinned viewport reader copies them: a 32-bit codepoint,
// colours and flags, the cell's width (0 for the second half of a wide
// character) and how many more codepoints its grapheme has.
const cellBytes = 16
const cellWidthOffset = 11
const cellGraphemeOffset = 14
const maximumGraphemeCodepoints = 16

// ScreenText is the text on screen, one string per row from the top, with
// trailing blanks removed. The host never scrolls, so this is the bottom of
// the output, or a full-screen program's screen.
func (c *Core) ScreenText() ([]string, error) {
	if c == nil || c.module == nil {
		return nil, errors.New("terminal core is closed")
	}
	if _, err := c.call("ghostty_render_state_update", c.handle); err != nil {
		return nil, err
	}
	cols, err := c.call("ghostty_render_state_get_cols", c.handle)
	if err != nil {
		return nil, err
	}
	rows, err := c.call("ghostty_render_state_get_rows", c.handle)
	if err != nil {
		return nil, err
	}
	count := cols * rows
	if count == 0 {
		return nil, nil
	}
	size := count * cellBytes
	p, err := c.call("ghostty_wasm_alloc_u8_array", size)
	if err != nil {
		return nil, err
	}
	if p == 0 {
		return nil, errors.New("terminal screen allocation failed")
	}
	defer c.call("ghostty_wasm_free_u8_array", p, size)
	if n, err := c.call("ghostty_render_state_get_viewport", c.handle, p, count); err != nil {
		return nil, err
	} else if int32(n) < 0 {
		return nil, errors.New("terminal screen is unavailable")
	}
	cells, ok := c.module.Memory().Read(uint32(p), uint32(size))
	if !ok {
		return nil, errors.New("terminal screen exceeds memory")
	}
	cells = append([]byte(nil), cells...)
	lines := make([]string, rows)
	var line strings.Builder
	for row := range rows {
		line.Reset()
		for col := range cols {
			cell := cells[(row*cols+col)*cellBytes:]
			if cell[cellWidthOffset] == 0 {
				continue
			}
			codepoint := rune(binary.LittleEndian.Uint32(cell))
			if codepoint == 0 {
				line.WriteByte(' ')
				continue
			}
			if cell[cellGraphemeOffset] > 0 {
				if grapheme, err := c.grapheme(row, col); err == nil && grapheme != "" {
					line.WriteString(grapheme)
					continue
				}
			}
			line.WriteRune(codepoint)
		}
		lines[row] = strings.TrimRight(line.String(), " ")
	}
	return lines, nil
}

func (c *Core) grapheme(row, col uint64) (string, error) {
	size := uint64(maximumGraphemeCodepoints * 4)
	p, err := c.call("ghostty_wasm_alloc_u8_array", size)
	if err != nil || p == 0 {
		return "", errors.Join(err, errors.New("terminal grapheme allocation failed"))
	}
	defer c.call("ghostty_wasm_free_u8_array", p, size)
	n, err := c.call("ghostty_render_state_get_grapheme", c.handle, row, col, p, maximumGraphemeCodepoints)
	if err != nil || int32(n) <= 0 || n > maximumGraphemeCodepoints {
		return "", err
	}
	data, ok := c.module.Memory().Read(uint32(p), uint32(n*4))
	if !ok {
		return "", errors.New("terminal grapheme exceeds memory")
	}
	var text strings.Builder
	for i := range n {
		text.WriteRune(rune(binary.LittleEndian.Uint32(data[i*4:])))
	}
	return text.String(), nil
}

// WorkingDirectory is the last OSC 7 report, a file:// URL, or "" if the
// shell has sent none.
func (c *Core) WorkingDirectory() (string, error) {
	n, err := c.call("tessera_pwd_length", c.handle)
	if err != nil || n == 0 {
		return "", err
	}
	p, err := c.call("tessera_pwd_data", c.handle)
	if err != nil {
		return "", err
	}
	data, ok := c.module.Memory().Read(uint32(p), uint32(n))
	if !ok {
		return "", errors.New("terminal working directory exceeds memory")
	}
	return string(data), nil
}

// AtPrompt says the cursor is on a row the shell marked as its prompt or
// the command line being typed (OSC 133), so the shell is waiting for a
// command.
func (c *Core) AtPrompt() (bool, error) {
	if c == nil || c.module == nil {
		return false, errors.New("terminal core is closed")
	}
	if _, err := c.call("ghostty_render_state_update", c.handle); err != nil {
		return false, err
	}
	y, err := c.call("ghostty_render_state_get_cursor_y", c.handle)
	if err != nil {
		return false, err
	}
	scrollback, err := c.call("ghostty_terminal_get_scrollback_length", c.handle)
	if err != nil {
		return false, err
	}
	p, err := c.call("ghostty_wasm_alloc_u8_array", 1)
	if err != nil || p == 0 {
		return false, errors.Join(err, errors.New("terminal mark allocation failed"))
	}
	defer c.call("ghostty_wasm_free_u8_array", p, 1)
	if n, err := c.call("tessera_semantic_rows", c.handle, uint64(uint32(scrollback)+uint32(y)), 1, p); err != nil || n != 1 {
		return false, err
	}
	mark, ok := c.module.Memory().ReadByte(uint32(p))
	if !ok {
		return false, errors.New("terminal mark exceeds memory")
	}
	// 1 prompt, 2 prompt continuation, 3 input; 8 marks a soft wrap.
	switch mark &^ 8 {
	case 1, 2, 3:
		return true, nil
	}
	return false, nil
}
