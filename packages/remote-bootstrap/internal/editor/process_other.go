//go:build !linux

package editor

import (
	"errors"
	"net"
)

// ProcessStart rejects remote editor operations on unsupported operating systems.
func ProcessStart(_ int) (string, error)        { return "", errors.New("unsupported-platform") }
func checkTarget(_ Target, _ bool) error        { return errors.New("unsupported-platform") }
func checkPeer(_ *net.UnixConn, _ Target) error { return errors.New("unsupported-platform") }
func secureSocketDirectory() (string, error)    { return "", errors.New("unsupported-platform") }
func physicalDirectory() *string                { return nil }
