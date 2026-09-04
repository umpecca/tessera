//go:build windows && arm64

package conpty

import _ "embed"

//go:embed assets/arm64/conpty.dll
var runtimeDLL []byte

//go:embed assets/arm64/OpenConsole.exe
var runtimeEXE []byte
