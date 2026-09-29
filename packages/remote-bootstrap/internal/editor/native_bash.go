package editor

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
)

// The native module uses an intentionally small, versioned binary protocol. Each record has a
// big-endian uint32 byte length, version 1, opcode, and bounded length-prefixed UTF-8 strings.
// This avoids embedding a JSON parser in Bash. The ordinary desktop protocol remains JSON.
const nativeVersion = 1

// nativeRecord decodes one already-bounded frame and records the first boundary error.
type nativeRecord struct {
	*bytes.Reader
	err error
}

// number consumes a network-order unsigned integer without accepting truncated fields.
func (record *nativeRecord) number(destination any) {
	if record.err == nil {
		record.err = binary.Read(record.Reader, binary.BigEndian, destination)
	}
}

// octet consumes a single numeric discriminator.
func (record *nativeRecord) octet() uint8 {
	var value uint8
	record.number(&value)
	return value
}

// word consumes a uint32 metadata field.
func (record *nativeRecord) word() uint32 {
	var value uint32
	record.number(&value)
	return value
}

// text rejects strings exceeding either their field bound or the actual remaining frame.
func (record *nativeRecord) text(limit int) string {
	length := record.word()
	if record.err != nil || uint64(length) > uint64(limit) || uint64(length) > uint64(record.Len()) {
		record.err = errors.New("invalid-native-record")
		return ""
	}
	value := make([]byte, int(length))
	_, record.err = io.ReadFull(record.Reader, value)
	return string(value)
}

// readNativeRecord reads a complete bounded frame; no incomplete record is acted upon.
func readNativeRecord(reader io.Reader, opcode byte) (*nativeRecord, error) {
	var length uint32
	if err := binary.Read(reader, binary.BigEndian, &length); err != nil || length < 2 || length > MaxMessageBytes {
		return nil, errors.New("invalid-native-record")
	}
	raw := make([]byte, int(length))
	if _, err := io.ReadFull(reader, raw); err != nil || raw[0] != nativeVersion || raw[1] != opcode {
		return nil, errors.New("invalid-native-record")
	}
	return &nativeRecord{Reader: bytes.NewReader(raw[2:])}, nil
}

// writeNativeRecord encodes trusted, already-validated request metadata and private strings.
func writeNativeRecord(writer io.Writer, opcode byte, values ...any) error {
	var payload bytes.Buffer
	payload.Write([]byte{nativeVersion, opcode})
	for _, value := range values {
		if text, ok := value.(string); ok {
			if len(text) > MaxMessageBytes {
				return errors.New("invalid-native-record")
			}
			_ = binary.Write(&payload, binary.BigEndian, uint32(len(text)))
			payload.WriteString(text)
		} else if err := binary.Write(&payload, binary.BigEndian, value); err != nil {
			return err
		}
	}
	if payload.Len() > MaxMessageBytes {
		return errors.New("invalid-native-record")
	}
	var frame bytes.Buffer
	_ = binary.Write(&frame, binary.BigEndian, uint32(payload.Len()))
	frame.Write(payload.Bytes())
	_, err := io.Copy(writer, &frame)
	return err
}

// readNativeSnapshot enforces the same privacy and Unicode validation as Shell-script adapters.
func readNativeSnapshot(reader io.Reader, request Request) (*Snapshot, error) {
	record, err := readNativeRecord(reader, 3)
	if err != nil {
		return nil, err
	}
	snapshot := &Snapshot{}
	record.number(&snapshot.PromptGeneration)
	switch record.octet() {
	case 1:
		snapshot.EditorMode = "emacs"
	case 2:
		snapshot.EditorMode = "vi-insert"
	default:
		return nil, errors.New("invalid-native-record")
	}
	flags := record.octet()
	if flags & ^uint8(7) != 0 {
		return nil, errors.New("invalid-native-record")
	}
	if flags&1 != 0 {
		snapshot.Buffer = &Buffer{Text: record.text(MaxInputBytes), Cursor: int(record.word())}
	}
	if flags&2 != 0 {
		snapshot.Directory = &Directory{Logical: record.text(MaxPathBytes)}
		physical, home := record.text(MaxPathBytes), record.text(MaxPathBytes)
		if physical != "" {
			snapshot.Directory.Physical = &physical
		}
		if home != "" {
			snapshot.Directory.Home = &home
		}
	}
	if flags&4 != 0 {
		history := &History{Entries: []string{}}
		switch record.octet() {
		case 1:
			history.Status = "ok"
		case 2:
			history.Status = "partial"
		case 3:
			history.Status = "private"
		default:
			return nil, errors.New("invalid-native-record")
		}
		namespace := record.text(MaxPathBytes)
		if namespace != "" {
			history.Namespace = &namespace
		}
		count := record.word()
		if count > MaxHistoryEntries {
			return nil, errors.New("invalid-native-record")
		}
		for index := uint32(0); index < count; index++ {
			history.Entries = append(history.Entries, record.text(MaxInputBytes))
		}
		snapshot.History = history
	}
	input := request.Operation == "snapshot" || request.Operation == "apply"
	if record.err != nil || record.Len() != 0 || !validSnapshot(*snapshot, input, request.IncludeDirectory, request.Operation == "history") {
		return nil, errors.New("invalid-native-record")
	}
	return snapshot, nil
}

// validateNativeDirectory validates the physical path outside the interactive Shell and bounds slow filesystems.
// PWD remains the Shell's logical spelling: /dev/fd and /proc/self resolve differently in this worker.
func validateNativeDirectory(ctx context.Context, target Target, directory *Directory) bool {
	if directory == nil {
		return true
	}
	if directory.Physical == nil {
		return false
	}
	checked := make(chan bool, 1)
	go func() {
		physical, readErr := os.Readlink(fmt.Sprintf("/proc/%d/cwd", target.PID))
		physicalInfo, physicalErr := os.Stat(*directory.Physical)
		actualInfo, actualErr := os.Stat(fmt.Sprintf("/proc/%d/cwd", target.PID))
		checked <- readErr == nil && physical == *directory.Physical && physicalErr == nil && actualErr == nil &&
			os.SameFile(physicalInfo, actualInfo) && checkTarget(target, false) == nil
	}()
	select {
	case valid := <-checked:
		return valid
	case <-ctx.Done():
		return false
	}
}

// runNativeBash exchanges data with the original Bash process while its idle callback stays
// nonblocking. Desktop authorization never holds Bash inside a socket read or a Shell subprocess.
func runNativeBash(ctx context.Context, connection *net.UnixConn, request Request, authorization <-chan bool,
	emit func(string, string, *Snapshot, bool) error) error {
	defer connection.Close()
	finish := func(status string) error { return emit("done", status, nil, false) }
	hello, err := readNativeRecord(connection, 1)
	if err != nil {
		return finish("unavailable")
	}
	pid := hello.word()
	var generation uint64
	hello.number(&generation)
	instance, start := hello.text(36), hello.text(20)
	if hello.err != nil || hello.Len() != 0 || int(pid) != request.Target.PID || generation != request.PromptGeneration ||
		instance != request.Target.InstanceID || start != request.Target.StartTime {
		return finish("stale")
	}
	operation := uint8(0)
	switch request.Operation {
	case "context":
		operation = 1
	case "snapshot":
		operation = 2
	case "apply":
		operation = 3
	case "history":
		operation = 4
	default:
		return finish("unsupported")
	}
	directory := uint8(0)
	if request.IncludeDirectory {
		directory = 1
	}
	if err := writeNativeRecord(connection, 2, operation, directory, request.RequestID); err != nil {
		return finish("unavailable")
	}
	snapshot, err := readNativeSnapshot(connection, request)
	if err != nil {
		return finish("unavailable")
	}
	if !matchesExpected(request, *snapshot) {
		return finish("stale")
	}
	if !validateNativeDirectory(ctx, request.Target, snapshot.Directory) {
		return finish("unavailable")
	}
	if request.Operation != "apply" {
		return emit("done", "ok", snapshot, false)
	}
	if err := emit("prepared", "", snapshot, false); err != nil {
		return err
	}
	select {
	case approved := <-authorization:
		if !approved {
			return finish("stale")
		}
	case <-ctx.Done():
		return finish("unavailable")
	}
	if err := writeNativeRecord(connection, 4, request.RequestID, request.Replacement.Text, uint32(request.Replacement.Cursor)); err != nil {
		return finish("unknown")
	}
	confirmed, err := readNativeRecord(connection, 5)
	if err != nil {
		return finish("unknown")
	}
	status := confirmed.octet()
	if confirmed.err != nil || confirmed.Len() != 0 {
		return finish("unknown")
	}
	if status == 1 {
		return emit("done", "applied", nil, true)
	}
	if status == 2 {
		return finish("stale")
	}
	return finish("unknown")
}
