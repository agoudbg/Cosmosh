//go:build linux && !amd64 && !arm64

package editor

import "errors"

// signalFishEditor does not guess system call numbers on architectures outside packaged helper support.
func signalFishEditor(_ Target) error { return errors.New("notification-unavailable") }
