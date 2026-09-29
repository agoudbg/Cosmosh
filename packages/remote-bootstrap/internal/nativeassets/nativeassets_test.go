package nativeassets

import (
	"path/filepath"
	"testing"
)

func TestNativeModulePathsAreShellSpecific(t *testing.T) {
	binary := filepath.Join("tmp", "cosmosh-bootstrap")
	for shell, name := range map[string]string{
		"bash": "cosmosh-bash.so",
		"zsh":  "cosmosh_zsh.so",
	} {
		if !NativeShell(shell) || Path(binary, shell) != filepath.Join("tmp", name) {
			t.Fatalf("incorrect %s module path", shell)
		}
	}
	if NativeShell("fish") || Path(binary, "fish") != "" || Available("fish") {
		t.Fatal("a Shell without a native module advertised one")
	}
}
