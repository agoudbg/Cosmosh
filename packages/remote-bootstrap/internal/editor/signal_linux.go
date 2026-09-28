//go:build linux && (amd64 || arm64)

package editor

import (
	"errors"
	"syscall"
)

// Linux assigns these pidfd system calls identically on the two distributed helper architectures.
// Requiring pidfd avoids the PID-reuse race in a check followed by kill(2); old kernels fail closed.
const (
	sysPidfdSendSignal = 424
	sysPidfdOpen       = 434
)

// signalFishEditor pins the process before validating its identity and foreground ownership.
// SIGURG has an ignored default disposition, so removing the callback cannot terminate the Shell.
func signalFishEditor(target Target) error {
	if target.Shell != "fish" {
		return errors.New("notification-unavailable")
	}
	fd, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(target.PID), 0, 0)
	if errno != 0 {
		return errors.New("notification-unavailable")
	}
	defer syscall.Close(int(fd))
	if err := checkTarget(target, true); err != nil {
		return err
	}
	_, _, errno = syscall.Syscall6(sysPidfdSendSignal, fd, uintptr(syscall.SIGURG), 0, 0, 0, 0)
	if errno != 0 {
		return errors.New("notification-unavailable")
	}
	return nil
}
