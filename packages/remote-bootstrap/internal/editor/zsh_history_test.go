package editor

import (
	"strings"
	"testing"
)

func TestZshNativeHistoryUsesIndependentReadAndDeletionBoundaries(t *testing.T) {
	request := Request{
		RequestID: "01234567-89ab-4def-8123-456789abcdef", InputBoundary: testInputBoundary,
		Target:    Target{InstanceID: "abcdef01-2345-4789-abcd-ef0123456789", Shell: "zsh", PID: 23, StartTime: "1234"},
		Operation: "history", PromptGeneration: 1, Notification: &Notification{FD: 12, Inode: "123"},
	}
	if !validRequest(request) {
		t.Fatal("qualified Zsh history reader rejected")
	}
	request.IncludeDirectory = true
	if validRequest(request) {
		t.Fatal("Zsh history borrowed directory permission")
	}
	request.IncludeDirectory = false
	namespace := "abcdef01-2345-4789-abcd-ef0123456789:123456"
	request.Operation = "history-delete"
	request.Expected = &Snapshot{PromptGeneration: 1, EditorMode: "emacs", History: &History{
		Status: "ok", Namespace: &namespace, Entries: []string{"print 'whole\nrecord'\n"},
	}}
	if !validRequest(request) {
		t.Fatal("exact native Zsh history deletion rejected")
	}
	confirmation := Snapshot{PromptGeneration: 1, EditorMode: "emacs", History: &History{
		Status: "ok", Namespace: &namespace, Entries: []string{},
	}}
	if mutationConfirmation(request, confirmation) != "history-removed-from-reader" {
		t.Fatal("native removal lost its reader-only result scope")
	}
	request.Expected.Buffer = &Buffer{Text: "UNSUBMITTED_INPUT", Cursor: 0}
	if validRequest(request) {
		t.Fatal("Zsh deletion borrowed current editor input")
	}
	request.Expected.Buffer = nil
	request.Expected.History.Entries = append(request.Expected.History.Entries, "another")
	if validRequest(request) {
		t.Fatal("Zsh deletion accepted multiple selected records")
	}
}

func TestNativeHistoryPreservesExplicitPartialSourceStatus(t *testing.T) {
	for _, text := range []string{"", "print '中文🐟\nwhole record'\n\x00"} {
		history, err := readNativeHistory(strings.NewReader("partial\x00native-namespace\x00" + text + "0\x00"))
		if err != nil || history.Status != "partial" || !validHistory(*history) {
			t.Fatal("bounded native source lost explicit partial status", err)
		}
		if text != "" && (len(history.Entries) != 1 || history.Entries[0] != strings.TrimSuffix(text, "\x00")) {
			t.Fatal("partial source changed exact multiline record data")
		}
	}
	for _, text := range []string{"partial\x00native-namespace\x00record\x001\x00", "partial\x00native-namespace\x00 PRIVATE\x000\x00"} {
		if _, err := readNativeHistory(strings.NewReader(text)); err == nil {
			t.Fatal("partial status bypassed source failure or privacy validation")
		}
	}
}
