// Package terminalcore runs Tessera's pinned Ghostty core without a renderer.
// A Core is owned by one managed session and must be accessed serially.
package terminalcore

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"tessera/internal/terminalaudio"
	"tessera/internal/terminalfile"
	"tessera/internal/version"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed ghostty-vt.wasm
var WASM []byte

var Compatibility = func() string { h := sha256.Sum256(WASM); return hex.EncodeToString(h[:]) }()

var runtimeOnce sync.Once
var sharedRuntime wazero.Runtime
var compiled wazero.CompiledModule
var runtimeError error

func initialize() {
	ctx := context.Background()
	sharedRuntime = wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithMemoryLimitPages(8192))
	_, runtimeError = sharedRuntime.NewHostModuleBuilder("env").NewFunctionBuilder().WithFunc(func(uint32, uint32) {}).Export("log").Instantiate(ctx)
	if runtimeError == nil {
		compiled, runtimeError = sharedRuntime.CompileModule(ctx, WASM)
	}
}

type Core struct {
	module    api.Module
	handle    uint64
	functions map[string]api.Function
	// Scratch allocations belong to this module, not a retained memory view.
	// A managed session serializes all writes and response drains.
	inputPtr      uint64
	inputCapacity int
	responsePtr   uint64
}

const minimumInputBufferBytes = 8 * 1024
const maximumInputBufferBytes = 64 * 1024
const responseBufferBytes = 4 * 1024

func New(cols, rows int) (*Core, error) {
	if cols < 2 || cols > 4096 || rows < 1 || rows > 4096 {
		return nil, errors.New("invalid terminal dimensions")
	}
	runtimeOnce.Do(initialize)
	if runtimeError != nil {
		return nil, runtimeError
	}
	module, err := sharedRuntime.InstantiateModule(context.Background(), compiled, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, err
	}
	c := &Core{module: module, functions: make(map[string]api.Function)}
	handle, err := c.call("ghostty_terminal_new", uint64(cols), uint64(rows))
	if err != nil || handle == 0 {
		_ = module.Close(context.Background())
		return nil, fmt.Errorf("create terminal core: %w", errors.Join(err, errors.New("allocation failed")))
	}
	c.handle = handle
	if err := c.Configure(false); err != nil {
		c.Close()
		return nil, err
	}
	// Ghostty starts focused; the host's core is focused only while a browser
	// says so.
	if err := c.SetFocus(false); err != nil {
		c.Close()
		return nil, err
	}
	// XTVERSION names the build, without the release tag's "v".
	if err := c.setVersion(strings.TrimPrefix(version.Version, "v")); err != nil {
		c.Close()
		return nil, err
	}
	if err := c.Resize(cols, rows, 8, 16); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Core) Configure(light bool) error {
	var value uint64
	if light {
		value = 1
	}
	_, err := c.call("tessera_sixel_configure", c.handle, value)
	return err
}

// SetFocus says whether a browser has the pane focused. A program that
// enabled focus reports (mode 1004) is told of a change through Replies.
func (c *Core) SetFocus(focused bool) error {
	var value uint64
	if focused {
		value = 1
	}
	_, err := c.call("tessera_focus", c.handle, value)
	return err
}

func (c *Core) setVersion(text string) error {
	return c.setText("tessera_set_version", text)
}

// SetTermName gives the TERM programs run with, which capability queries
// (XTGETTCAP) report as the terminal's name.
func (c *Core) SetTermName(name string) error {
	return c.setText("tessera_set_term_name", name)
}

func (c *Core) setText(function, text string) error {
	if text == "" {
		return nil
	}
	p, err := c.call("ghostty_wasm_alloc_u8_array", uint64(len(text)))
	if err != nil {
		return err
	}
	if p == 0 {
		return errors.New("terminal text allocation failed")
	}
	defer c.call("ghostty_wasm_free_u8_array", p, uint64(len(text)))
	if !c.module.Memory().Write(uint32(p), []byte(text)) {
		return errors.New("terminal text exceeds memory")
	}
	_, err = c.call(function, c.handle, p, uint64(len(text)))
	return err
}

// Progress is the program's last OSC 9;4 report. Revision counts reports,
// wrapping. State is 0 remove, 1 set, 2 error, 3 indeterminate or 4 pause;
// Percent is 0-100, or -1 when the report gave none.
func (c *Core) Progress() (revision uint32, state int, percent int, err error) {
	value, err := c.call("tessera_progress_revision", c.handle)
	if err != nil {
		return 0, 0, 0, err
	}
	report, err := c.call("tessera_progress", c.handle)
	if err != nil {
		return 0, 0, 0, err
	}
	percent = int(report>>8) & 255
	if percent == 255 {
		percent = -1
	}
	return uint32(value), int(report & 255), percent, nil
}

// SynchronizedOutputStarts counts the program turning synchronized output
// (mode 2026) on, wrapping.
func (c *Core) SynchronizedOutputStarts() (uint32, error) {
	value, err := c.call("tessera_synchronized_output_starts", c.handle)
	return uint32(value), err
}

// EndSynchronizedOutput turns synchronized output off and reports whether
// it was on.
func (c *Core) EndSynchronizedOutput() (bool, error) {
	value, err := c.call("tessera_end_synchronized_output", c.handle)
	return value != 0, err
}

// BellCount counts the bells the program has rung, wrapping.
func (c *Core) BellCount() (uint32, error) {
	value, err := c.call("tessera_bell_count", c.handle)
	return uint32(value), err
}

// Notification is one OSC 9 or OSC 777 desktop notification. OSC 9 has no
// title.
type Notification struct {
	Title string
	Body  string
}

// Notifications drains the queued desktop notifications.
func (c *Core) Notifications() ([]Notification, error) {
	data, err := c.drain("tessera_notification_read")
	if err != nil {
		return nil, err
	}
	var notifications []Notification
	for len(data) >= 4 {
		n := int(binary.LittleEndian.Uint32(data))
		data = data[4:]
		if n > len(data) {
			return nil, errors.New("invalid terminal notification")
		}
		title, body, ok := bytes.Cut(data[:n], []byte{0})
		if !ok {
			return nil, errors.New("invalid terminal notification")
		}
		notifications = append(notifications, Notification{Title: string(title), Body: string(body)})
		data = data[n:]
	}
	if len(data) != 0 {
		return nil, errors.New("invalid terminal notification framing")
	}
	return notifications, nil
}

// CommandEvent is a command starting (OSC 133;C, with the command line if
// the shell sent one) or finishing (OSC 133;D, with its status, or -1).
type CommandEvent struct {
	Started bool
	Line    string
	Status  int
}

// Commands drains the command starts and ends since the last call.
func (c *Core) Commands() ([]CommandEvent, error) {
	data, err := c.drain("tessera_command_read")
	if err != nil {
		return nil, err
	}
	var events []CommandEvent
	for len(data) >= 4 {
		n := int(binary.LittleEndian.Uint32(data))
		data = data[4:]
		if n < 2 || n > len(data) {
			return nil, errors.New("invalid terminal command event")
		}
		switch kind, code := data[0], data[1]; kind {
		case 1:
			events = append(events, CommandEvent{Started: true, Line: string(data[2:n]), Status: -1})
		case 2:
			events = append(events, CommandEvent{Status: int(code)})
		case 3:
			events = append(events, CommandEvent{Status: -1})
		default:
			return nil, errors.New("invalid terminal command event")
		}
		data = data[n:]
	}
	if len(data) != 0 {
		return nil, errors.New("invalid terminal command event framing")
	}
	return events, nil
}

func (c *Core) ImageSettings() (memoryMiB int, placeholders bool, err error) {
	value, err := c.call("tessera_sixel_image_settings_read", c.handle)
	return int(value & 255), value&256 != 0, err
}

func (c *Core) ConfigureImages(memoryMiB int, placeholders bool) error {
	if memoryMiB != 16 && memoryMiB != 32 && memoryMiB != 64 {
		return errors.New("image memory must be 16, 32, or 64 MiB")
	}
	var show uint64
	if placeholders {
		show = 1
	}
	result, err := c.call("tessera_sixel_image_settings", c.handle, uint64(memoryMiB), show)
	if err != nil {
		return err
	}
	if result == 0 {
		return errors.New("invalid image settings")
	}
	return nil
}

func (c *Core) ClearImages() error {
	_, err := c.call("tessera_sixel_clear_images", c.handle)
	return err
}

func (c *Core) call(name string, args ...uint64) (uint64, error) {
	if c == nil || c.module == nil {
		return 0, errors.New("terminal core is closed")
	}
	f := c.functions[name]
	if f == nil {
		f = c.module.ExportedFunction(name)
		if f == nil {
			return 0, fmt.Errorf("terminal core is missing %s", name)
		}
		c.functions[name] = f
	}
	result, err := f.Call(context.Background(), args...)
	if err != nil {
		return 0, fmt.Errorf("terminal core %s: %w", name, err)
	}
	if len(result) == 0 {
		return 0, nil
	}
	return result[0], nil
}

func (c *Core) Write(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if c == nil || c.module == nil {
		return errors.New("terminal core is closed")
	}
	p := c.inputPtr
	if len(data) > c.inputCapacity {
		capacity := minimumInputBufferBytes
		for capacity < len(data) && capacity < maximumInputBufferBytes {
			capacity *= 2
		}
		capacity = max(capacity, len(data))
		var err error
		p, err = c.call("ghostty_wasm_alloc_u8_array", uint64(capacity))
		if err != nil {
			return err
		}
		if p == 0 {
			return errors.New("terminal input allocation failed")
		}
		if capacity > maximumInputBufferBytes {
			// Exceptional writes must not retain an oversized scratch region.
			defer c.call("ghostty_wasm_free_u8_array", p, uint64(capacity))
		} else {
			// Allocate first so a failed growth leaves the previous buffer usable.
			if c.inputPtr != 0 {
				_, _ = c.call("ghostty_wasm_free_u8_array", c.inputPtr, uint64(c.inputCapacity))
			}
			c.inputPtr, c.inputCapacity = p, capacity
		}
	}
	if !c.module.Memory().Write(uint32(p), data) {
		return errors.New("terminal input exceeds memory")
	}
	_, err := c.call("ghostty_terminal_write", c.handle, p, uint64(len(data)))
	return err
}

func (c *Core) Resize(cols, rows, cellWidth, cellHeight int) error {
	if cols < 2 || cols > 4096 || rows < 1 || rows > 4096 || cellWidth < 1 || cellWidth > 4096 || cellHeight < 1 || cellHeight > 4096 {
		return errors.New("invalid terminal geometry")
	}
	if _, err := c.call("ghostty_terminal_resize", c.handle, uint64(cols), uint64(rows)); err != nil {
		return err
	}
	_, err := c.call("tessera_sixel_geometry", c.handle, uint64(cellWidth), uint64(cellHeight))
	return err
}

func (c *Core) Snapshot() ([]byte, error) {
	defer c.call("tessera_sixel_snapshot_release", c.handle)
	n, err := c.call("tessera_sixel_snapshot_export", c.handle)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errors.New("terminal snapshot allocation failed")
	}
	p, err := c.call("tessera_sixel_snapshot_data", c.handle)
	if err != nil {
		return nil, err
	}
	data, ok := c.module.Memory().Read(uint32(p), uint32(n))
	if !ok {
		return nil, errors.New("terminal snapshot exceeds memory")
	}
	return append([]byte(nil), data...), nil
}

func (c *Core) Replies() ([]byte, error) {
	return c.drain("ghostty_terminal_read_response")
}

// Audio drains transient native effects separately from terminal replay/state.
func (c *Core) Audio() ([]terminalaudio.Event, []byte, error) {
	data, err := c.drain("tessera_audio_read")
	if err != nil {
		return nil, nil, err
	}
	var events []terminalaudio.Event
	var replies []byte
	for len(data) >= 4 {
		n := int(binary.LittleEndian.Uint32(data))
		data = data[4:]
		if n > len(data) {
			return nil, nil, errors.New("invalid terminal audio effect")
		}
		if event, reply, ok := terminalaudio.Parse(string(data[:n])); ok {
			if reply != "" {
				replies = append(replies, reply...)
			} else {
				events = append(events, event)
			}
		}
		data = data[n:]
	}
	if len(data) != 0 {
		return nil, nil, errors.New("invalid terminal audio effect framing")
	}
	return events, replies, nil
}

// Files drains transient requests; snapshots never own this queue.
func (c *Core) Files() ([]terminalfile.Command, error) {
	data, err := c.drain("tessera_file_read")
	if err != nil {
		return nil, err
	}
	var commands []terminalfile.Command
	for len(data) >= 4 {
		n := int(binary.LittleEndian.Uint32(data))
		data = data[4:]
		if n > len(data) {
			return nil, errors.New("invalid terminal file effect")
		}
		if c, ok := terminalfile.Parse(string(data[:n])); ok {
			commands = append(commands, c)
		}
		data = data[n:]
	}
	if len(data) != 0 {
		return nil, errors.New("invalid terminal file framing")
	}
	return commands, nil
}

func (c *Core) Clipboard() ([][]byte, error) {
	data, err := c.drain("tessera_sixel_clipboard_read")
	if err != nil {
		return nil, err
	}
	var writes [][]byte
	for len(data) >= 4 {
		n := int(binary.LittleEndian.Uint32(data))
		data = data[4:]
		if n > len(data) {
			return nil, errors.New("invalid terminal clipboard effect")
		}
		decoded, err := base64.StdEncoding.DecodeString(string(data[:n]))
		if err == nil && len(decoded) > 0 {
			writes = append(writes, decoded)
		}
		data = data[n:]
	}
	return writes, nil
}

func (c *Core) drain(name string) ([]byte, error) {
	var result []byte
	if c == nil || c.module == nil {
		return nil, errors.New("terminal core is closed")
	}
	if c.responsePtr == 0 {
		p, err := c.call("ghostty_wasm_alloc_u8_array", responseBufferBytes)
		if err != nil {
			return nil, err
		}
		if p == 0 {
			return nil, errors.New("terminal response allocation failed")
		}
		c.responsePtr = p
	}
	for {
		n, err := c.call(name, c.handle, c.responsePtr, responseBufferBytes)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return result, nil
		}
		if n > responseBufferBytes {
			return nil, errors.New("invalid terminal reply length")
		}
		data, ok := c.module.Memory().Read(uint32(c.responsePtr), uint32(n))
		if !ok {
			return nil, errors.New("terminal reply exceeds memory")
		}
		result = append(result, data...)
	}
}

func (c *Core) Close() {
	if c == nil || c.module == nil {
		return
	}
	if c.inputPtr != 0 {
		_, _ = c.call("ghostty_wasm_free_u8_array", c.inputPtr, uint64(c.inputCapacity))
	}
	if c.responsePtr != 0 {
		_, _ = c.call("ghostty_wasm_free_u8_array", c.responsePtr, responseBufferBytes)
	}
	c.inputPtr, c.inputCapacity, c.responsePtr = 0, 0, 0
	_, _ = c.call("ghostty_terminal_free", c.handle)
	_ = c.module.Close(context.Background())
	c.module = nil
}
