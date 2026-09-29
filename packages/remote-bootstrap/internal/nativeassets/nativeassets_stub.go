//go:build !cosmosh_native

package nativeassets

// Payload reports that ordinary development builds do not embed a native module.
func Payload() ([]byte, error) {
	return nil, ErrUnavailable
}

// Available reports whether this bootstrap contains a native Bash module.
func Available() bool {
	return false
}
