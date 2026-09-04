//go:build windows && 386

package conpty

import _ "embed"

//go:embed assets/386/conpty.dll
var runtimeDLL []byte

//go:embed assets/386/OpenConsole.exe
var runtimeEXE []byte
