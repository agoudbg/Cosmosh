//go:build linux

package editor

import (
	"os"
	"strconv"
	"syscall"
	"testing"
)

func TestNotificationRequiresTheOriginalPipeInode(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	info, err := reader.Stat()
	if err != nil {
		t.Fatal(err)
	}
	inode := info.Sys().(*syscall.Stat_t).Ino
	notification := Notification{FD: int(reader.Fd()), Inode: strconv.FormatUint(inode, 10)}
	wrong := notification
	wrong.Inode = strconv.FormatUint(inode+1, 10)
	if writeEditorNotification(os.Getpid(), wrong) == nil {
		t.Fatal("accepted a reused pipe identity")
	}
	if err := writeEditorNotification(os.Getpid(), notification); err != nil {
		t.Fatal(err)
	}
	var signal [1]byte
	if count, err := reader.Read(signal[:]); err != nil || count != 1 || signal[0] != 1 {
		t.Fatal("private notification was not delivered")
	}
	file, err := os.CreateTemp(t.TempDir(), "reused-descriptor")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString("unchanged"); err != nil {
		t.Fatal(err)
	}
	fileInfo, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	regular := Notification{FD: int(file.Fd()), Inode: strconv.FormatUint(fileInfo.Sys().(*syscall.Stat_t).Ino, 10)}
	if writeEditorNotification(os.Getpid(), regular) == nil {
		t.Fatal("accepted a regular file")
	}
	content, err := os.ReadFile(file.Name())
	if err != nil || string(content) != "unchanged" {
		t.Fatal("notification changed a reused descriptor")
	}
}

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
