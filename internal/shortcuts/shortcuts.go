// Package shortcuts defines user-authored terminal launchers and literal arguments.
package shortcuts

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const MaxShortcuts = 64
const MaxFields = 32
const MaxCommandBytes = 16 * 1024

// Keep this list aligned with the static command palette. One-letter built-ins
// also reserve their prefix because the Command Wheel dispatches them immediately.
var ReservedCodes = []string{"HP", "BL", "NN", "RV", "NB", "NV", "NX", "PW", "OO", "MM", "MN", "DT", "DL", "DR", "DB", "DD", "WT", "HB", "S", "TS", "LH", "UP", "CS"}
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
var codePattern = regexp.MustCompile(`^[A-Z]{2}$`)
var switchPattern = regexp.MustCompile(`^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$`)

type Shortcut struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Code    string  `json:"code"`
	Command string  `json:"command"`
	Cwd     string  `json:"cwd"`
	Fields  []Field `json:"fields"`
}
type Field struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Switch   string `json:"switch"`
	Default  string `json:"default"`
	Checked  bool   `json:"checked"`
	Required bool   `json:"required"`
}

func SafeText(s string, max int) bool {
	if len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}

func Validate(items []Shortcut) error {
	if len(items) > MaxShortcuts {
		return errors.New("at most 64 shortcuts are allowed")
	}
	ids, codes := map[string]bool{}, map[string]bool{}
	for _, s := range items {
		if !idPattern.MatchString(s.ID) || ids[s.ID] {
			return errors.New("shortcut IDs must be unique and use 1–64 letters, digits, _, -, or .")
		}
		ids[s.ID] = true
		if strings.TrimSpace(s.Name) == "" || !SafeText(s.Name, 80) {
			return errors.New("shortcut name is required (up to 80 bytes)")
		}
		if !codePattern.MatchString(s.Code) || codes[s.Code] {
			return errors.New("shortcut codes must be unique two-letter codes, such as CE")
		}
		for _, reserved := range ReservedCodes {
			if s.Code == reserved || (len(reserved) == 1 && strings.HasPrefix(s.Code, reserved)) {
				return fmt.Errorf("code %s conflicts with a built-in command", s.Code)
			}
		}
		codes[s.Code] = true
		if strings.TrimSpace(s.Command) == "" || !SafeText(s.Command, 4096) {
			return errors.New("base command must be one line, up to 4096 bytes, without control characters")
		}
		if !SafeText(s.Cwd, 4096) {
			return errors.New("invalid working directory")
		}
		if len(s.Fields) > MaxFields {
			return errors.New("at most 32 invocation fields are allowed")
		}
		fieldIDs := map[string]bool{}
		for _, f := range s.Fields {
			if !idPattern.MatchString(f.ID) || fieldIDs[f.ID] {
				return errors.New("invocation field IDs must be valid and unique")
			}
			fieldIDs[f.ID] = true
			if strings.TrimSpace(f.Label) == "" || !SafeText(f.Label, 80) {
				return errors.New("each field needs a label (up to 80 bytes)")
			}
			if f.Type != "text" && f.Type != "boolean" {
				return errors.New("field type must be text or boolean")
			}
			if f.Switch != "" && !switchPattern.MatchString(f.Switch) {
				return errors.New("switches must look like --file or -f; leave blank for a positional argument")
			}
			if f.Type == "boolean" && (f.Switch == "" || f.Required || f.Default != "") {
				return errors.New("boolean fields require a switch and use only a checked default")
			}
			if !SafeText(f.Default, 4096) {
				return errors.New("field defaults cannot contain control characters or exceed 4096 bytes")
			}
		}
	}
	return nil
}

// Build appends values as literal arguments. Only the configured base command is
// shell syntax; invocation values cannot add commands, substitutions or PTY input.
func Build(s Shortcut, values map[string]any, shell string) (string, error) {
	if err := Validate([]Shortcut{s}); err != nil {
		return "", err
	}
	known := map[string]bool{}
	for _, f := range s.Fields {
		known[f.ID] = true
	}
	for key := range values {
		if !known[key] {
			return "", fmt.Errorf("unknown input %s", key)
		}
	}
	type argument struct {
		value   string
		literal bool
	}
	args := []argument{}
	for _, f := range s.Fields {
		value, supplied := values[f.ID]
		if f.Type == "boolean" {
			checked := f.Checked
			if supplied {
				var ok bool
				checked, ok = value.(bool)
				if !ok {
					return "", fmt.Errorf("%s must be a boolean", f.Label)
				}
			}
			if checked {
				args = append(args, argument{value: f.Switch})
			}
			continue
		}
		text := f.Default
		if supplied {
			var ok bool
			text, ok = value.(string)
			if !ok {
				return "", fmt.Errorf("%s must be text", f.Label)
			}
		}
		if !SafeText(text, 4096) {
			return "", fmt.Errorf("%s contains control characters or exceeds 4096 bytes", f.Label)
		}
		if text == "" {
			if f.Required {
				return "", fmt.Errorf("%s is required", f.Label)
			}
			continue
		}
		if f.Switch != "" {
			args = append(args, argument{value: f.Switch})
		}
		args = append(args, argument{value: text, literal: true})
	}
	command := strings.TrimSpace(s.Command)
	for _, arg := range args {
		if !arg.literal {
			command += " " + arg.value
			continue
		}
		switch shell {
		case "powershell":
			command += " '" + strings.ReplaceAll(arg.value, "'", "''") + "'"
		case "posix":
			command += " '" + strings.ReplaceAll(arg.value, "'", "'\"'\"'") + "'"
		default:
			return "", errors.New("shortcut inputs require PowerShell on Windows or a sh/bash/zsh/ksh/fish terminal shell")
		}
	}
	if len(command) > MaxCommandBytes {
		return "", errors.New("expanded command exceeds 16 KiB")
	}
	return command, nil
}
