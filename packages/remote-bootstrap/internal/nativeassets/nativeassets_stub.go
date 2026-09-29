//go:build !cosmosh_native

package nativeassets

// Payload reports that ordinary development builds do not embed native modules.
func Payload(shell string) ([]byte, error) {
	return nil, ErrUnavailable
}

// Available reports whether this bootstrap contains the selected native module.
func Available(shell string) bool {
	return false
}
