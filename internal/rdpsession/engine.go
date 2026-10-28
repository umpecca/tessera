// Package rdpsession keeps RDP sessions open on the Tessera host: an RDP
// client runs here, in IronRDP's headless WebAssembly module, and browsers
// attach to its sessions as viewers (task 238).
package rdpsession

import (
	"context"
	"crypto/rand"
	_ "embed"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// The headless RDP client, built from IronRDP with third_party/ironrdp/patches.
//
//go:embed ironrdp_headless.wasm
var moduleWASM []byte

// recvCapacity bounds one message the module receives, as its recv buffer
// does (64 KiB).
const recvCapacity = 64 * 1024

// Link is one connection a module run uses: the host side of the module's
// tessera imports.
type Link interface {
	// Recv blocks until there is a message for the session, a tag and its
	// payload, and returns nil when the connection is gone.
	Recv() []byte
	Send([]byte) error
	// UpgradeTLS upgrades the connection to TLS, verifying the server's
	// certificate, and returns the server's public key for CredSSP.
	UpgradeTLS() ([]byte, error)
	Event(kind uint32, payload []byte)
}

// Engine compiles the headless module once and runs instances of it.
type Engine struct {
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
	names    atomic.Uint64

	mu    sync.Mutex
	links map[string]Link
}

// NewEngine compiles the module. With cacheDir set, compiled code is cached
// there, which makes later starts take milliseconds instead of about a second.
func NewEngine(ctx context.Context, cacheDir string) (*Engine, error) {
	config := wazero.NewRuntimeConfig()
	if cacheDir != "" {
		cache, err := wazero.NewCompilationCacheWithDir(cacheDir)
		if err != nil {
			return nil, fmt.Errorf("RDP module cache: %w", err)
		}
		config = config.WithCompilationCache(cache)
	}
	e := &Engine{runtime: wazero.NewRuntimeWithConfig(ctx, config), links: map[string]Link{}}
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, e.runtime); err != nil {
		_ = e.runtime.Close(ctx)
		return nil, err
	}
	_, err := e.runtime.NewHostModuleBuilder("tessera").
		NewFunctionBuilder().WithFunc(e.recv).Export("recv").
		NewFunctionBuilder().WithFunc(e.send).Export("send").
		NewFunctionBuilder().WithFunc(e.upgradeTLS).Export("upgrade_tls").
		NewFunctionBuilder().WithFunc(e.event).Export("event").
		Instantiate(ctx)
	if err == nil {
		e.compiled, err = e.runtime.CompileModule(ctx, moduleWASM)
	}
	if err != nil {
		_ = e.runtime.Close(ctx)
		return nil, fmt.Errorf("RDP module: %w", err)
	}
	return e, nil
}

func (e *Engine) Close(ctx context.Context) error {
	return e.runtime.Close(ctx)
}

func (e *Engine) link(m api.Module) Link {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.links[m.Name()]
}

func (e *Engine) recv(_ context.Context, m api.Module, ptr, capacity uint32) int32 {
	l := e.link(m)
	if l == nil {
		return -1
	}
	message := l.Recv()
	if message == nil {
		return 0
	}
	if uint32(len(message)) > capacity || !m.Memory().Write(ptr, message) {
		return -1
	}
	return int32(len(message))
}

func (e *Engine) send(_ context.Context, m api.Module, ptr, length uint32) int32 {
	l := e.link(m)
	bytes, ok := m.Memory().Read(ptr, length)
	if l == nil || !ok {
		return -1
	}
	if l.Send(bytes) != nil {
		return -1
	}
	return 0
}

func (e *Engine) upgradeTLS(_ context.Context, m api.Module, ptr, capacity uint32) int32 {
	l := e.link(m)
	if l == nil {
		return -1
	}
	key, err := l.UpgradeTLS()
	if err != nil || uint32(len(key)) > capacity || !m.Memory().Write(ptr, key) {
		return -1
	}
	return int32(len(key))
}

func (e *Engine) event(_ context.Context, m api.Module, kind, ptr, length uint32) {
	l := e.link(m)
	payload, ok := m.Memory().Read(ptr, length)
	if l == nil || !ok {
		return
	}
	// The module's memory is reused after the call.
	l.Event(kind, append([]byte(nil), payload...))
}

// Instance is one module instance: one RDP client, which keeps the server's
// auto-reconnect cookie between runs. Runs are serial.
type Instance struct {
	engine *Engine
	module api.Module
}

// NewInstance instantiates the module with real clocks and randomness:
// wazero's defaults are deterministic, and NTLM needs both.
func (e *Engine) NewInstance(ctx context.Context) (*Instance, error) {
	name := fmt.Sprintf("rdp-%d", e.names.Add(1))
	config := wazero.NewModuleConfig().WithName(name).
		WithSysWalltime().WithSysNanotime().WithSysNanosleep().WithRandSource(rand.Reader)
	module, err := e.runtime.InstantiateModule(ctx, e.compiled, config)
	if err != nil {
		return nil, fmt.Errorf("RDP module instance: %w", err)
	}
	return &Instance{engine: e, module: module}, nil
}

func (i *Instance) Close(ctx context.Context) error {
	return i.module.Close(ctx)
}

// Runner runs one RDP session over a Link. *Instance is the real one.
type Runner interface {
	// RunSettings runs a session from encoded settings, which it wipes once the
	// module has read them, and returns how it ended.
	RunSettings(ctx context.Context, l Link, settings []byte) (End, error)
}

var _ Runner = (*Instance)(nil)

// Run runs one session over l until it ends, returning how it ended. The
// module reports the same through l's Ended event, with the reason.
func (i *Instance) Run(ctx context.Context, l Link, config Config) (End, error) {
	settings, err := config.encode()
	if err != nil {
		return EndError, err
	}
	return i.RunSettings(ctx, l, settings)
}

// RunSettings is Run for settings already encoded by Config.encode. The
// caller needn't keep the password: the settings are wiped once read.
func (i *Instance) RunSettings(ctx context.Context, l Link, settings []byte) (End, error) {
	name := i.module.Name()
	i.engine.mu.Lock()
	if _, busy := i.engine.links[name]; busy {
		i.engine.mu.Unlock()
		return EndError, errors.New("RDP module instance is already running a session")
	}
	i.engine.links[name] = l
	i.engine.mu.Unlock()
	defer func() {
		i.engine.mu.Lock()
		delete(i.engine.links, name)
		i.engine.mu.Unlock()
	}()

	ptr, err := i.module.ExportedFunction("alloc").Call(ctx, uint64(len(settings)))
	if err != nil {
		return EndError, fmt.Errorf("RDP module: %w", err)
	}
	if !i.module.Memory().Write(uint32(ptr[0]), settings) {
		return EndError, errors.New("RDP module: configuration out of range")
	}
	// The configuration holds the password: the module's memory has the only
	// copy now, which run wipes once it has read it.
	clear(settings)
	result, err := i.module.ExportedFunction("run").Call(ctx, ptr[0], uint64(len(settings)))
	if err != nil {
		return EndError, fmt.Errorf("RDP module: %w", err)
	}
	return End(result[0]), nil
}
