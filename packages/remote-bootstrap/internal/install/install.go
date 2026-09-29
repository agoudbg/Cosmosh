package install

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/nativeassets"
)

const (
	binaryFileName = "cosmosh-bootstrap"
	markerStart    = "# >>> cosmosh bootstrap >>>"
	markerEnd      = "# <<< cosmosh bootstrap <<<"
)

var versionPattern = regexp.MustCompile(`^[A-Za-z0-9._+-]+$`)

// Options contains immutable install command inputs.
type Options struct {
	Shell   string
	Version string
	Stdout  io.Writer
}

// InstallationStatus describes whether the installed runtime matches this bootstrap binary.
type InstallationStatus struct {
	Installed           bool     `json:"installed"`
	Version             string   `json:"version,omitempty"`
	ProtocolVersion     int      `json:"protocolVersion"`
	Capabilities        []string `json:"capabilities"`
	HelperCurrent       bool     `json:"helperCurrent"`
	ProfileCurrent      bool     `json:"profileCurrent"`
	BinarySHA256        string   `json:"binarySha256,omitempty"`
	BinaryPath          string   `json:"binaryPath"`
	HelperPath          string   `json:"helperPath"`
	ProfilePath         string   `json:"profilePath"`
	ProfilePaths        []string `json:"profilePaths"`
	NativeModulePath    string   `json:"nativeModulePath,omitempty"`
	NativeModuleCurrent bool     `json:"nativeModuleCurrent"`
}

type statusLine struct {
	Type    string `json:"type"`
	Phase   string `json:"phase"`
	State   string `json:"state"`
	Version string `json:"version,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type paths struct {
	binDir       string
	binaryPath   string
	versionPath  string
	helperDir    string
	helperPath   string
	profilePath  string
	profilePaths []string
}

// Run installs the current bootstrap binary and shell helper into user scope.
func Run(options Options) error {
	if err := validateOptions(options); err != nil {
		writeStatus(options.Stdout, "install", "failed", options.Version, "INVALID_OPTIONS", err.Error())
		return err
	}
	if options.Shell == "bash" {
		if _, err := nativeassets.Payload(); err != nil && !errors.Is(err, nativeassets.ErrUnavailable) {
			writeStatus(options.Stdout, "install", "failed", options.Version, "INVALID_NATIVE_MODULE", err.Error())
			return err
		}
	}

	resolvedPaths, err := resolvePaths(options.Shell)
	if err != nil {
		writeStatus(options.Stdout, "install", "failed", options.Version, "PATH_RESOLVE_FAILED", err.Error())
		return err
	}

	if isCurrentInstallation(options, resolvedPaths) {
		writeStatus(options.Stdout, "install", "skipped", options.Version, "", "bootstrap already current")
		return nil
	}

	if err := installFiles(options, resolvedPaths); err != nil {
		writeStatus(options.Stdout, "install", "failed", options.Version, "FILE_INSTALL_FAILED", err.Error())
		return err
	}

	if err := updateProfiles(options, resolvedPaths); err != nil {
		writeStatus(options.Stdout, "install", "failed", options.Version, "PROFILE_UPDATE_FAILED", err.Error())
		return err
	}

	if err := writeVersionFile(options, resolvedPaths); err != nil {
		writeStatus(options.Stdout, "install", "failed", options.Version, "VERSION_WRITE_FAILED", err.Error())
		return err
	}

	writeStatus(options.Stdout, "verify", "ok", options.Version, "", "bootstrap installed")
	return nil
}

// Status prints the installed runtime state validated by this bootstrap binary.
func Status(stdout io.Writer, shell string) error {
	resolvedPaths, err := resolvePaths(shell)
	if err != nil {
		return err
	}

	versionBytes, versionErr := os.ReadFile(resolvedPaths.versionPath)
	version := ""
	if versionErr == nil {
		version = strings.TrimSpace(string(versionBytes))
	}

	options := Options{Shell: shell, Version: version}
	helperCurrent := version != "" && helperMatches(options, resolvedPaths)
	profileCurrent := version != "" && profileHasCurrentHook(options, resolvedPaths)
	nativeRequired := options.Shell == "bash" && nativeassets.Available()
	nativeCurrent := nativeRequired && nativeMatches(resolvedPaths.binaryPath)
	binarySHA256, binaryErr := fileSHA256(resolvedPaths.binaryPath)
	payload := InstallationStatus{
		Installed:       binaryErr == nil && version != "" && helperCurrent && profileCurrent && (!nativeRequired || nativeCurrent),
		Version:         version,
		ProtocolVersion: RemoteShellProtocolVersion,
		Capabilities:    HelperCapabilities(shell),
		HelperCurrent:   helperCurrent,
		ProfileCurrent:  profileCurrent,
		BinarySHA256:    binarySHA256,
		BinaryPath:      resolvedPaths.binaryPath,
		HelperPath:      resolvedPaths.helperPath,
		ProfilePath:     resolvedPaths.profilePath,
		ProfilePaths:    append([]string(nil), resolvedPaths.profilePaths...),
	}
	if options.Shell == "bash" {
		payload.NativeModulePath = nativeassets.Path(resolvedPaths.binaryPath)
		payload.NativeModuleCurrent = nativeCurrent
	}

	return json.NewEncoder(stdout).Encode(payload)
}

func validateOptions(options Options) error {
	if !versionPattern.MatchString(options.Version) {
		return errors.New("version must contain only letters, numbers, dot, underscore, plus, or hyphen")
	}

	return validateShell(options.Shell)
}

func validateShell(shell string) error {
	switch shell {
	case "ash", "bash", "fish", "sh", "zsh":
		return nil
	default:
		return fmt.Errorf("unsupported shell: %s", shell)
	}
}

func resolvePaths(shell string) (paths, error) {
	if err := validateShell(shell); err != nil {
		return paths{}, err
	}

	homeDir, err := os.UserHomeDir()
	if err != nil || homeDir == "" {
		return paths{}, errors.New("home directory is unavailable")
	}

	dataRoot := envOrDefault("XDG_DATA_HOME", filepath.Join(homeDir, ".local", "share"))
	configRoot := envOrDefault("XDG_CONFIG_HOME", filepath.Join(homeDir, ".config"))
	helperDir := filepath.Join(configRoot, "cosmosh", "bootstrap")
	profilePaths := resolveProfilePaths(homeDir, configRoot, shell)
	return paths{
		binDir:       filepath.Join(dataRoot, "cosmosh", "bootstrap", "bin"),
		binaryPath:   filepath.Join(dataRoot, "cosmosh", "bootstrap", "bin", binaryFileName),
		versionPath:  filepath.Join(dataRoot, "cosmosh", "bootstrap", "bin", ".version"),
		helperDir:    helperDir,
		helperPath:   filepath.Join(helperDir, helperName(shell)),
		profilePath:  profilePaths[0],
		profilePaths: profilePaths,
	}, nil
}

func isCurrentInstallation(options Options, resolvedPaths paths) bool {
	versionBytes, err := os.ReadFile(resolvedPaths.versionPath)
	if err != nil || strings.TrimSpace(string(versionBytes)) != options.Version {
		return false
	}

	currentBinary, err := os.Executable()
	if err != nil || !filesEqual(currentBinary, resolvedPaths.binaryPath) {
		return false
	}

	return helperMatches(options, resolvedPaths) && profileHasCurrentHook(options, resolvedPaths) &&
		(options.Shell != "bash" || !nativeassets.Available() || nativeMatches(resolvedPaths.binaryPath))
}

// nativeFileTrusted rejects altered permissions, shared or substituted native code at each observation.
func nativeFileTrusted(info os.FileInfo, size int64) bool {
	return info.Mode() == 0o600 && info.Size() == size && nativeFileOwned(info)
}

// nativeMatches compares the embedded artifact while retaining its exact private inode identity.
func nativeMatches(binaryPath string) bool {
	modulePath := nativeassets.Path(binaryPath)
	expected, err := nativeassets.Payload()
	if err != nil {
		return false
	}
	info, err := os.Lstat(modulePath)
	if err != nil || !nativeFileTrusted(info, int64(len(expected))) {
		return false
	}
	file, err := os.Open(modulePath)
	if err != nil {
		return false
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !nativeFileTrusted(opened, int64(len(expected))) {
		return false
	}
	actual, err := io.ReadAll(io.LimitReader(file, int64(len(expected))+1))
	if err != nil || !bytes.Equal(actual, expected) {
		return false
	}
	current, err := os.Lstat(modulePath)
	return err == nil && os.SameFile(info, current) && nativeFileTrusted(current, int64(len(expected)))
}

func helperMatches(options Options, resolvedPaths paths) bool {
	expected, err := BuildHelper(options.Shell, options.Version, resolvedPaths.binaryPath)
	if err != nil {
		return false
	}

	actual, err := os.ReadFile(resolvedPaths.helperPath)
	return err == nil && string(actual) == expected
}

func profileHasCurrentHook(options Options, resolvedPaths paths) bool {
	for _, profilePath := range resolvedPaths.profilePaths {
		contentBytes, err := os.ReadFile(profilePath)
		if err != nil {
			return false
		}

		content := string(contentBytes)
		if options.Shell == "fish" {
			if !strings.Contains(content, fishProfileBlock(resolvedPaths)) {
				return false
			}
			continue
		}

		if !strings.Contains(content, markerStart) ||
			!strings.Contains(content, posixProfileBlock(options.Shell, resolvedPaths)) ||
			!strings.Contains(content, markerEnd) {
			return false
		}
	}

	return true
}

func installFiles(options Options, resolvedPaths paths) error {
	if err := os.MkdirAll(resolvedPaths.binDir, 0o700); err != nil {
		return err
	}

	if err := os.MkdirAll(resolvedPaths.helperDir, 0o700); err != nil {
		return err
	}

	currentBinary, err := os.Executable()
	if err != nil {
		return err
	}

	if err := copyFileAtomically(currentBinary, resolvedPaths.binaryPath, 0o700); err != nil {
		return err
	}

	if options.Shell == "bash" {
		modulePath := nativeassets.Path(resolvedPaths.binaryPath)
		module, err := nativeassets.Payload()
		switch {
		case err == nil:
			if err := writeFileAtomically(modulePath, module, 0o600, false); err != nil {
				return fmt.Errorf("install Bash native module: %w", err)
			}
		case errors.Is(err, nativeassets.ErrUnavailable):
			// Development builds neither install nor load an unbundled module.
		default:
			return fmt.Errorf("load embedded Bash native module: %w", err)
		}
	}

	helper, err := BuildHelper(options.Shell, options.Version, resolvedPaths.binaryPath)
	if err != nil {
		return err
	}

	if err := writeFileAtomically(resolvedPaths.helperPath, []byte(helper), 0o600, false); err != nil {
		return err
	}

	return nil
}

func writeVersionFile(options Options, resolvedPaths paths) error {
	return writeFileAtomically(resolvedPaths.versionPath, []byte(options.Version+"\n"), 0o600, false)
}

func updateProfiles(options Options, resolvedPaths paths) error {
	for _, profilePath := range resolvedPaths.profilePaths {
		if options.Shell == "fish" {
			if err := writeFishProfile(profilePath, resolvedPaths); err != nil {
				return err
			}
			continue
		}

		existing := ""
		if content, err := os.ReadFile(profilePath); err == nil {
			existing = string(content)
		} else if !os.IsNotExist(err) {
			return err
		}

		nextContent := replaceMarkedBlock(existing, posixProfileBlock(options.Shell, resolvedPaths))
		if err := writeFileAtomically(profilePath, []byte(nextContent), 0o600, true); err != nil {
			return err
		}
	}

	return nil
}

func writeFishProfile(profilePath string, resolvedPaths paths) error {
	if err := os.MkdirAll(filepath.Dir(profilePath), 0o700); err != nil {
		return err
	}

	return writeFileAtomically(profilePath, []byte(fishProfileBlock(resolvedPaths)), 0o600, true)
}

func replaceMarkedBlock(existing string, block string) string {
	startIndex := strings.Index(existing, markerStart)
	endIndex := strings.Index(existing, markerEnd)
	markedBlock := markerStart + "\n" + block + markerEnd + "\n"

	if startIndex >= 0 && endIndex > startIndex {
		endIndex += len(markerEnd)
		remaining := strings.TrimLeft(existing[endIndex:], "\r\n")
		return existing[:startIndex] + markedBlock + remaining
	}

	separator := "\n"
	if strings.TrimSpace(existing) == "" {
		separator = ""
	}

	return existing + separator + markedBlock
}

func posixProfileBlock(shell string, resolvedPaths paths) string {
	helperSource := fmt.Sprintf("if [ -r %q ]; then . %q; fi\n", resolvedPaths.helperPath, resolvedPaths.helperPath)
	if shell == "bash" {
		helperSource = fmt.Sprintf(
			"if [ -n \"${BASH_VERSION:-}\" ] && [ -r %q ]; then . %q; fi\n",
			resolvedPaths.helperPath,
			resolvedPaths.helperPath,
		)
	}

	return fmt.Sprintf(
		"case :$PATH: in *:%q:*) ;; *) export PATH=%q:$PATH ;; esac\n%s",
		resolvedPaths.binDir,
		resolvedPaths.binDir,
		helperSource,
	)
}

func fishProfileBlock(resolvedPaths paths) string {
	return fmt.Sprintf("set -gx PATH %q $PATH\nsource %q\n", resolvedPaths.binDir, resolvedPaths.helperPath)
}

func copyFileAtomically(sourcePath string, targetPath string, mode os.FileMode) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()

	target, tempPath, err := createAtomicTarget(targetPath, mode, false)
	if err != nil {
		return err
	}
	defer os.Remove(tempPath)

	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		return err
	}

	return commitAtomicTarget(target, tempPath, targetPath)
}

func writeFileAtomically(targetPath string, content []byte, mode os.FileMode, preserveExistingMode bool) error {
	resolvedTargetPath, err := resolvePreservedAtomicTargetPath(targetPath, preserveExistingMode)
	if err != nil {
		return err
	}
	targetPath = resolvedTargetPath

	target, tempPath, err := createAtomicTarget(targetPath, mode, preserveExistingMode)
	if err != nil {
		return err
	}
	defer os.Remove(tempPath)

	if _, err := target.Write(content); err != nil {
		_ = target.Close()
		return err
	}

	return commitAtomicTarget(target, tempPath, targetPath)
}

// resolvePreservedAtomicTargetPath keeps user-managed profile symlinks intact while
// binary and helper installation paths continue to replace links instead of following them.
func resolvePreservedAtomicTargetPath(targetPath string, preserveExistingMode bool) (string, error) {
	if !preserveExistingMode {
		return targetPath, nil
	}

	info, err := os.Lstat(targetPath)
	if os.IsNotExist(err) {
		return targetPath, nil
	}
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return targetPath, nil
	}

	resolvedPath, err := filepath.EvalSymlinks(targetPath)
	if err == nil {
		return resolvedPath, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}

	// A dangling chain (dotfile managers before their first sync) must still
	// install: follow the link targets manually and create the managed file,
	// matching what a direct write through the symlink would have done.
	return resolveDanglingSymlinkTargetPath(targetPath)
}

// resolveDanglingSymlinkTargetPath follows a symlink chain whose final target does
// not exist yet and returns the path installation should create.
func resolveDanglingSymlinkTargetPath(linkPath string) (string, error) {
	currentPath := linkPath
	for hop := 0; hop < 16; hop++ {
		info, err := os.Lstat(currentPath)
		if os.IsNotExist(err) {
			return currentPath, nil
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return currentPath, nil
		}

		linkTarget, err := os.Readlink(currentPath)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(linkTarget) {
			linkTarget = filepath.Join(filepath.Dir(currentPath), linkTarget)
		}
		currentPath = linkTarget
	}

	return "", fmt.Errorf("profile symlink chain at %s exceeds resolution limit", linkPath)
}

func createAtomicTarget(targetPath string, mode os.FileMode, preserveExistingMode bool) (*os.File, string, error) {
	parentDir := filepath.Dir(targetPath)
	if err := os.MkdirAll(parentDir, 0o700); err != nil {
		return nil, "", err
	}

	effectiveMode := mode
	if preserveExistingMode {
		if info, err := os.Stat(targetPath); err == nil {
			effectiveMode = info.Mode().Perm()
		} else if !os.IsNotExist(err) {
			return nil, "", err
		}
	}

	target, err := os.CreateTemp(parentDir, ".cosmosh-install-*")
	if err != nil {
		return nil, "", err
	}
	if err := target.Chmod(effectiveMode); err != nil {
		tempPath := target.Name()
		_ = target.Close()
		_ = os.Remove(tempPath)
		return nil, "", err
	}

	return target, target.Name(), nil
}

func commitAtomicTarget(target *os.File, tempPath string, targetPath string) error {
	if err := target.Sync(); err != nil {
		_ = target.Close()
		return err
	}
	if err := target.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return err
	}

	return syncDirectory(filepath.Dir(targetPath))
}

func syncDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}

	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func filesEqual(firstPath string, secondPath string) bool {
	first, err := os.ReadFile(firstPath)
	if err != nil {
		return false
	}
	second, err := os.ReadFile(secondPath)
	return err == nil && bytes.Equal(first, second)
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

func envOrDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}

	return value
}

func helperName(shell string) string {
	if shell == "fish" {
		return "helper.fish"
	}

	return "helper.sh"
}

// resolveProfilePaths selects every startup file that must load the shell helper.
// Bash login candidates use Lstat so dotfile-manager symlinks remain authoritative
// even before their managed targets have been created.
func resolveProfilePaths(homeDir string, configRoot string, shell string) []string {
	if shell == "fish" {
		return []string{filepath.Join(configRoot, "fish", "conf.d", "cosmosh.fish")}
	}

	if shell == "zsh" {
		return []string{filepath.Join(homeDir, ".zshrc")}
	}

	if shell == "bash" {
		loginProfilePath := filepath.Join(homeDir, ".profile")
		for _, candidate := range []string{".bash_profile", ".bash_login"} {
			candidatePath := filepath.Join(homeDir, candidate)
			if _, err := os.Lstat(candidatePath); err == nil {
				loginProfilePath = candidatePath
				break
			}
		}

		return []string{filepath.Join(homeDir, ".bashrc"), loginProfilePath}
	}

	return []string{filepath.Join(homeDir, ".profile")}
}

func writeStatus(stdout io.Writer, phase string, state string, version string, code string, message string) {
	if stdout == nil {
		stdout = os.Stdout
	}

	_ = json.NewEncoder(stdout).Encode(statusLine{
		Type:    "bootstrap-status",
		Phase:   phase,
		State:   state,
		Version: version,
		Code:    code,
		Message: message,
	})
}
