//go:build linux

package install

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBashOptionalIdentityFailurePreservesErrexitShell(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("Bash is not installed on this test host")
	}
	helper, err := BuildHelper("bash", "test", "/cosmosh-nonexistent-fixture-helper")
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "helper.sh")
	if err := os.WriteFile(filename, []byte(helper), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(bash, "--noprofile", "--norc", "-ic",
		`set -e; . "$1"; builtin printf '%s' OPTIONAL_HELPER_FAILURE_ALIVE`, "fixture", filename)
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "OPTIONAL_HELPER_FAILURE_ALIVE") {
		t.Fatalf("optional helper failure terminated Bash: %v, %s", err, output)
	}
}
