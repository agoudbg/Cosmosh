//go:build linux

package editor

import (
	"syscall"
	"testing"
)

func TestPrivateKeyRejectsSpecialCharacterCollisions(t *testing.T) {
	supported := syscall.Termios{Lflag: syscall.ISIG}
	supported.Cc[syscall.VINTR] = 3
	supported.Cc[syscall.VQUIT] = 28
	supported.Cc[syscall.VSUSP] = 26
	supported.Cc[syscall.VSTART] = 17
	supported.Cc[syscall.VSTOP] = 19
	supported.Cc[syscall.VMIN] = '9'
	if !triggerTerminalSupported(&supported) {
		t.Fatal("native Readline line discipline should be supported")
	}
	for _, index := range []int{syscall.VINTR, syscall.VQUIT, syscall.VSUSP, syscall.VSTART, syscall.VSTOP} {
		modified := supported
		modified.Cc[index] = '9'
		if triggerTerminalSupported(&modified) {
			t.Fatal("private key could be interpreted as a terminal special character")
		}
	}
	supported.Lflag |= syscall.ICANON
	if triggerTerminalSupported(&supported) {
		t.Fatal("canonical input is not an active editor")
	}
}
