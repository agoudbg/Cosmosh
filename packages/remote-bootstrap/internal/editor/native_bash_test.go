package editor

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// nativeSnapshotFrame builds actual versioned wire bytes, independent of the snapshot decoder.
func nativeSnapshotFrame(t *testing.T, flags uint8, fields ...any) []byte {
	t.Helper()
	var frame bytes.Buffer
	values := []any{uint64(7), uint8(1), flags}
	values = append(values, fields...)
	if err := writeNativeRecord(&frame, 3, values...); err != nil {
		t.Fatal(err)
	}
	return frame.Bytes()
}

func TestNativeSnapshotsEnforcePermissionAndUnicodeBoundaries(t *testing.T) {
	request := Request{Operation: "snapshot", PromptGeneration: 7}
	valid := nativeSnapshotFrame(t, 1, "echo 中🐟", uint32(7))
	snapshot, err := readNativeSnapshot(bytes.NewReader(valid), request)
	if err != nil || snapshot.Buffer.Text != "echo 中🐟" || snapshot.Buffer.Cursor != 7 {
		t.Fatalf("valid native Unicode rejected: %v", err)
	}
	for _, invalid := range [][]byte{
		valid[:len(valid)-1],
		nativeSnapshotFrame(t, 1, "echo 中🐟", uint32(8)),
		nativeSnapshotFrame(t, 1, "echo \x00secret", uint32(0)),
		nativeSnapshotFrame(t, 1, strings.Repeat("x", MaxInputBytes+1), uint32(0)),
		nativeSnapshotFrame(t, 9, "echo ok", uint32(0)),
		nativeSnapshotFrame(t, 1, "echo ok", uint32(0), uint8(0)),
	} {
		if _, err := readNativeSnapshot(bytes.NewReader(invalid), request); err == nil {
			t.Fatal("invalid native record accepted")
		}
	}
	request.Operation = "context"
	if _, err := readNativeSnapshot(bytes.NewReader(valid), request); err == nil {
		t.Fatal("context permission accepted input")
	}
	if _, err := readNativeSnapshot(bytes.NewReader(nativeSnapshotFrame(t, 0)), request); err != nil {
		t.Fatal(err)
	}
}

func TestNativeHistoryRemainsExplicitAndBounded(t *testing.T) {
	request := Request{Operation: "history", PromptGeneration: 7}
	for _, fields := range [][]any{
		{uint8(1), "reader-identity", uint32(2), "echo new", "echo old"},
		{uint8(3), "", uint32(0)},
	} {
		if _, err := readNativeSnapshot(bytes.NewReader(nativeSnapshotFrame(t, 4, fields...)), request); err != nil {
			t.Fatal(err)
		}
	}
	for _, fields := range [][]any{
		{uint8(3), "", uint32(1), "echo private"},
		{uint8(1), "reader", uint32(MaxHistoryEntries + 1)},
		{uint8(1), "reader", uint32(1), " ignored"},
	} {
		if _, err := readNativeSnapshot(bytes.NewReader(nativeSnapshotFrame(t, 4, fields...)), request); err == nil {
			t.Fatal("invalid native history accepted")
		}
	}
}

func TestNativeFramingRejectsAllocationAndVersionConfusion(t *testing.T) {
	for _, length := range []uint32{0, 1, MaxMessageBytes + 1, ^uint32(0)} {
		var frame bytes.Buffer
		_ = binary.Write(&frame, binary.BigEndian, length)
		if _, err := readNativeRecord(&frame, 1); err == nil {
			t.Fatal("invalid frame length accepted")
		}
	}
	for _, header := range [][]byte{{2, 1}, {1, 2}} {
		frame := append([]byte{0, 0, 0, 2}, header...)
		if _, err := readNativeRecord(bytes.NewReader(frame), 1); err == nil {
			t.Fatal("unexpected version or opcode accepted")
		}
	}
	if validNotification("bash", nil) || validNotification("bash", &Notification{Callback: "readline", Signal: "URG"}) ||
		validNotification("fish", &Notification{Callback: "readline"}) || !validNotification("bash", &Notification{Callback: "readline"}) {
		t.Fatal("native Bash callback notification is not exclusive")
	}
}
