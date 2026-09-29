//go:build !linux

package session

import (
	"context"
	"errors"
	"io"
)

// Run rejects unsupported hosts before starting a Shell or accepting input.
func Run(_ context.Context, _ io.ReadCloser, _ io.WriteCloser) error {
	return errors.New("session-unsupported-platform")
}

// RunStandardIO rejects unsupported hosts before touching standard descriptors.
func RunStandardIO(_ context.Context) error { return errors.New("session-unsupported-platform") }
