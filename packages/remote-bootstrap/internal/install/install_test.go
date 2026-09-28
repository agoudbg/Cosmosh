package install

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRunInstallsUserScopedFiles(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	stdout := bytes.Buffer{}
	err := Run(Options{
		Shell:   "sh",
		Version: "1.2.3",
		Stdout:  &stdout,
	})
	if err != nil {
		t.Fatal(err)
	}

	assertFileContains(t, filepath.Join(configDir, "cosmosh", "bootstrap", "helper.sh"), "COSMOSH_BOOTSTRAP_READY")
	assertFileContains(t, filepath.Join(homeDir, ".profile"), markerStart)
	assertFileContains(t, filepath.Join(homeDir, ".profile"), "helper.sh")
	if !strings.Contains(stdout.String(), `"state":"ok"`) {
		t.Fatalf("expected ok status, got %s", stdout.String())
	}
}

func TestRunInstallsBashProfile(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	err := Run(Options{
		Shell:   "bash",
		Version: "1.2.3",
		Stdout:  &bytes.Buffer{},
	})
	if err != nil {
		t.Fatal(err)
	}

	assertFileContains(t, filepath.Join(homeDir, ".bashrc"), markerStart)
	assertFileContains(t, filepath.Join(homeDir, ".bashrc"), "helper.sh")
	assertFileContains(t, filepath.Join(homeDir, ".profile"), markerStart)
	assertFileContains(t, filepath.Join(homeDir, ".profile"), "helper.sh")
	assertFileContains(t, filepath.Join(homeDir, ".profile"), "${BASH_VERSION:-}")
}

func TestRunUsesExistingBashLoginProfile(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	loginProfilePath := filepath.Join(homeDir, ".bash_profile")
	if err := os.WriteFile(loginProfilePath, []byte("custom login profile\n"), 0o640); err != nil {
		t.Fatal(err)
	}

	if err := Run(Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}

	assertFileContains(t, filepath.Join(homeDir, ".bashrc"), markerStart)
	assertFileContains(t, loginProfilePath, "custom login profile")
	assertFileContains(t, loginProfilePath, markerStart)
	assertFileNotExists(t, filepath.Join(homeDir, ".profile"))

	if runtime.GOOS != "windows" {
		info, err := os.Stat(loginProfilePath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o640 {
			t.Fatalf("expected existing login profile mode to be preserved, got %o", info.Mode().Perm())
		}
	}
}

func TestRunPreservesSymlinkedBashProfile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("profile symlink semantics are validated on POSIX hosts")
	}

	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	dotfilesDir := filepath.Join(homeDir, "dotfiles")
	if err := os.MkdirAll(dotfilesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(dotfilesDir, "bashrc")
	if err := os.WriteFile(targetPath, []byte("custom bashrc\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	profilePath := filepath.Join(homeDir, ".bashrc")
	if err := os.Symlink(targetPath, profilePath); err != nil {
		t.Fatal(err)
	}

	if err := Run(Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}

	linkInfo, err := os.Lstat(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatal("expected .bashrc symlink to remain intact")
	}
	assertFileContains(t, targetPath, "custom bashrc")
	assertFileContains(t, targetPath, markerStart)
	targetInfo, err := os.Stat(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if targetInfo.Mode().Perm() != 0o640 {
		t.Fatalf("expected symlink target mode to be preserved, got %o", targetInfo.Mode().Perm())
	}
}

func TestRunInstallsThroughDanglingProfileSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("profile symlink semantics are validated on POSIX hosts")
	}

	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	// Dotfile managers link profiles before the target exists; installation
	// must create the managed file instead of aborting the whole bootstrap.
	targetPath := filepath.Join(homeDir, "dotfiles", "bashrc")
	profilePath := filepath.Join(homeDir, ".bashrc")
	if err := os.Symlink(targetPath, profilePath); err != nil {
		t.Fatal(err)
	}

	if err := Run(Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}

	linkInfo, err := os.Lstat(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatal("expected dangling .bashrc symlink to remain intact")
	}
	assertFileContains(t, targetPath, markerStart)
}

func TestRunSelectsDanglingBashLoginProfileSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("profile symlink semantics are validated on POSIX hosts")
	}

	for _, profileName := range []string{".bash_profile", ".bash_login"} {
		t.Run(profileName, func(t *testing.T) {
			homeDir := t.TempDir()
			dataDir := filepath.Join(homeDir, "data")
			configDir := filepath.Join(homeDir, "config")
			t.Setenv("HOME", homeDir)
			t.Setenv("USERPROFILE", homeDir)
			t.Setenv("XDG_DATA_HOME", dataDir)
			t.Setenv("XDG_CONFIG_HOME", configDir)

			targetPath := filepath.Join(homeDir, "dotfiles", strings.TrimPrefix(profileName, "."))
			profilePath := filepath.Join(homeDir, profileName)
			if err := os.Symlink(targetPath, profilePath); err != nil {
				t.Fatal(err)
			}

			if err := Run(Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}); err != nil {
				t.Fatal(err)
			}

			linkInfo, err := os.Lstat(profilePath)
			if err != nil {
				t.Fatal(err)
			}
			if linkInfo.Mode()&os.ModeSymlink == 0 {
				t.Fatalf("expected dangling %s symlink to remain intact", profileName)
			}
			assertFileContains(t, targetPath, markerStart)
			assertFileNotExists(t, filepath.Join(homeDir, ".profile"))
		})
	}
}

func TestRunInstallsBashRemoteShellHelperHooks(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	err := Run(Options{
		Shell:   "bash",
		Version: "1.2.3",
		Stdout:  &bytes.Buffer{},
	})
	if err != nil {
		t.Fatal(err)
	}

	helperPath := filepath.Join(configDir, "cosmosh", "bootstrap", "helper.sh")
	assertFileContains(t, helperPath, "__cosmosh_emit_remote_shell_event")
	assertFileContains(t, helperPath, `PROMPT_COMMAND=('__cosmosh_bash_prompt_command || :' '__cosmosh_bash_arm_preexec || :')`)
	assertFileContains(t, helperPath, `PROMPT_COMMAND=('__cosmosh_bash_prompt_command || :' "$PROMPT_COMMAND" '__cosmosh_bash_arm_preexec || :')`)
	assertFileNotContains(t, helperPath, `PROMPT_COMMAND="__cosmosh_bash_prompt_command; ${PROMPT_COMMAND}; __cosmosh_bash_arm_preexec"`)
	assertFileContains(t, helperPath, "trap '__cosmosh_bash_debug_trap' DEBUG")
	assertFileContains(t, helperPath, "command-end")
	assertFileContains(t, helperPath, "command-start")
	assertFileContains(t, helperPath, "foreground-command")
	assertFileContains(t, helperPath, `\"commandBase64\":\"$__cosmosh_command_base64\"`)
	assertFileContains(t, helperPath, `\"commandId\":\"$__cosmosh_command_id\"`)
	assertFileContains(t, helperPath, `\"durationMs\":$__cosmosh_duration`)
	assertFileContains(t, helperPath, `\"cwdBase64\":\"$__cosmosh_cwd_base64\"`)
	assertFileContains(t, helperPath, `\"helperVersion\":\"$__COSMOSH_HELPER_VERSION\"`)
	assertFileContains(t, helperPath, `\"protocolVersion\":$__COSMOSH_PROTOCOL_VERSION`)
	assertFileContains(t, helperPath, `\"capabilities\":$__COSMOSH_CAPABILITIES_JSON`)
	assertTextOrder(t, readFileString(t, helperPath), "trap '__cosmosh_bash_debug_trap' DEBUG", "__cosmosh_emit_remote_shell_event integration-ready")
}

func TestBashHelperPreservesPromptCommandWithTrailingSeparator(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is unavailable")
	}

	helper, err := BuildHelper("bash", "1.2.3", "/tmp/cosmosh-bootstrap")
	if err != nil {
		t.Fatal(err)
	}
	script := "PROMPT_COMMAND='history -a;'\nHISTFILE=/dev/null\n" + helper + "\neval \"$PROMPT_COMMAND\"\n"
	command := exec.Command(bashPath, "--noprofile", "--norc", "-i", "-s")
	command.Stdin = strings.NewReader("{\n" + script + "\n}\n")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("expected trailing prompt separator to remain valid: %v\n%s", err, output)
	}
}

func TestBashHelperPreservesPreviousCommandStatusForUserPromptHook(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is unavailable")
	}

	helper, err := BuildHelper("bash", "1.2.3", "/tmp/cosmosh-bootstrap")
	if err != nil {
		t.Fatal(err)
	}
	// Force event emission without a PTY so the test covers Bash dynamic-scope collisions
	// between the prompt wrapper and the shared event serializer.
	script := "PROMPT_COMMAND='__observed_status=$?'\n__COSMOSH_CAPTURED_PROMPT_EVENT=1\n" + helper
	command := exec.Command(bashPath, "--noprofile", "--norc", "-i", "-s")
	// Let Bash execute its actual prompt array after false; manually evaluating element zero
	// would bypass Bash's per-element restoration of the original command status.
	command.Stdin = strings.NewReader("{\n" + script + "\n}\nfalse\ntest \"$__observed_status\" -eq 1\n")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("expected user prompt hook to observe the previous exit status: %v\n%s", err, output)
	}
}

func TestRunInstallsZshRemoteShellHelperHooks(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	err := Run(Options{
		Shell:   "zsh",
		Version: "1.2.3",
		Stdout:  &bytes.Buffer{},
	})
	if err != nil {
		t.Fatal(err)
	}

	helperPath := filepath.Join(configDir, "cosmosh", "bootstrap", "helper.sh")
	assertFileContains(t, filepath.Join(homeDir, ".zshrc"), markerStart)
	assertFileContains(t, helperPath, "add-zsh-hook precmd __cosmosh_zsh_precmd")
	assertFileContains(t, helperPath, "add-zsh-hook chpwd __cosmosh_zsh_chpwd")
	assertFileContains(t, helperPath, "add-zsh-hook preexec __cosmosh_zsh_preexec")
	assertFileContains(t, helperPath, "command-start")
	assertFileContains(t, helperPath, "foreground-command")
	assertFileContains(t, helperPath, "add-zle-hook-widget line-pre-redraw __cosmosh_zsh_line_pre_redraw")
	// Plain autoload succeeds even without a definition file, deferring a
	// visible failure to call time on zsh < 5.3; +X loads eagerly so the
	// guard actually guards, and failed integrations must deregister their
	// per-prompt hooks instead of forking forever for rejected events.
	assertFileContains(t, helperPath, "autoload -Uz +X add-zsh-hook")
	assertFileContains(t, helperPath, "autoload -Uz +X add-zle-hook-widget")
	assertFileContains(t, helperPath, "add-zle-hook-widget -d line-pre-redraw __cosmosh_zsh_line_pre_redraw")
	assertFileContains(t, helperPath, "precmd_functions=(${precmd_functions[@]:#__cosmosh_zsh_precmd})")
	assertFileContains(t, helperPath, `__COSMOSH_CAPABILITIES_JSON='["cwd","command-start","command-end","foreground-command","prompt-ready","cwd-invalidated","line-state","editor-state","input-snapshot","input-apply"]'`)
	assertTextOrder(t, readFileString(t, helperPath), "add-zle-hook-widget line-pre-redraw", "__cosmosh_emit_remote_shell_event integration-ready")
}

func TestZshHelperRemovesZleHookAfterPartialRegistrationFailure(t *testing.T) {
	zshPath, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("zsh is unavailable")
	}

	helper, err := BuildHelper("zsh", "1.2.3", "/tmp/cosmosh-bootstrap")
	if err != nil {
		t.Fatal(err)
	}

	logPath := filepath.Join(t.TempDir(), "zle-hooks.log")
	script := `
autoload() { return 0 }
zmodload() { return 0 }
add-zsh-hook() {
  [ "$1" != "precmd" ]
}
add-zle-hook-widget() {
  printf '%s\n' "$*" >> "$COSMOSH_ZLE_HOOK_LOG"
  return 0
}
` + helper + `
test "${__COSMOSH_REMOTE_SHELL_HOOK_INSTALLED:-0}" != "1"
`
	command := exec.Command(zshPath, "-f", "-i", "-c", "source /dev/stdin")
	// Source the script as startup files are sourced, without interactive
	// history expansion of the helper's character-class expressions.
	command.Stdin = strings.NewReader(script)
	command.Env = append(os.Environ(), "COSMOSH_ZLE_HOOK_LOG="+logPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("expected partial Zsh hook registration to fail closed: %v\n%s", err, output)
	}

	logContent := readFileString(t, logPath)
	logLines := strings.Split(strings.TrimSpace(logContent), "\n")
	expectedLogLines := []string{
		"line-pre-redraw __cosmosh_zsh_line_pre_redraw",
		"-d line-pre-redraw __cosmosh_zsh_line_pre_redraw",
	}
	if len(logLines) != len(expectedLogLines) {
		t.Fatalf("expected one ZLE registration and cleanup, got %q", logContent)
	}
	for index, expectedLine := range expectedLogLines {
		if logLines[index] != expectedLine {
			t.Fatalf("expected ZLE hook log line %d to be %q, got %q", index, expectedLine, logLines[index])
		}
	}
}

func TestRunInstallsFishRemoteShellHelperHooks(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	err := Run(Options{
		Shell:   "fish",
		Version: "1.2.3",
		Stdout:  &bytes.Buffer{},
	})
	if err != nil {
		t.Fatal(err)
	}

	helperPath := filepath.Join(configDir, "cosmosh", "bootstrap", "helper.fish")
	assertFileContains(t, helperPath, "__cosmosh_emit_remote_shell_event")
	assertFileContains(t, helperPath, "--on-event fish_prompt")
	assertFileContains(t, helperPath, "--on-event fish_preexec")
	assertFileContains(t, helperPath, "--on-event fish_postexec")
	assertFileContains(t, helperPath, "--on-variable PWD --on-variable HOME")
	assertFileContains(t, helperPath, "command-start")
	assertFileContains(t, helperPath, "foreground-command")
	assertFileContains(t, helperPath, "commandBase64")
	assertFileContains(t, helperPath, "commandId")
	assertFileContains(t, helperPath, "durationMs")
	assertTextOrder(t, readFileString(t, helperPath), "function __cosmosh_report_prompt", "__cosmosh_emit_remote_shell_event integration-ready")
}

func TestFishHelperNeverAssignsReadOnlyStatusVariable(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	err := Run(Options{
		Shell:   "fish",
		Version: "1.2.3",
		Stdout:  &bytes.Buffer{},
	})
	if err != nil {
		t.Fatal(err)
	}

	// fish's `status` is a read-only special variable: `set -l status` fails at
	// runtime, prints an error to the PTY, and leaves $status pointing at the
	// last internal command instead of the captured exit code.
	helperPath := filepath.Join(configDir, "cosmosh", "bootstrap", "helper.fish")
	assertFileNotContains(t, helperPath, "set -l status ")
	assertFileContains(t, helperPath, "set -l exit_status $argv[2]")
	assertFileContains(t, helperPath, `\"exitCode\":$exit_status`)
}

func TestFishHelperStripsBase64LineWrapping(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	err := Run(Options{
		Shell:   "fish",
		Version: "1.2.3",
		Stdout:  &bytes.Buffer{},
	})
	if err != nil {
		t.Fatal(err)
	}

	// GNU base64 wraps at 76 columns and fish `string replace` reading stdin
	// operates per line, so wrapped output became a multi-element list that
	// interpolation joined with spaces — failing Backend's canonical base64
	// check. Both encode sites must strip wrapping with tr like the POSIX
	// helper does.
	helperPath := filepath.Join(configDir, "cosmosh", "bootstrap", "helper.fish")
	assertFileNotContains(t, helperPath, "string replace -a \\n")
	assertFileContains(t, helperPath, `printf '%s' "$argv[1]" | base64 | tr -d '\r\n'`)
	assertFileContains(t, helperPath, `printf '%s' "$json" | base64 | tr -d '\r\n'`)
}

func TestRunInstallsShAshDegradedPromptHooks(t *testing.T) {
	for _, shell := range []string{"sh", "ash"} {
		t.Run(shell, func(t *testing.T) {
			homeDir := t.TempDir()
			dataDir := filepath.Join(homeDir, "data")
			configDir := filepath.Join(homeDir, "config")
			t.Setenv("HOME", homeDir)
			t.Setenv("USERPROFILE", homeDir)
			t.Setenv("XDG_DATA_HOME", dataDir)
			t.Setenv("XDG_CONFIG_HOME", configDir)

			err := Run(Options{
				Shell:   shell,
				Version: "1.2.3",
				Stdout:  &bytes.Buffer{},
			})
			if err != nil {
				t.Fatal(err)
			}

			helperPath := filepath.Join(configDir, "cosmosh", "bootstrap", "helper.sh")
			assertFileContains(t, helperPath, "PS1='$(__cosmosh_prompt_ready_for_ps1")
			assertFileContains(t, helperPath, `__COSMOSH_CAPTURED_PROMPT_EVENT=1`)
			assertFileContains(t, helperPath, `__COSMOSH_CAPABILITIES_JSON='["cwd","prompt-ready"]'`)
			assertFileNotContains(t, helperPath, `__cosmosh_emit_command_start "$1"`)
			if containsString(HelperCapabilities(shell), "command-end") {
				t.Fatal("degraded shell must not advertise command-end")
			}
			assertTextOrder(t, readFileString(t, helperPath), "PS1='$(__cosmosh_prompt_ready_for_ps1", "__cosmosh_emit_remote_shell_event integration-ready")
		})
	}
}

func TestRunLeavesNoAtomicInstallTemporaryFiles(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	if err := Run(Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}

	err := filepath.WalkDir(homeDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if strings.HasPrefix(entry.Name(), ".cosmosh-install-") {
			t.Fatalf("unexpected atomic install temporary file: %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRunSkipsCurrentInstall(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	options := Options{Shell: "sh", Version: "1.2.3", Stdout: &bytes.Buffer{}}
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	stdout := bytes.Buffer{}
	options.Stdout = &stdout
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(stdout.String(), `"state":"skipped"`) {
		t.Fatalf("expected skipped status, got %s", stdout.String())
	}
}

func TestRunRepairsMissingPosixProfileHook(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	options := Options{Shell: "sh", Version: "1.2.3", Stdout: &bytes.Buffer{}}
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	profilePath := filepath.Join(homeDir, ".profile")
	if err := os.WriteFile(profilePath, []byte("custom profile\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout := bytes.Buffer{}
	options.Stdout = &stdout
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(stdout.String(), `"state":"skipped"`) {
		t.Fatalf("expected hook repair instead of skipped status, got %s", stdout.String())
	}
	assertFileContains(t, profilePath, markerStart)
	assertFileContains(t, profilePath, "helper.sh")
}

func TestRunPreservesExistingProfileContentOutsideMarkerBlock(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	profilePath := filepath.Join(homeDir, ".bashrc")
	if err := os.WriteFile(profilePath, []byte("before hook\nalias ll='ls -al'\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := Run(Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}})
	if err != nil {
		t.Fatal(err)
	}

	assertFileContains(t, profilePath, "before hook")
	assertFileContains(t, profilePath, "alias ll='ls -al'")
	assertFileContains(t, profilePath, markerStart)
	assertFileContains(t, profilePath, "helper.sh")
}

func TestRunRepairsMissingFishProfileHook(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	options := Options{Shell: "fish", Version: "1.2.3", Stdout: &bytes.Buffer{}}
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	profilePath := filepath.Join(configDir, "fish", "conf.d", "cosmosh.fish")
	if err := os.WriteFile(profilePath, []byte("set -gx CUSTOM 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout := bytes.Buffer{}
	options.Stdout = &stdout
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(stdout.String(), `"state":"skipped"`) {
		t.Fatalf("expected fish hook repair instead of skipped status, got %s", stdout.String())
	}
	assertFileContains(t, profilePath, "helper.fish")
	assertFileContains(t, profilePath, "set -gx PATH")
}

func TestRunRepairsTamperedHelper(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	options := Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	helperPath := filepath.Join(configDir, "cosmosh", "bootstrap", "helper.sh")
	if err := os.WriteFile(helperPath, []byte("stale helper\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout := bytes.Buffer{}
	options.Stdout = &stdout
	if err := Run(options); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(stdout.String(), `"state":"skipped"`) {
		t.Fatalf("expected helper repair instead of skipped status, got %s", stdout.String())
	}
	assertFileContains(t, helperPath, "__COSMOSH_HELPER_VERSION='1.2.3'")
}

func TestStatusReportsValidatedRuntimeContract(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	if err := Run(Options{Shell: "bash", Version: "1.2.3", Stdout: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}

	stdout := bytes.Buffer{}
	if err := Status(&stdout, "bash"); err != nil {
		t.Fatal(err)
	}

	status := InstallationStatus{}
	if err := json.Unmarshal(stdout.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Installed || !status.HelperCurrent || !status.ProfileCurrent {
		t.Fatalf("expected current installation status, got %+v", status)
	}
	if status.Version != "1.2.3" || status.ProtocolVersion != RemoteShellProtocolVersion {
		t.Fatalf("expected versioned protocol status, got %+v", status)
	}
	if len(status.BinarySHA256) != 64 {
		t.Fatalf("expected installed binary sha256, got %+v", status)
	}
	if !containsString(status.Capabilities, "foreground-command") {
		t.Fatalf("expected foreground-command capability, got %+v", status.Capabilities)
	}
	if len(status.ProfilePaths) != 2 {
		t.Fatalf("expected bash interactive and login profile paths, got %+v", status.ProfilePaths)
	}
}

func TestRunDoesNotWriteVersionWhenProfileUpdateFails(t *testing.T) {
	homeDir := t.TempDir()
	dataDir := filepath.Join(homeDir, "data")
	configDir := filepath.Join(homeDir, "config")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)

	if err := os.Mkdir(filepath.Join(homeDir, ".profile"), 0o700); err != nil {
		t.Fatal(err)
	}

	stdout := bytes.Buffer{}
	err := Run(Options{Shell: "sh", Version: "1.2.3", Stdout: &stdout})
	if err == nil {
		t.Fatal("expected profile update failure")
	}

	if !strings.Contains(stdout.String(), `"code":"PROFILE_UPDATE_FAILED"`) {
		t.Fatalf("expected profile update failure status, got %s", stdout.String())
	}
	assertFileNotExists(t, filepath.Join(dataDir, "cosmosh", "bootstrap", "bin", ".version"))
}

func TestReplaceMarkedBlockIsIdempotent(t *testing.T) {
	existing := "before\n" + markerStart + "\nold\n" + markerEnd + "\nafter\n"
	next := replaceMarkedBlock(existing, "new\n")

	if strings.Contains(next, "old") {
		t.Fatalf("expected old block to be replaced: %s", next)
	}

	if strings.Count(next, markerStart) != 1 {
		t.Fatalf("expected exactly one marker block: %s", next)
	}
}

func TestRunRejectsInvalidVersion(t *testing.T) {
	stdout := bytes.Buffer{}
	err := Run(Options{
		Shell:   "sh",
		Version: "invalid version",
		Stdout:  &stdout,
	})
	if err == nil {
		t.Fatal("expected invalid version error")
	}

	if !strings.Contains(stdout.String(), `"code":"INVALID_OPTIONS"`) {
		t.Fatalf("expected invalid options status, got %s", stdout.String())
	}
}

func assertFileContains(t *testing.T, path string, expected string) {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(content), expected) {
		t.Fatalf("expected %s to contain %q", path, expected)
	}
}

func assertFileNotContains(t *testing.T, path string, unexpected string) {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(content), unexpected) {
		t.Fatalf("expected %s to not contain %q", path, unexpected)
	}
}

func assertFileNotExists(t *testing.T, path string) {
	t.Helper()

	if _, err := os.Stat(path); err == nil || !os.IsNotExist(err) {
		t.Fatalf("expected %s to not exist", path)
	}
}

func readFileString(t *testing.T, path string) string {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	return string(content)
}

func assertTextOrder(t *testing.T, content string, before string, after string) {
	t.Helper()

	beforeIndex := strings.LastIndex(content, before)
	afterIndex := strings.LastIndex(content, after)
	if beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex {
		t.Fatalf("expected %q before %q", before, after)
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}

	return false
}
