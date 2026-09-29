package editor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// RequestTimeout bounds a worker's complete lifetime, including an interrupted widget.
const RequestTimeout = 1500 * time.Millisecond

// widgetMessage is private socket data, never OSC or terminal debug metadata.
type widgetMessage struct {
	Phase            string    `json:"phase"`
	Target           Target    `json:"target"`
	PromptGeneration uint64    `json:"promptGeneration"`
	RequestID        string    `json:"requestId,omitempty"`
	Snapshot         *Snapshot `json:"snapshot,omitempty"`
}

// widgetReply grants only the data requested by the desktop's current permissions.
type widgetReply struct {
	Status           string   `json:"status"`
	RequestID        string   `json:"requestId,omitempty"`
	Operation        string   `json:"operation,omitempty"`
	IncludeDirectory bool     `json:"includeDirectory,omitempty"`
	Replacement      *Buffer  `json:"replacement,omitempty"`
	History          *History `json:"history,omitempty"`
}

// readFrame reads one bounded JSON line without allowing an unbounded allocation.
func readFrame(reader *bufio.Reader) ([]byte, error) {
	var result []byte
	for {
		part, continued, err := reader.ReadLine()
		if err != nil || len(result)+len(part) > MaxMessageBytes {
			return nil, errors.New("invalid-frame")
		}
		result = append(result, part...)
		if !continued {
			return result, nil
		}
	}
}

// decodeFrame validates a complete socket record and rejects unknown fields or trailing JSON.
func decodeFrame(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return errors.New("invalid-frame")
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return errors.New("invalid-frame")
	}
	return nil
}

// socketAddress is based exclusively on validated non-secret Shell identity.
func socketAddress(target Target) (string, error) {
	if !validTarget(target) {
		return "", errors.New("invalid-target")
	}
	directory, err := secureSocketDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, target.InstanceID+".sock"), nil
}

// RunRequest serves exactly one bounded editor exchange. Apply requires a second desktop authorization
// after capture and reports success only after the Shell confirms its assigned buffer.
func RunRequest(parent context.Context, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithTimeout(parent, RequestTimeout)
	defer cancel()
	deadline := time.Now().Add(RequestTimeout)
	reader := bufio.NewReaderSize(input, 4096)
	type initialFrame struct {
		raw []byte
		err error
	}
	initial := make(chan initialFrame, 1)
	go func() { raw, err := readFrame(reader); initial <- initialFrame{raw, err} }()
	var raw []byte
	select {
	case frame := <-initial:
		if frame.err != nil {
			return frame.err
		}
		raw = frame.raw
	case <-ctx.Done():
		return errors.New("request-timeout")
	}
	request, err := ReadRequest(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	release := func() {}
	defer func() { release() }()
	emit := func(phase, status string, snapshot *Snapshot, applied bool) error {
		if phase == "done" {
			release()
		}
		return encoder.Encode(Message{Type: "editor", Phase: phase, RequestID: request.RequestID,
			Status: status, Snapshot: snapshot, Applied: applied})
	}
	finish := func(status string) error { return emit("done", status, nil, false) }
	if err := checkTarget(request.Target, true); err != nil {
		return finish("target-unavailable")
	}
	address, err := socketAddress(request.Target)
	if err != nil {
		return finish("socket-unavailable")
	}
	// Never delete an existing endpoint: it may belong to another in-flight request.
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: address, Net: "unix"})
	if err != nil {
		return finish("socket-unavailable")
	}
	listener.SetUnlinkOnClose(false)
	info, statErr := os.Lstat(address)
	var releaseOnce sync.Once
	release = func() {
		releaseOnce.Do(func() {
			listener.Close()
			current, err := os.Lstat(address)
			if statErr == nil && err == nil && os.SameFile(info, current) {
				_ = os.Remove(address)
			}
		})
	}
	go func() {
		<-ctx.Done()
		listener.Close()
	}()
	if statErr != nil || os.Chmod(address, 0600) != nil {
		return finish("socket-unavailable")
	}
	_ = listener.SetDeadline(deadline)
	// EOF/cancellation closes the listener immediately. Apply permission stays on stdin rather than argv.
	authorization := make(chan bool, 1)
	activationReady := make(chan bool, 1)
	go func() {
		if request.Notification != nil {
			line, err := readFrame(reader)
			var activation struct {
				RequestID string `json:"requestId"`
				Activate  bool   `json:"activate"`
			}
			if err != nil || decodeFrame(line, &activation) != nil ||
				activation.RequestID != request.RequestID || !activation.Activate ||
				ctx.Err() != nil || notifyEditor(request.Target, *request.Notification) != nil {
				activationReady <- false
				authorization <- false
				cancel()
				return
			}
			activationReady <- true
		}
		line, err := readFrame(reader)
		var decision struct {
			RequestID string `json:"requestId"`
			Apply     bool   `json:"apply"`
		}
		approved := err == nil && decodeFrame(line, &decision) == nil &&
			decision.RequestID == request.RequestID && decision.Apply
		authorization <- approved
		if !approved {
			cancel()
		}
	}()
	if err := emit("ready", "", nil, false); err != nil {
		return err
	}
	// A leftover byte from a canceled notification must not grant a new request's permissions.
	// Accepting mode/capture waits until this request's desktop activation has been validated.
	if request.Notification != nil {
		select {
		case activated := <-activationReady:
			if !activated {
				return finish("unavailable")
			}
		case <-ctx.Done():
			return finish("unavailable")
		}
	}
	phase := "mode"
	applicationDecided := false
	attempts := 0
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if applicationDecided {
				return finish("unknown")
			}
			return finish("unavailable")
		}
		attempts++
		stopClose := context.AfterFunc(ctx, func() { connection.Close() })
		defer stopClose()
		if attempts > 64 {
			connection.Close()
			return finish("unavailable")
		}
		_ = connection.SetDeadline(deadline)
		if checkPeer(connection, request.Target) != nil {
			connection.Close()
			continue
		}
		line, readErr := readFrame(bufio.NewReaderSize(connection, 4096))
		var widget widgetMessage
		if readErr == nil && decodeFrame(line, &widget) == nil &&
			widget.Target == request.Target && widget.PromptGeneration == request.PromptGeneration &&
			widget.Phase == "reject" && (phase == "mode" || widget.RequestID == request.RequestID) {
			_ = json.NewEncoder(connection).Encode(widgetReply{Status: "ok"})
			connection.Close()
			if applicationDecided {
				return finish("unknown")
			}
			return finish("unsupported")
		}
		if readErr != nil || decodeFrame(line, &widget) != nil || widget.Target != request.Target ||
			widget.PromptGeneration != request.PromptGeneration || widget.Phase != phase ||
			(phase != "mode" && widget.RequestID != request.RequestID) {
			_ = json.NewEncoder(connection).Encode(widgetReply{Status: "stale"})
			connection.Close()
			continue
		}
		if phase == "mode" {
			var history *History
			if request.Operation == "history-delete" {
				history = request.Expected.History
			}
			err = json.NewEncoder(connection).Encode(widgetReply{Status: "ok", RequestID: request.RequestID,
				Operation: request.Operation, IncludeDirectory: request.IncludeDirectory, History: history})
			connection.Close()
			if err != nil {
				return finish("unavailable")
			}
			phase = "capture"
			continue
		}
		includeInput := request.Operation == "snapshot" || request.Operation == "apply"
		includeHistory := request.Operation == "history" || request.Operation == "history-delete"
		if widget.Snapshot == nil || !validSnapshot(*widget.Snapshot, includeInput, request.IncludeDirectory, includeHistory) {
			_ = json.NewEncoder(connection).Encode(widgetReply{Status: "unsupported"})
			connection.Close()
			return finish("unsupported")
		}
		if phase == "confirm" {
			// History confirmation is an exact native search, never a bounded recent list.
			status := mutationConfirmation(request, *widget.Snapshot)
			_ = json.NewEncoder(connection).Encode(widgetReply{Status: "ok"})
			connection.Close()
			return emit("done", status, nil, status != "unknown")
		}
		if !matchesExpected(request, *widget.Snapshot) {
			_ = json.NewEncoder(connection).Encode(widgetReply{Status: "stale"})
			connection.Close()
			return finish("stale")
		}
		if request.Operation != "apply" && request.Operation != "history-delete" {
			_ = json.NewEncoder(connection).Encode(widgetReply{Status: "ok"})
			connection.Close()
			return emit("done", "ok", widget.Snapshot, false)
		}
		if err := emit("prepared", "", widget.Snapshot, false); err != nil {
			connection.Close()
			return err
		}
		select {
		case approved := <-authorization:
			if !approved {
				connection.Close()
				return finish("stale")
			}
		case <-ctx.Done():
			connection.Close()
			return finish("unavailable")
		}
		applicationDecided = true
		err = json.NewEncoder(connection).Encode(widgetReply{Status: "apply", Replacement: request.Replacement})
		connection.Close()
		if err != nil {
			return finish("unknown")
		}
		phase = "confirm"
	}
}
