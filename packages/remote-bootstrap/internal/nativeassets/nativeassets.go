package nativeassets

import (
	"errors"
	"path/filepath"
)

// ErrUnavailable identifies a local bootstrap build without embedded native modules.
var ErrUnavailable = errors.New("native Shell module is not embedded in this bootstrap build")

// NativeShell reports whether a Shell has a packaged native editor module.
func NativeShell(shell string) bool {
	return shell == "bash" || shell == "zsh"
}

// Path returns the installed module path alongside the bootstrap executable.
func Path(binaryPath, shell string) string {
	if !NativeShell(shell) {
		return ""
	}
	if shell == "zsh" {
		return filepath.Join(filepath.Dir(binaryPath), "cosmosh_zsh.so")
	}
	return filepath.Join(filepath.Dir(binaryPath), "cosmosh-bash.so")
}
