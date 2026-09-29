//go:build !linux

// Package inputorder rejects native editor ordering on unsupported hosts.
package inputorder

import (
	"context"
	"errors"
)

var errUnavailable = errors.New("input-order-unsupported-platform")

// Boundary identifies one remote session and its complete input delivery point.
type Boundary struct {
	Epoch    string `json:"epoch"`
	Sequence uint64 `json:"sequence"`
}

// Store has no implementation outside Linux.
type Store struct{}

// Path rejects metadata paths on unsupported hosts.
func Path(string) (string, error) { return "", errUnavailable }

// Path rejects metadata paths on unsupported hosts.
func (*Store) Path() string { return "" }

// Create rejects metadata creation on unsupported hosts.
func Create(string) (*Store, error) { return nil, errUnavailable }

// SetShellPID rejects ownership on unsupported hosts.
func (*Store) SetShellPID(int) error { return errUnavailable }

// Receive rejects input on unsupported hosts.
func (*Store) Receive(context.Context, uint64) error { return errUnavailable }

// Deliver rejects input on unsupported hosts.
func (*Store) Deliver(context.Context, uint64) error { return errUnavailable }

// Authorize rejects editing on unsupported hosts.
func (*Store) Authorize(context.Context, string, uint64) (bool, error) {
	return false, errUnavailable
}

// Revoke rejects editing on unsupported hosts.
func (*Store) Revoke(context.Context, string) error { return errUnavailable }

// CheckBoundary rejects observations on unsupported hosts.
func CheckBoundary(int, Boundary) bool { return false }

// ClaimFD rejects editing on unsupported hosts.
func ClaimFD(int, int, Boundary, string) bool { return false }

// ClaimReadFD rejects observation on unsupported hosts.
func ClaimReadFD(int, int, Boundary) bool { return false }

// UnlockFD rejects editing on unsupported hosts.
func UnlockFD(int) error { return errUnavailable }

// Close has no resources outside Linux.
func (*Store) Close() error { return nil }
