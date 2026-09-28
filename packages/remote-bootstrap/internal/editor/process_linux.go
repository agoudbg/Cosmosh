//go:build linux

package editor

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// processIdentity uses kernel metadata rather than Shell text to identify the original PTY owner.
type processIdentity struct {
	parent, group, terminal, foreground int
	start                               string
}

// readProcess parses Linux proc stat, whose parenthesized command name may contain spaces or parentheses.
func readProcess(pid int) (processIdentity, error) {
	var identity processIdentity
	base := fmt.Sprintf("/proc/%d", pid)
	info, err := os.Stat(base)
	if err != nil {
		return identity, errors.New("target-unavailable")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return identity, errors.New("target-unavailable")
	}
	raw, err := os.ReadFile(base + "/stat")
	if err != nil || len(raw) > 8192 {
		return identity, errors.New("target-unavailable")
	}
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return identity, errors.New("target-unavailable")
	}
	fields := strings.Fields(string(raw[end+1:]))
	if len(fields) < 20 {
		return identity, errors.New("target-unavailable")
	}
	positions := []*int{&identity.parent, &identity.group, &identity.terminal, &identity.foreground}
	for index, field := range []int{1, 2, 4, 5} {
		value, err := strconv.Atoi(fields[field])
		if err != nil {
			return identity, errors.New("target-unavailable")
		}
		*positions[index] = value
	}
	identity.start = fields[19]
	return identity, nil
}

// ProcessStart returns a kernel process generation for Shell initialization, without inspecting its environment.
func ProcessStart(pid int) (string, error) {
	identity, err := readProcess(pid)
	if err != nil {
		return "", err
	}
	return identity.start, nil
}

// checkTarget requires the same executable, PID generation and real controlling terminal.
// Foreground ownership is checked before injection; a widget's child may own the group during capture.
func checkTarget(target Target, foreground bool) error {
	identity, err := readProcess(target.PID)
	if err != nil || identity.start != target.StartTime || identity.terminal == 0 ||
		(foreground && identity.group != identity.foreground) {
		return errors.New("target-unavailable")
	}
	executable, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", target.PID))
	if err != nil || filepath.Base(executable) != target.Shell {
		return errors.New("target-unavailable")
	}
	if foreground && checkTriggerTerminal(target.PID, identity.terminal) != nil {
		return errors.New("target-unavailable")
	}
	return nil
}

// triggerTerminalSupported rejects line disciplines that can consume bytes of the private key as signals or flow control.
func triggerTerminalSupported(attributes *syscall.Termios) bool {
	if attributes.Lflag&syscall.ICANON != 0 {
		return false
	}
	const triggerAlphabet = "\x1b[997;0123456789abcdef-~"
	for index, value := range attributes.Cc {
		if index != syscall.VMIN && index != syscall.VTIME && value != 0 &&
			strings.IndexByte(triggerAlphabet, value) >= 0 {
			return false
		}
	}
	return true
}

// checkTriggerTerminal inspects the original Shell stdin without reading bytes or acquiring terminal ownership.
func checkTriggerTerminal(pid, terminal int) error {
	fd, err := syscall.Open(fmt.Sprintf("/proc/%d/fd/0", pid), syscall.O_RDONLY|syscall.O_NOCTTY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var stat syscall.Stat_t
	if syscall.Fstat(fd, &stat) != nil || stat.Mode&syscall.S_IFMT != syscall.S_IFCHR ||
		stat.Rdev != uint64(uint32(terminal)) {
		return errors.New("terminal-unavailable")
	}
	var attributes syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(syscall.TCGETS), uintptr(unsafe.Pointer(&attributes)))
	if errno != 0 || !triggerTerminalSupported(&attributes) {
		return errors.New("terminal-unavailable")
	}
	return nil
}

// checkPeer authenticates the Unix socket caller as a same-user descendant of the original Shell.
func checkPeer(connection *net.UnixConn, target Target) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return errors.New("peer-rejected")
	}
	var credential *syscall.Ucred
	var readErr error
	if err = raw.Control(func(fd uintptr) {
		credential, readErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil || readErr != nil || credential == nil || credential.Uid != uint32(os.Getuid()) {
		return errors.New("peer-rejected")
	}
	if err := checkTarget(target, false); err != nil {
		return err
	}
	original, err := readProcess(target.PID)
	if err != nil {
		return err
	}
	pid := int(credential.Pid)
	for depth := 0; depth < 32 && pid > 1; depth++ {
		if pid == target.PID {
			return nil
		}
		current, err := readProcess(pid)
		if err != nil || current.terminal != original.terminal || current.parent == pid {
			return errors.New("peer-rejected")
		}
		pid = current.parent
	}
	return errors.New("peer-rejected")
}

// secureSocketDirectory creates one user-owned directory without following an existing symlink.
func secureSocketDirectory() (string, error) {
	directory := fmt.Sprintf("/tmp/cosmosh-editor-%d", os.Getuid())
	if err := os.Mkdir(directory, 0700); err != nil && !os.IsExist(err) {
		return "", errors.New("socket-unavailable")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", errors.New("socket-unavailable")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return "", errors.New("socket-unavailable")
	}
	return directory, nil
}

// physicalDirectory asks the kernel for a physical path; a deleted directory remains unavailable.
func physicalDirectory() *string {
	value, err := syscall.Getwd()
	if err != nil || !validPath(value) {
		return nil
	}
	return &value
}
