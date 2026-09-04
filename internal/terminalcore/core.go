// Package terminalcore runs Tessera's pinned Ghostty core without a renderer.
// A Core is owned by one managed session and must be accessed serially.
package terminalcore

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

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
}

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
	p, err := c.call("ghostty_wasm_alloc_u8_array", uint64(len(data)))
	if err != nil {
		return err
	}
	if p == 0 {
		return errors.New("terminal input allocation failed")
	}
	defer c.call("ghostty_wasm_free_u8_array", p, uint64(len(data)))
	if !c.module.Memory().Write(uint32(p), data) {
		return errors.New("terminal input exceeds memory")
	}
	_, err = c.call("ghostty_terminal_write", c.handle, p, uint64(len(data)))
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
	p, err := c.call("ghostty_wasm_alloc_u8_array", 4096)
	if err != nil {
		return nil, err
	}
	defer c.call("ghostty_wasm_free_u8_array", p, 4096)
	for {
		n, err := c.call(name, c.handle, p, 4096)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return result, nil
		}
		if n > 4096 {
			return nil, errors.New("invalid terminal reply length")
		}
		data, ok := c.module.Memory().Read(uint32(p), uint32(n))
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
	_, _ = c.call("ghostty_terminal_free", c.handle)
	_ = c.module.Close(context.Background())
	c.module = nil
}
