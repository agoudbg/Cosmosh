// Package session owns the private, connection-scoped terminal transport.
package session

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sync"
)

const (
	// ProtocolVersion is independent of the Shell's OSC observation protocol.
	ProtocolVersion = 1
	maxFrameBytes   = 96 * 1024
	maxDataBytes    = 64 * 1024
	maxSequence     = uint64(1<<53 - 1)
)

var epochPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
var termPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$`)

// frame contains only bounded control metadata or base64-encoded terminal bytes.
// Input delivery never implies that the Shell has consumed the bytes.
type frame struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol,omitempty"`
	Epoch    string `json:"epoch,omitempty"`
	Sequence uint64 `json:"sequence,omitempty"`
	Data     []byte `json:"data,omitempty"`
	Rows     uint16 `json:"rows,omitempty"`
	Cols     uint16 `json:"cols,omitempty"`
	Term     string `json:"term,omitempty"`
	PID      int    `json:"pid,omitempty"`
	Code     *int   `json:"code,omitempty"`
}

// frameReader bounds allocations before standard-library JSON decoding.
type frameReader struct{ scanner *bufio.Scanner }

// newFrameReader creates a reader whose single pending line has a fixed ceiling.
func newFrameReader(input io.Reader) *frameReader {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), maxFrameBytes)
	return &frameReader{scanner: scanner}
}

// read rejects trailing values and unknown fields without retaining input in errors.
func (reader *frameReader) read() (frame, error) {
	var value frame
	if !reader.scanner.Scan() {
		if reader.scanner.Err() != nil {
			return value, errors.New("session-frame-too-large")
		}
		return value, io.EOF
	}
	decoder := json.NewDecoder(bytes.NewReader(reader.scanner.Bytes()))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		return frame{}, errors.New("session-invalid-frame")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return frame{}, errors.New("session-invalid-frame")
	}
	return value, nil
}

// validStart admits only an explicit handshake before a child Shell can start.
func (value frame) validStart() bool {
	return value.Type == "start" && value.Protocol == ProtocolVersion && epochPattern.MatchString(value.Epoch) &&
		termPattern.MatchString(value.Term) && value.validSize() && value.Sequence == 0 && len(value.Data) == 0 && value.PID == 0 && value.Code == nil
}

// validSize applies the same dimensions as the desktop terminal boundary.
func (value frame) validSize() bool {
	return value.Rows >= 10 && value.Rows <= 200 && value.Cols >= 20 && value.Cols <= 400
}

// validControl rejects cross-session data, skipped sequences and unrelated fields.
func (value frame) validControl(epoch string, delivered uint64) bool {
	if value.Epoch != epoch || value.Protocol != 0 || value.Term != "" || value.PID != 0 || value.Code != nil {
		return false
	}
	switch value.Type {
	case "input":
		return value.Sequence == delivered+1 && value.Sequence <= maxSequence && len(value.Data) > 0 && len(value.Data) <= maxDataBytes && value.Rows == 0 && value.Cols == 0
	case "resize":
		return value.Sequence == 0 && len(value.Data) == 0 && value.validSize()
	default:
		return false
	}
}

// frameWriter keeps concurrent PTY output and delivery confirmations on complete JSON lines.
type frameWriter struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

// write returns a fixed error that cannot expose a user's command or password.
func (writer *frameWriter) write(value frame) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.encoder.Encode(value) != nil {
		return errors.New("session-output-failed")
	}
	return nil
}

// deliver confirms only after the entire input chunk reaches the PTY master.
// A partial failure is never retried by another transport and never acknowledged.
func deliver(terminal io.Writer, input frame, acknowledge func(frame) error) error {
	data := input.Data
	for len(data) > 0 {
		written, err := terminal.Write(data)
		if written < 0 || written > len(data) {
			return errors.New("session-input-failed")
		}
		data = data[written:]
		if err != nil || written == 0 {
			return errors.New("session-input-failed")
		}
	}
	return acknowledge(frame{Type: "delivered", Epoch: input.Epoch, Sequence: input.Sequence})
}
