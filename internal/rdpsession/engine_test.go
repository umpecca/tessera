package rdpsession

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
)

// An X.224 Connection Confirm whose RDP Negotiation Response selects
// PROTOCOL_HYBRID (CredSSP), as internal/httpapi's RDP tests build it.
var hybridConfirm = []byte{
	0x03, 0x00, 0x00, 0x13,
	0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00,
	0x02, 0x00, 0x08, 0x00,
	0x02, 0x00, 0x00, 0x00,
}

type recordedEvent struct {
	kind    uint32
	payload []byte
}

// scriptedLink plays back server bytes and records what the module does.
type scriptedLink struct {
	mu         sync.Mutex
	replies    [][]byte
	sent       [][]byte
	upgrades   int
	upgradeErr error
	events     []recordedEvent
}

func (l *scriptedLink) Recv() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.replies) == 0 {
		return nil
	}
	reply := l.replies[0]
	l.replies = l.replies[1:]
	return append([]byte{tagServerBytes}, reply...)
}

func (l *scriptedLink) Send(bytes []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sent = append(l.sent, append([]byte(nil), bytes...))
	return nil
}

func (l *scriptedLink) UpgradeTLS() ([]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.upgrades++
	return nil, l.upgradeErr
}

func (l *scriptedLink) Event(kind uint32, payload []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, recordedEvent{kind, payload})
}

func (l *scriptedLink) ended(t *testing.T) (End, string) {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, event := range l.events {
		if event.kind == eventEnded {
			return End(event.payload[0]), string(event.payload[1:])
		}
	}
	t.Fatal("no Ended event")
	return 0, ""
}

func testConfig() Config {
	return Config{ServerName: "rdp.test", Username: "jane", Password: "secret", Width: 1216, Height: 640, H264: true}
}

var (
	sharedEngineOnce sync.Once
	sharedEngine     *Engine
	sharedEngineErr  error
)

// testEngine compiles the module once for the package's tests.
func testEngine(t *testing.T) *Engine {
	t.Helper()
	sharedEngineOnce.Do(func() { sharedEngine, sharedEngineErr = NewEngine(context.Background(), "") })
	if sharedEngineErr != nil {
		t.Fatal(sharedEngineErr)
	}
	return sharedEngine
}

func testInstance(t *testing.T) *Instance {
	t.Helper()
	instance, err := testEngine(t).NewInstance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = instance.Close(context.Background()) })
	return instance
}

func TestModuleNegotiatesAndReportsAFailedTLSUpgrade(t *testing.T) {
	link := &scriptedLink{replies: [][]byte{hybridConfirm}, upgradeErr: errors.New("certificate changed")}
	end, err := testInstance(t).Run(context.Background(), link, testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if end != EndError {
		t.Fatalf("end = %d, want EndError", end)
	}
	if code, reason := link.ended(t); code != EndError || !strings.Contains(reason, "TLS upgrade failed") {
		t.Fatalf("Ended = %d %q", code, reason)
	}
	if len(link.sent) != 1 || len(link.sent[0]) < 11 || link.sent[0][0] != 0x03 || link.sent[0][5] != 0xe0 {
		t.Fatalf("expected one X.224 Connection Request, sent %x", link.sent)
	}
	if link.upgrades != 1 {
		t.Fatalf("upgrades = %d, want 1", link.upgrades)
	}
}

func TestModuleEndsWhenTheConnectionVanishes(t *testing.T) {
	link := &scriptedLink{}
	end, err := testInstance(t).Run(context.Background(), link, testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if end != EndError {
		t.Fatalf("end = %d, want EndError", end)
	}
	if code, reason := link.ended(t); code != EndError || !strings.HasPrefix(reason, "connect:") {
		t.Fatalf("Ended = %d %q", code, reason)
	}
	if link.upgrades != 0 {
		t.Fatalf("upgraded TLS without a Connection Confirm")
	}
}

func TestAnInstanceRunsAgainAfterASessionEnds(t *testing.T) {
	instance := testInstance(t)
	for run := 0; run < 2; run++ {
		link := &scriptedLink{replies: [][]byte{hybridConfirm}, upgradeErr: errors.New("no")}
		config := testConfig()
		config.Rejoin = run == 1
		if end, err := instance.Run(context.Background(), link, config); err != nil || end != EndError {
			t.Fatalf("run %d: end = %d, err = %v", run, end, err)
		}
		if run == 1 {
			found := false
			for _, event := range link.events {
				found = found || (event.kind == eventLog && strings.Contains(string(event.payload), "no auto-reconnect cookie"))
			}
			if !found {
				t.Fatalf("rejoin without a cookie wasn't reported: %v", link.events)
			}
		}
	}
}

func TestRunRejectsAnInvalidConfiguration(t *testing.T) {
	config := testConfig()
	config.Width = 0
	if _, err := testInstance(t).Run(context.Background(), &scriptedLink{}, config); !errors.Is(err, errConfig) {
		t.Fatalf("err = %v, want errConfig", err)
	}
}

func TestEngineCachesCompiledCode(t *testing.T) {
	dir := t.TempDir()
	for start := 0; start < 2; start++ {
		engine, err := NewEngine(context.Background(), dir)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := engine.NewInstance(context.Background()); err != nil {
			t.Fatal(err)
		}
		_ = engine.Close(context.Background())
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("cache directory is empty: %v", err)
	}
}
