package shortcuts

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func example() Shortcut {
	return Shortcut{ID: "editor", Name: "Editor", Code: "CE", Command: "fresh", Fields: []Field{
		{ID: "file", Label: "File", Type: "text", Switch: "--file"},
		{ID: "readonly", Label: "Read only", Type: "boolean", Switch: "--readonly", Checked: true},
		{ID: "extra", Label: "Extra", Type: "text"},
	}}
}
func TestBuildOptionalDefaultRequiredAndBooleanInputs(t *testing.T) {
	s := example()
	command, err := Build(s, nil, "posix")
	if err != nil || command != "fresh --readonly" {
		t.Fatal(command, err)
	}
	s.Fields[0].Default = "draft with spaces.txt"
	command, err = Build(s, map[string]any{"readonly": false}, "posix")
	if err != nil || command != "fresh --file 'draft with spaces.txt'" {
		t.Fatal(command, err)
	}
	command, err = Build(s, map[string]any{"file": "", "readonly": false}, "posix")
	if err != nil || command != "fresh" {
		t.Fatal("empty must omit default and switch", command, err)
	}
	s.Fields[0].Required = true
	if _, err := Build(s, map[string]any{"file": ""}, "posix"); err == nil {
		t.Fatal("empty required input accepted")
	}
	if _, err := Build(s, map[string]any{"file": true}, "posix"); err == nil {
		t.Fatal("wrong type accepted")
	}
	if _, err := Build(s, map[string]any{"missing": "value"}, "posix"); err == nil {
		t.Fatal("unknown input accepted")
	}
	if _, err := Build(s, map[string]any{"readonly": "false"}, "posix"); err == nil {
		t.Fatal("boolean string accepted")
	}
}
func TestLiteralInputsCannotBecomeCommands(t *testing.T) {
	s := example()
	s.Command = "echo"
	s.Fields = []Field{{ID: "value", Label: "Value", Type: "text"}}
	value := `世界 ' "$HOME $(touch bad); & evil` // printable syntax remains literal
	posix, err := Build(s, map[string]any{"value": value}, "posix")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(posix, `'"'"'`) {
		t.Fatal("apostrophe not quoted", posix)
	}
	powershell, err := Build(s, map[string]any{"value": value}, "powershell")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(powershell, "''") {
		t.Fatal("PowerShell apostrophe not quoted", powershell)
	}
	for _, bad := range []string{"line\ncommand", "\r", "\x1b[", "\x00", strings.Repeat("a", 4097)} {
		if _, err := Build(s, map[string]any{"value": bad}, "posix"); err == nil {
			t.Fatal("unsafe input accepted")
		}
	}
	if _, err := Build(s, map[string]any{"value": "ok"}, "unsupported"); err == nil {
		t.Fatal("unknown shell quoted")
	}
	s.Fields = nil
	if _, err := Build(s, nil, "unsupported"); err != nil {
		t.Fatal("no-argument command should work", err)
	}
}
func TestLiteralInputsInActualHostShell(t *testing.T) {
	s := example()
	s.Fields = []Field{{ID: "value", Label: "Value", Type: "text"}}
	marker := filepath.Join(t.TempDir(), "injected")
	var value, base, shell string
	if runtime.GOOS == "windows" {
		base = "Write-Output"
		shell = "powershell"
		value = "quote ' ; $(New-Item '" + marker + "') & $env:PATH"
	} else {
		base = "printf '%s\\n'"
		shell = "posix"
		value = "quote ' ; $(touch '" + marker + "') & $HOME"
	}
	s.Command = base
	command, err := Build(s, map[string]any{"value": value}, shell)
	if err != nil {
		t.Fatal(err)
	}
	var cmd *exec.Cmd
	if shell == "powershell" {
		cmd = exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command)
	} else {
		cmd = exec.Command("/bin/sh", "-c", command)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("shell failed: %s %v", output, err)
	}
	if strings.TrimRight(string(output), "\r\n") != value {
		t.Fatalf("literal changed: %q != %q", output, value)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("input executed a command", err)
	}
}
func TestValidationAndBuiltInCodeParity(t *testing.T) {
	s := example()
	if err := Validate([]Shortcut{s}); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"NN", "CECE", "S", "SA", "CS", "ce", "NV"} {
		s.Code = code
		if err := Validate([]Shortcut{s}); err == nil {
			t.Fatal("invalid/conflicting code", code)
		}
	}
	s = example()
	if err := Validate([]Shortcut{s, s}); err == nil {
		t.Fatal("duplicate accepted")
	}
	s.Fields[0].Switch = "--file;bad"
	if err := Validate([]Shortcut{s}); err == nil {
		t.Fatal("unsafe switch")
	}
	s = example()
	s.Command = "echo\nrm"
	if err := Validate([]Shortcut{s}); err == nil {
		t.Fatal("multiline command accepted")
	}
	source, err := os.ReadFile("../../web/app.js")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)const paletteShortcutCodes = \{(.*?)\n};`).FindSubmatch(source)
	codes := []string{}
	for _, match := range regexp.MustCompile(`: "([A-Z]{1,2})"`).FindAllSubmatch(block[1], -1) {
		codes = append(codes, string(match[1]))
	}
	slices.Sort(codes)
	reserved := slices.Clone(ReservedCodes)
	slices.Sort(reserved)
	if !slices.Equal(codes, reserved) {
		t.Fatalf("reserved codes drifted: %v != %v", codes, reserved)
	}
}
func TestExpandedCommandLimit(t *testing.T) {
	s := example()
	s.Fields = nil
	values := map[string]any{}
	for i := range 5 {
		id := string(rune('a' + i))
		s.Fields = append(s.Fields, Field{ID: id, Label: id, Type: "text"})
		values[id] = strings.Repeat("x", 4096)
	}
	if _, err := Build(s, values, "powershell"); err == nil {
		t.Fatal("expanded command not bounded")
	}
}
