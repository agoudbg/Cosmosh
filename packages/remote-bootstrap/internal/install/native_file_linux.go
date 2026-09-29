package install

import (
	"os"
	"syscall"
)

// nativeFileOwned rejects shared or foreign module inodes before the shell loads one.
func nativeFileOwned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid()) && stat.Nlink == 1
}
