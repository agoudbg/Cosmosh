package editor

import (
	"net/url"
	"strings"
	"testing"
)

// completionFrame models the fixed data format after Fish itself has decoded a token.
func completionFrame(token, value, detail string) string {
	return "entry\x00" + url.PathEscape(token) + "\x00" + url.PathEscape(value+"\n") + "\x00" + url.PathEscape(detail) + "\x00"
}

func TestNativeCompletionBoundsAndFraming(t *testing.T) {
	header := "cosmosh-fish-completion-v1\x00"
	suffix := "end\x000\x00"
	raw := header + completionFrame("two\\ words", "two words", "a description") + suffix
	result := parseNativeCompletion([]byte(raw))
	if result.Status != "ok" || len(result.Entries) != 1 || result.Entries[0].Value != "two words" {
		t.Fatalf("literal completion not preserved: %#v", result)
	}
	for _, invalid := range []string{
		strings.TrimSuffix(raw, "\x00"), raw + "extra", strings.Replace(raw, suffix, "end\x001\x00", 1),
		header + "entry\x00%GG\x00value%0A\x00\x00" + suffix, header + suffix + "\x00",
	} {
		if parseNativeCompletion([]byte(invalid)).Status != "unavailable" {
			t.Fatal("invalid frame accepted")
		}
	}
	result = parseNativeCompletion([]byte(header + completionFrame("bad\\n", "bad\n", "") + completionFrame("safe", "safe", "hide\x1b") + "end\x000\x00"))
	if result.Status != "partial" || len(result.Entries) != 1 || result.Entries[0].Detail != nil {
		t.Fatal("control-bearing row/description crossed the boundary")
	}
	var many strings.Builder
	many.WriteString(header)
	for index := 0; index < 129; index++ {
		value := strings.Repeat("x", index+1)
		many.WriteString(completionFrame(value, value, ""))
	}
	many.WriteString(suffix)
	result = parseNativeCompletion([]byte(many.String()))
	if result.Status != "partial" || len(result.Entries) != 128 {
		t.Fatal("candidate count limit not enforced")
	}
}

func TestNativeCompletionEnvironmentIsBoundedAndUnambiguous(t *testing.T) {
	for _, environment := range [][]string{nil, {}, {"A=1", "A=2"}, {"=bad"}, {"NO_EQUALS"}, {"A=\x00"}, {"A=" + strings.Repeat("x", 65536)}} {
		if validCompletionEnvironment(environment) {
			t.Fatal("invalid environment accepted")
		}
	}
	if !validCompletionEnvironment([]string{"PATH=/bin", "VALUE=spaces = newline\n"}) {
		t.Fatal("literal export rejected")
	}
}

func TestNativeCompletionRequiresMatchingInputAndPhysicalDirectory(t *testing.T) {
	physical := "/tmp"
	snapshot := Snapshot{PromptGeneration: 1, EditorMode: "emacs", Buffer: &Buffer{Text: "echo 🐟", Cursor: 6},
		Directory: &Directory{Logical: physical, Physical: &physical}}
	request := Request{RequestID: "01234567-89ab-4def-8123-456789abcdef",
		InputBoundary: testInputBoundary,
		Target:        Target{InstanceID: "abcdef01-2345-6789-abcd-ef0123456789", Shell: "fish", PID: 23, StartTime: "1234"},
		Operation:     "native-completion", PromptGeneration: 1, IncludeDirectory: true, Notification: &Notification{Signal: "URG"}, Expected: &snapshot}
	if !validRequest(request) || !matchesExpected(request, snapshot) {
		t.Fatal("valid native query rejected")
	}
	changed := snapshot
	changed.Buffer = &Buffer{Text: "echo newer", Cursor: 10}
	if matchesExpected(request, changed) {
		t.Fatal("changed input accepted")
	}
	snapshot.Buffer.Cursor = 5
	if validRequest(request) {
		t.Fatal("middle cursor accepted")
	}
	snapshot.Buffer.Cursor = 6
	snapshot.Directory.Physical = nil
	if validRequest(request) {
		t.Fatal("unconfirmed directory accepted")
	}
}
