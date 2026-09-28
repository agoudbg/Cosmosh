package editor

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func TestDeadlineIncludesIncompleteInitialStdin(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	go func() { _, _ = writer.Write([]byte("{\"requestId\":")) }()
	started := time.Now()
	if err := RunRequest(context.Background(), reader, io.Discard); err == nil || err.Error() != "request-timeout" {
		t.Fatal("incomplete live stdin must time out with a fixed error")
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("initial stdin escaped the worker lifetime bound")
	}
}

func TestCursorConversionPreservesUnicodeBoundaries(t *testing.T) {
	text := "echo 中文🐟 e\u0301"
	for _, pair := range [][2]int{{0, 0}, {5, 5}, {7, 7}, {8, 9}, {11, 12}} {
		if got, ok := CodePointToUTF16(text, pair[0]); !ok || got != pair[1] {
			t.Fatalf("codepoint %d produced %d, %v", pair[0], got, ok)
		}
		if got, ok := UTF16ToCodePoint(text, pair[1]); !ok || got != pair[0] {
			t.Fatalf("UTF-16 %d produced %d, %v", pair[1], got, ok)
		}
	}
	for _, cursor := range []int{-1, 8, 13} {
		if _, ok := UTF16ToCodePoint(text, cursor); ok {
			t.Fatalf("accepted invalid UTF-16 boundary %d", cursor)
		}
	}
	if _, ok := CodePointToUTF16(text, 12); ok {
		t.Fatal("accepted a position beyond the real line")
	}
}

func TestRequestBoundaryDoesNotExposeRejectedInput(t *testing.T) {
	request := Request{
		RequestID: "01234567-89ab-4def-8123-456789abcdef",
		Target:    Target{InstanceID: "abcdef01-2345-6789-abcd-ef0123456789", Shell: "bash", PID: 23, StartTime: "1234"},
		Operation: "snapshot", PromptGeneration: 1,
	}
	encoded, _ := json.Marshal(request)
	if _, err := ReadRequest(strings.NewReader(string(encoded))); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		string(encoded) + "{}",
		strings.Replace(string(encoded), `"operation":"snapshot"`, `"operation":"PRIVATE_SENTINEL"`, 1),
		strings.TrimSuffix(string(encoded), "}") + `,"secret":"PRIVATE_SENTINEL"}`,
		strings.Repeat("PRIVATE_SENTINEL", MaxMessageBytes),
	} {
		if _, err := ReadRequest(strings.NewReader(raw)); err == nil || strings.Contains(err.Error(), "PRIVATE_SENTINEL") {
			t.Fatal("invalid input was accepted or exposed")
		}
	}
}

func TestBufferLimitsAndExactApplyComparison(t *testing.T) {
	for _, buffer := range []Buffer{
		{Text: "line\nnext"}, {Text: "line\rnext"}, {Text: "line\x00next"}, {Text: "\x1b"},
		{Text: strings.Repeat("a", MaxInputBytes+1)}, {Text: "🐟", Cursor: 1},
		{Text: "ok", Cursor: 3}, {Text: string([]byte{0xff})},
	} {
		if validBuffer(buffer) {
			t.Fatal("accepted an unsupported editor buffer")
		}
	}
	for _, buffer := range []Buffer{{}, {Text: "\t中🐟", Cursor: 4}, {Text: strings.Repeat("a", MaxInputBytes)}} {
		if !validBuffer(buffer) {
			t.Fatal("rejected supported editor input")
		}
	}
	snapshot := Snapshot{PromptGeneration: 4, EditorMode: "emacs", Buffer: &Buffer{Text: "git status", Cursor: 3}}
	request := Request{Operation: "apply", PromptGeneration: 4, Expected: &snapshot}
	if !matchesExpected(request, snapshot) {
		t.Fatal("identical editor observation did not match")
	}
	changed := snapshot
	changed.Buffer = &Buffer{Text: "git status", Cursor: 4}
	if matchesExpected(request, changed) {
		t.Fatal("cursor movement must invalidate application")
	}
	changed.Buffer = &Buffer{Text: "git stale!", Cursor: 3}
	if matchesExpected(request, changed) {
		t.Fatal("same-length buffer change must invalidate application")
	}
	changed = snapshot
	changed.PromptGeneration++
	if matchesExpected(request, changed) {
		t.Fatal("a newer prompt must invalidate application")
	}
}

func TestContextOnlySnapshotsCannotContainInput(t *testing.T) {
	directory := &Directory{Logical: "/space \n", Home: nil, Physical: nil}
	context := Snapshot{PromptGeneration: 1, EditorMode: "emacs", Directory: directory}
	if !validSnapshot(context, false, true) {
		t.Fatal("exact directory metadata was rejected")
	}
	context.Buffer = &Buffer{Text: "PRIVATE_SENTINEL"}
	if validSnapshot(context, false, true) {
		t.Fatal("context-only operation accepted input")
	}
}
