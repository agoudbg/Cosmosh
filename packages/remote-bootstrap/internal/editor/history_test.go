package editor

import (
	"strings"
	"testing"
)

func TestNativeHistoryPreservesWholeRecordsAndChecksPrivacy(t *testing.T) {
	input := "ok\x00fish\x00echo 中文🐟  \x00begin\n echo second\nend\x000\x00"
	history, err := readNativeHistory(strings.NewReader(input))
	if err != nil || history.Status != "ok" || *history.Namespace != "fish" || len(history.Entries) != 2 ||
		history.Entries[0] != "echo 中文🐟  " || history.Entries[1] != "begin\n echo second\nend" {
		t.Fatal("native record text, order or namespace changed", err)
	}
	for _, input := range []string{"ok\x00fish\x000\x00", "private\x00\x00"} {
		history, err := readNativeHistory(strings.NewReader(input))
		if err != nil || len(history.Entries) != 0 || !validHistory(*history) {
			t.Fatal("empty/private result rejected", err)
		}
	}
	for _, input := range []string{
		"private\x00fish\x00", "private\x00\x00PRIVATE_SENTINEL\x00", "ok\x00\x000\x00",
		"ok\x00fish\x00PRIVATE_SENTINEL\x001\x00", "ok\x00fish\x00PRIVATE_SENTINEL\x00",
		"ok\x00fish\x00PRIVATE_SENTINEL", "ok\x00" + string([]byte{0xff}) + "\x000\x00",
		"ok\x00fish\x00 PRIVATE_SENTINEL\x000\x00",
	} {
		if _, err := readNativeHistory(strings.NewReader(input)); err == nil || strings.Contains(err.Error(), "PRIVATE_SENTINEL") {
			t.Fatal("accepted an invalid/privacy-violating result or exposed private text")
		}
	}
}

func TestNativeHistoryBoundsArePartialWithoutTruncatingARecord(t *testing.T) {
	for _, input := range []string{
		"ok\x00fish\x00" + strings.Repeat("x", MaxInputBytes+1) + "\x00kept\x000\x00",
		"ok\x00fish\x00" + strings.Repeat("record\x00", MaxHistoryEntries+1) + "0\x00",
		"ok\x00fish\x00" + strings.Repeat(strings.Repeat("x", MaxInputBytes)+"\x00", 9) + "0\x00",
		"ok\x00fish\x00kept\x00" + strings.Repeat("x", MaxMessageBytes),
		"ok\x00fish\x00" + strings.Repeat(strings.Repeat("\x01", MaxInputBytes)+"\x00", 8) + "0\x00",
	} {
		history, err := readNativeHistory(strings.NewReader(input))
		if err != nil || history.Status != "partial" || !validHistory(*history) || len(history.Entries) == 0 {
			t.Fatal("bounded native history lost its partial state", err)
		}
		for _, entry := range history.Entries {
			if len(entry) > MaxInputBytes {
				t.Fatal("oversized record escaped the boundary")
			}
		}
	}
}

func TestNativeHistoryCannotBorrowInputOrDirectoryPermission(t *testing.T) {
	namespace := "fish"
	snapshot := Snapshot{PromptGeneration: 1, EditorMode: "emacs", History: &History{Status: "ok", Namespace: &namespace, Entries: []string{"echo allowed"}}}
	if !validSnapshot(snapshot, false, false, true) || validSnapshot(snapshot, false, false, false) {
		t.Fatal("history permission was not checked independently")
	}
	snapshot.Buffer = &Buffer{Text: "PRIVATE_SENTINEL"}
	if validSnapshot(snapshot, false, false, true) {
		t.Fatal("history query accepted current input")
	}
	snapshot.Buffer = nil
	snapshot.Directory = &Directory{Logical: "/private"}
	if validSnapshot(snapshot, false, false, true) {
		t.Fatal("history query accepted a directory")
	}
	request := Request{RequestID: "01234567-89ab-4def-8123-456789abcdef", Target: Target{InstanceID: "abcdef01-2345-6789-abcd-ef0123456789", Shell: "fish", PID: 23, StartTime: "1234"}, Operation: "history", PromptGeneration: 1, Notification: &Notification{Signal: "URG"}}
	if !validRequest(request) {
		t.Fatal("native history request rejected")
	}
	request.IncludeDirectory = true
	if validRequest(request) {
		t.Fatal("native history request borrowed directory permission")
	}
}
