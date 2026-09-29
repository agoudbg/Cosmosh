//go:build linux

package install

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/nativeassets"
)

func TestNativeModulePermissionChangesInvalidateAndRepairInstallation(t *testing.T) {
	module, err := nativeassets.Payload()
	if errors.Is(err, nativeassets.ErrUnavailable) {
		t.Skip("this Go test binary does not embed a Bash native module")
	}
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	t.Setenv("HOME", directory)
	t.Setenv("XDG_DATA_HOME", filepath.Join(directory, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(directory, "config"))
	options := Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}
	if err := Run(options); err != nil {
		t.Fatal(err)
	}
	resolved, err := resolvePaths("bash")
	if err != nil {
		t.Fatal(err)
	}
	modulePath := nativeassets.Path(resolved.binaryPath)
	for _, mode := range []os.FileMode{0o666, 0o640, 0o400, 0o700} {
		if err := os.Chmod(modulePath, mode); err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if err := Status(&output, "bash"); err != nil {
			t.Fatal(err)
		}
		var status InstallationStatus
		if err := json.Unmarshal(output.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if status.Installed || status.NativeModuleCurrent {
			t.Fatalf("changed native mode %o remained current", mode)
		}
		if err := Run(options); err != nil {
			t.Fatal(err)
		}
		info, err := os.Lstat(modulePath)
		if err != nil || info.Mode() != 0o600 {
			t.Fatalf("native mode %o was not repaired: %v", mode, err)
		}
		content, err := os.ReadFile(modulePath)
		if err != nil || !bytes.Equal(content, module) || !nativeMatches(resolved.binaryPath) {
			t.Fatalf("native repair did not restore the trusted embedded artifact: %v", err)
		}
	}
}
