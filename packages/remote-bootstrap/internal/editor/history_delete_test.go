package editor

import "testing"

func TestHistoryRemovalCannotConfirmInputEditsOrFilePersistence(t *testing.T) {
	namespace, other := "fish", "other"
	history := &History{Status: "ok", Namespace: &namespace, Entries: []string{"record"}}
	request := Request{Operation: "history-delete", PromptGeneration: 1,
		Expected: &Snapshot{PromptGeneration: 1, EditorMode: "emacs", History: history}}
	confirmation := Snapshot{PromptGeneration: 1, EditorMode: "emacs",
		History: &History{Status: "ok", Namespace: &namespace, Entries: []string{}}}
	if mutationConfirmation(request, confirmation) != "history-removed-from-reader" {
		t.Fatal("current-reader removal did not receive its scoped result")
	}
	for _, changed := range []History{
		{Status: "ok", Namespace: &namespace, Entries: []string{"record"}},
		{Status: "ok", Namespace: &other, Entries: []string{}},
		{Status: "partial", Namespace: &namespace, Entries: []string{}},
		{Status: "private", Entries: []string{}},
	} {
		captured := confirmation
		captured.History = &changed
		if mutationConfirmation(request, captured) != "unknown" {
			t.Fatal("incomplete, changed or private confirmation reported removal")
		}
	}
	buffer := Buffer{Text: "echo unchanged", Cursor: 14}
	edit := Request{Operation: "apply", PromptGeneration: 1, Replacement: &buffer}
	input := Snapshot{PromptGeneration: 1, EditorMode: "emacs", Buffer: &buffer}
	if mutationConfirmation(edit, input) != "applied" ||
		mutationConfirmation(edit, confirmation) != "unknown" ||
		mutationConfirmation(request, input) != "unknown" {
		t.Fatal("history and input confirmations were confused")
	}
}

func TestHistoryDeletionRequiresOneExactNativeRecordInTheOriginalScope(t *testing.T) {
	namespace := "fish"
	history := History{Status: "ok", Namespace: &namespace, Entries: []string{"echo 中文🐟  \n"}}
	snapshot := Snapshot{PromptGeneration: 1, EditorMode: "emacs", History: &history}
	request := Request{
		RequestID:     "01234567-89ab-4def-8123-456789abcdef",
		InputBoundary: testInputBoundary,
		Target:        Target{InstanceID: "abcdef01-2345-6789-abcd-ef0123456789", Shell: "fish", PID: 23, StartTime: "1234"},
		Operation:     "history-delete", PromptGeneration: 1, Notification: &Notification{Signal: "URG"}, Expected: &snapshot,
	}
	if !validRequest(request) || !matchesExpected(request, snapshot) {
		t.Fatal("exact native deletion target was rejected")
	}
	for _, changed := range []History{
		{Status: "ok", Namespace: &namespace, Entries: []string{}},
		{Status: "ok", Namespace: &namespace, Entries: []string{"echo 中文🐟"}},
		{Status: "partial", Namespace: &namespace, Entries: history.Entries},
		{Status: "private", Entries: []string{}},
	} {
		captured := snapshot
		captured.History = &changed
		if matchesExpected(request, captured) {
			t.Fatal("missing, changed or private record authorized deletion")
		}
	}
	for _, mutate := range []func(*Request){
		func(r *Request) { r.Expected = nil },
		func(r *Request) { r.Expected.Buffer = &Buffer{Text: "PRIVATE_INPUT"} },
		func(r *Request) { r.Expected.Directory = &Directory{Logical: "/private"} },
		func(r *Request) { r.IncludeDirectory = true },
		func(r *Request) { r.Replacement = &Buffer{Text: "unexpected"} },
		func(r *Request) { r.Expected.PromptGeneration++ },
		func(r *Request) { r.Expected.History.Entries = []string{} },
		func(r *Request) { r.Expected.History.Entries = []string{"one", "two"} },
		func(r *Request) { r.Expected.History.Status = "partial" },
		func(r *Request) { r.Target.Shell = "bash"; r.Notification = nil },
	} {
		changed := request
		copiedSnapshot, copiedHistory := snapshot, history
		copiedSnapshot.History = &copiedHistory
		changed.Expected = &copiedSnapshot
		mutate(&changed)
		if validRequest(changed) {
			t.Fatal("deletion escaped its exact target or permission boundary")
		}
	}
}
