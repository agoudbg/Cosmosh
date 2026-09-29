//go:build linux

package editor

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// nativeQueryFixture uses an actual Fish executable and a disposable saved user configuration.
func nativeQueryFixture(t *testing.T, config string) (string, Snapshot, []string) {
	t.Helper()
	binary := os.Getenv("COSMOSH_TEST_FISH")
	if binary == "" {
		t.Skip("set COSMOSH_TEST_FISH to run real native completion tests")
	}
	root := t.TempDir()
	configuration := filepath.Join(root, "config", "fish")
	directory := filepath.Join(root, "cwd space")
	if err := os.MkdirAll(configuration, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configuration, "config.fish"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	environment := []string{"PATH=/usr/bin:/bin", "HOME=" + root, "XDG_CONFIG_HOME=" + filepath.Dir(configuration),
		"XDG_DATA_HOME=" + filepath.Join(root, "data"), "TERM=xterm-256color", "COSMOSH_FIXTURE_EXPORT=from-original-export"}
	snapshot := Snapshot{PromptGeneration: 1, EditorMode: "emacs", Buffer: &Buffer{Text: "cosmosh_fixture ", Cursor: 16},
		Directory: &Directory{Logical: directory, Physical: &directory, Home: &root}}
	snapshot.Buffer.Cursor = len([]rune(snapshot.Buffer.Text))
	return binary, snapshot, environment
}

func TestIsolatedFishCompletionUsesConfigurationExportsAndConfirmedDirectory(t *testing.T) {
	binary, snapshot, environment := nativeQueryFixture(t, "echo configuration-noise\ncd /\ncomplete -c cosmosh_fixture -f -a '$COSMOSH_FIXTURE_EXPORT (builtin pwd)' -d 'native description'\n")
	result := runFishCompletion(context.Background(), binary, snapshot, environment)
	if result.Status != "ok" {
		t.Fatalf("actual Fish result: %#v", result)
	}
	values := make(map[string]bool)
	for _, entry := range result.Entries {
		values[entry.Value] = true
	}
	if !values["from-original-export"] || !values[snapshot.Directory.Logical] || values["configuration-noise"] {
		t.Fatalf("query lost CWD/export or included startup noise: %#v", result)
	}
}

func TestIsolatedFishCompletionPreservesLiteralDataAndReportsFormatAmbiguity(t *testing.T) {
	config := "complete -c cosmosh_fixture -f -a \"'two words' 'quote\\\\value' alpha\" -d (printf 'first\\nomega\\tfake' | string collect)\n"
	binary, snapshot, environment := nativeQueryFixture(t, config)
	result := runFishCompletion(context.Background(), binary, snapshot, environment)
	if result.Status != "ok" {
		t.Fatalf("actual Fish result: %#v", result)
	}
	values := make(map[string]bool)
	for _, entry := range result.Entries {
		values[entry.Value] = true
	}
	if !values["two words"] || !values["alpha"] || !values["omega"] {
		t.Fatalf("native literal/known raw-description semantics changed: %#v", result)
	}
}

func TestIsolatedFishCompletionTimeoutAndCancellation(t *testing.T) {
	binary, snapshot, environment := nativeQueryFixture(t, "complete -c cosmosh_fixture -f -a '(sleep 10; printf slow)'\n")
	for _, cancelEarly := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		if cancelEarly {
			time.AfterFunc(60*time.Millisecond, cancel)
		}
		started := time.Now()
		result := runFishCompletion(ctx, binary, snapshot, environment)
		cancel()
		expected := "timeout"
		if cancelEarly {
			expected = "unavailable"
		}
		if result.Status != expected || len(result.Entries) != 0 || time.Since(started) > 1800*time.Millisecond {
			t.Fatalf("query escaped cancellation bound: %#v after %v", result, time.Since(started))
		}
	}
}

func TestIsolatedFishCompletionRejectsFailureAndChangedDirectory(t *testing.T) {
	binary, snapshot, environment := nativeQueryFixture(t, "exec /bin/false\n")
	if result := runFishCompletion(context.Background(), binary, snapshot, environment); result.Status != "unavailable" {
		t.Fatal("failed configuration returned candidates")
	}
	binary, snapshot, environment = nativeQueryFixture(t, "")
	snapshot.Directory.Logical = "/"
	if result := runFishCompletion(context.Background(), binary, snapshot, environment); result.Status != "unavailable" {
		t.Fatal("mismatched physical directory returned candidates")
	}
}

// TestIsolatedFishCompletionClosesBlockedInput uses real Linux pipes and an intentionally detached reader.
// Only process creation is substituted; the production pipe, deadline, cleanup and Wait logic runs unchanged.
func TestIsolatedFishCompletionClosesBlockedInput(t *testing.T) {
	_, snapshot, environment := nativeQueryFixture(t, "")
	snapshot.Buffer.Text = strings.Repeat("x", MaxInputBytes)
	snapshot.Buffer.Cursor = MaxInputBytes
	directory := t.TempDir()
	pidPath := filepath.Join(directory, "escaped.pid")
	executable := filepath.Join(directory, "fixture-process")
	program := "#!/usr/bin/python3\nimport os,time\npid=os.fork()\n" +
		"if pid:\n os.close(3)\n os.close(4)\n os._exit(0)\n" +
		"os.setsid()\nwith open(" + strconv.Quote(pidPath) + ", 'w') as marker: marker.write(str(os.getpid()))\n" +
		"os.close(1)\nos.close(2)\nos.close(4)\ntime.sleep(10)\n"
	if err := os.WriteFile(executable, []byte(program), 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		raw, err := os.ReadFile(pidPath)
		if err != nil {
			return
		}
		pid, err := strconv.Atoi(string(raw))
		if err == nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	newPipe := func() (*os.File, *os.File, error) {
		reader, writer, err := os.Pipe()
		if err == nil {
			_, _, resizeErr := syscall.Syscall(syscall.SYS_FCNTL, reader.Fd(), syscall.F_SETPIPE_SZ, 4096)
			if resizeErr != 0 {
				reader.Close()
				writer.Close()
				return nil, nil, resizeErr
			}
		}
		return reader, writer, err
	}
	started := time.Now()
	result := runFishCompletionWithPipes(context.Background(), executable, snapshot, environment, newPipe)
	if result.Status != "unavailable" || time.Since(started) > 800*time.Millisecond {
		t.Fatalf("detached stdin reader retained query: %#v after %v", result, time.Since(started))
	}
	if _, err := os.Stat(pidPath); err != nil {
		t.Fatal("fixture did not create the detached reader")
	}
}

func TestIsolatedFishCompletionPreservesFilenameBytesAndOmitsControlNames(t *testing.T) {
	binary, snapshot, environment := nativeQueryFixture(t, "")
	names := []string{"two words", "quote'name", "unicode-🐟", "line\nbreak", "tab\tname"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(snapshot.Directory.Logical, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	snapshot.Buffer = &Buffer{Text: "cat ", Cursor: 4}
	result := runFishCompletion(context.Background(), binary, snapshot, environment)
	if result.Status != "partial" {
		t.Fatalf("control names must make this source partial: %#v", result)
	}
	values := make(map[string]bool)
	for _, entry := range result.Entries {
		values[entry.Value] = true
	}
	for _, name := range names[:3] {
		if !values[name] {
			t.Fatalf("missing literal filename %q: %#v", name, result)
		}
	}
	if values[names[3]] || values[names[4]] {
		t.Fatal("control-bearing filename crossed query boundary")
	}
}

func TestIsolatedFishCompletionBoundsBothResultAndStartupNoise(t *testing.T) {
	for _, config := range []string{
		"complete -c cosmosh_fixture -f -a '(string repeat --count 300000 x)'\n",
		"string repeat --count 70000 x\ncomplete -c cosmosh_fixture -f -a alpha\n",
	} {
		binary, snapshot, environment := nativeQueryFixture(t, config)
		started := time.Now()
		result := runFishCompletion(context.Background(), binary, snapshot, environment)
		if result.Status != "unavailable" || len(result.Entries) != 0 || time.Since(started) > 1800*time.Millisecond {
			t.Fatalf("output limit was not enforced: %#v after %v", result, time.Since(started))
		}
	}
}

func TestIsolatedFishCompletionDoesNotCallOverriddenProtocolCommands(t *testing.T) {
	config := "function true; builtin false; end\nfunction exit; builtin printf wrong-exit; end\n" +
		"complete -c cosmosh_fixture -f -a alpha\n"
	binary, snapshot, environment := nativeQueryFixture(t, config)
	result := runFishCompletion(context.Background(), binary, snapshot, environment)
	if result.Status != "ok" || len(result.Entries) != 1 || result.Entries[0].Value != "alpha" {
		t.Fatalf("configuration override changed query protocol: %#v", result)
	}
}
