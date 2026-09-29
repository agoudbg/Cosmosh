//go:build cosmosh_native

package nativeassets

import (
	"embed"
	"fmt"
	"runtime"
)

//go:embed assets/cosmosh-bash-linux-amd64.so assets/cosmosh-bash-linux-arm64.so
var modules embed.FS

// Payload selects the checked native module for this release target.
func Payload() ([]byte, error) {
	if runtime.GOOS != "linux" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return nil, fmt.Errorf("unsupported Bash module target: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	name := "assets/cosmosh-bash-linux-" + runtime.GOARCH + ".so"
	content, err := modules.ReadFile(name)
	if err != nil {
		return nil, fmt.Errorf("read embedded Bash module %s: %w", name, err)
	}
	if len(content) < 20 || string(content[:4]) != "\x7fELF" || content[4] != 2 || content[5] != 1 {
		return nil, fmt.Errorf("embedded Bash module %s is not a 64-bit little-endian ELF image", name)
	}
	machine := uint16(content[18]) | uint16(content[19])<<8
	if (runtime.GOARCH == "amd64" && machine != 62) || (runtime.GOARCH == "arm64" && machine != 183) {
		return nil, fmt.Errorf("embedded Bash module %s has the wrong architecture", name)
	}
	return content, nil
}

// Available reports whether this bootstrap contains a valid native Bash module.
func Available() bool {
	_, err := Payload()
	return err == nil
}
