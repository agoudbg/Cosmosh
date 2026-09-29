//go:build cosmosh_native

package nativeassets

import (
	"embed"
	"fmt"
	"runtime"
)

//go:embed assets/cosmosh-bash-linux-amd64.so assets/cosmosh-bash-linux-arm64.so assets/cosmosh-zsh-linux-amd64.so assets/cosmosh-zsh-linux-arm64.so
var modules embed.FS

// Payload selects the checked native module for this release target.
func Payload(shell string) ([]byte, error) {
	if !NativeShell(shell) {
		return nil, fmt.Errorf("unsupported native module shell: %s", shell)
	}
	if runtime.GOOS != "linux" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return nil, fmt.Errorf("unsupported %s module target: %s/%s", shell, runtime.GOOS, runtime.GOARCH)
	}
	name := "assets/cosmosh-" + shell + "-linux-" + runtime.GOARCH + ".so"
	content, err := modules.ReadFile(name)
	if err != nil {
		return nil, fmt.Errorf("read embedded %s module %s: %w", shell, name, err)
	}
	if len(content) < 20 || string(content[:4]) != "\x7fELF" || content[4] != 2 || content[5] != 1 {
		return nil, fmt.Errorf("embedded %s module %s is not a 64-bit little-endian ELF image", shell, name)
	}
	machine := uint16(content[18]) | uint16(content[19])<<8
	if (runtime.GOARCH == "amd64" && machine != 62) || (runtime.GOARCH == "arm64" && machine != 183) {
		return nil, fmt.Errorf("embedded %s module %s has the wrong architecture", shell, name)
	}
	return content, nil
}

// Available reports whether this bootstrap contains the selected valid native module.
func Available(shell string) bool {
	_, err := Payload(shell)
	return err == nil
}
