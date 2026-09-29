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
