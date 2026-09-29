package nativeassets

import (
	"errors"
	"path/filepath"
)

// ErrUnavailable identifies a local bootstrap build without an embedded Bash module.
var ErrUnavailable = errors.New("Bash native module is not embedded in this bootstrap build")

// Path returns the installed module path alongside the bootstrap executable.
func Path(binaryPath string) string {
	return filepath.Join(filepath.Dir(binaryPath), "cosmosh-bash.so")
}
