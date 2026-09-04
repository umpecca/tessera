//go:build windows && amd64

package conpty

import _ "embed"

//go:embed assets/amd64/conpty.dll
var runtimeDLL []byte

//go:embed assets/amd64/OpenConsole.exe
var runtimeEXE []byte
