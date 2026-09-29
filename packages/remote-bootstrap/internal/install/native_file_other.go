//go:build !linux

package install

import "os"

// nativeFileOwned is relevant only to the distributed Linux native module.
func nativeFileOwned(info os.FileInfo) bool {
	return true
}
