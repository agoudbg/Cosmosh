// Package editor provides bounded, request-scoped communication with the original Shell editor.
// User input is transferred only through stdin and private sockets, never command arguments or logs.
package editor

import (
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	// MaxInputBytes limits each complete editor buffer before JSON encoding.
	MaxInputBytes = 8 * 1024
	// MaxMessageBytes includes JSON expansion of two buffers and directory metadata.
	MaxMessageBytes = 256 * 1024
	// MaxPathBytes bounds one Linux directory field without trimming filename characters.
	MaxPathBytes = 4096
)

var (
	uuidPattern  = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	ticksPattern = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
)

// Target identifies the original interactive Shell independently of PID reuse.
type Target struct {
	InstanceID string `json:"instanceId"`
	Shell      string `json:"shell"`
	PID        int    `json:"pid"`
	StartTime  string `json:"startTime"`
}

// Notification identifies a private pipe or a fixed, normally ignored Fish signal.
// It carries no input; the editor independently decides whether a request can read or edit.
type Notification struct {
	FD     int    `json:"fd,omitempty"`
	Inode  string `json:"inode,omitempty"`
	Signal string `json:"signal,omitempty"`
}

// Buffer contains a complete line and a Unicode codepoint cursor offset shared by all adapters.
type Buffer struct {
	Text   string `json:"text"`
	Cursor int    `json:"cursor"`
}

// Directory retains logical display identity, physical file-operation identity and literal HOME.
type Directory struct {
	Logical  string  `json:"logical"`
	Physical *string `json:"physical"`
	Home     *string `json:"home"`
}

// Snapshot is an editor-owned observation. Context-only requests contain no input Buffer.
type Snapshot struct {
	PromptGeneration uint64     `json:"promptGeneration"`
	EditorMode       string     `json:"editorMode"`
	Buffer           *Buffer    `json:"buffer,omitempty"`
	Directory        *Directory `json:"directory,omitempty"`
	History          *History   `json:"history,omitempty"`
}

// Request is the private SSH-exec stdin protocol. Apply always includes the exact expected observation.
type Request struct {
	RequestID        string        `json:"requestId"`
	Target           Target        `json:"target"`
	Operation        string        `json:"operation"`
	PromptGeneration uint64        `json:"promptGeneration"`
	IncludeDirectory bool          `json:"includeDirectory"`
	Notification     *Notification `json:"notification,omitempty"`
	Expected         *Snapshot     `json:"expected,omitempty"`
	Replacement      *Buffer       `json:"replacement,omitempty"`
}

// Message is one framed helper response. Failure codes never include request text or raw errors.
type Message struct {
	Type      string    `json:"type"`
	Phase     string    `json:"phase"`
	RequestID string    `json:"requestId"`
	Status    string    `json:"status,omitempty"`
	Snapshot  *Snapshot `json:"snapshot,omitempty"`
	Applied   bool      `json:"applied,omitempty"`
}

// ReadRequest decodes exactly one bounded JSON request and rejects unknown fields.
// It returns stable errors that are safe to report without leaking input text.
func ReadRequest(reader io.Reader) (Request, error) {
	var request Request
	raw, err := io.ReadAll(io.LimitReader(reader, MaxMessageBytes+1))
	if err != nil || len(raw) > MaxMessageBytes || !utf8.Valid(raw) {
		return request, errors.New("invalid-request")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return Request{}, errors.New("invalid-request")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return Request{}, errors.New("invalid-request")
	}
	if !validRequest(request) {
		return Request{}, errors.New("invalid-request")
	}
	return request, nil
}

// validTarget rejects incomplete identities before any process or socket access.
func validTarget(target Target) bool {
	return uuidPattern.MatchString(target.InstanceID) &&
		(target.Shell == "bash" || target.Shell == "zsh" || target.Shell == "fish") &&
		target.PID > 1 && ticksPattern.MatchString(target.StartTime)
}

// validRequest confines each operation to its explicitly requested data.
func validRequest(request Request) bool {
	if !uuidPattern.MatchString(request.RequestID) || !validTarget(request.Target) ||
		request.PromptGeneration == 0 || request.PromptGeneration > 9007199254740991 {
		return false
	}
	if !validNotification(request.Target.Shell, request.Notification) {
		return false
	}
	switch request.Operation {
	case "history-delete":
		return request.Target.Shell == "fish" && !request.IncludeDirectory && request.Replacement == nil &&
			request.Expected != nil && validSnapshot(*request.Expected, false, false, true) &&
			request.Expected.PromptGeneration == request.PromptGeneration &&
			request.Expected.History.Status == "ok" && len(request.Expected.History.Entries) == 1
	case "history":
		return request.Target.Shell == "fish" && !request.IncludeDirectory && request.Expected == nil && request.Replacement == nil
	case "context":
		return request.Expected == nil && request.Replacement == nil
	case "snapshot":
		return request.Expected == nil && request.Replacement == nil
	case "apply":
		return request.Expected != nil && request.Expected.Buffer != nil &&
			request.Replacement != nil && validBuffer(*request.Replacement) &&
			validSnapshot(*request.Expected, true, request.IncludeDirectory, false) &&
			request.Expected.PromptGeneration == request.PromptGeneration
	default:
		return false
	}
}

// validNotification prevents either out-of-band adapter from falling back to terminal key injection.
func validNotification(shell string, notification *Notification) bool {
	switch shell {
	case "zsh":
		return notification != nil && notification.Signal == "" &&
			notification.FD >= 3 && notification.FD <= 1048575 && ticksPattern.MatchString(notification.Inode)
	case "fish":
		return notification != nil && notification.Signal == "URG" &&
			notification.FD == 0 && notification.Inode == ""
	default:
		return notification == nil
	}
}

// validBuffer rejects multiline/control input and cursor offsets outside the codepoint range.
// Tab is safe because the Shell assigns the complete buffer as data, not as terminal keystrokes.
func validBuffer(buffer Buffer) bool {
	if len(buffer.Text) > MaxInputBytes || !utf8.ValidString(buffer.Text) || buffer.Cursor < 0 {
		return false
	}
	offset := 0
	for _, character := range buffer.Text {
		if (character < 0x20 && character != '\t') || character == 0x7f || (character >= 0x80 && character <= 0x9f) {
			return false
		}
		offset += 1
	}
	return buffer.Cursor <= offset
}

// validPath accepts exact absolute UTF-8 paths, including filename whitespace and newlines.
func validPath(value string) bool {
	return len(value) > 0 && len(value) <= MaxPathBytes &&
		strings.HasPrefix(value, "/") && !strings.ContainsRune(value, 0) && utf8.ValidString(value)
}

// validSnapshot validates the editor observation and its requested privacy boundary.
func validSnapshot(snapshot Snapshot, includeInput, includeDirectory, includeHistory bool) bool {
	if includeHistory != (snapshot.History != nil) || (snapshot.History != nil && !validHistory(*snapshot.History)) {
		return false
	}
	if snapshot.PromptGeneration == 0 || snapshot.PromptGeneration > 9007199254740991 ||
		(snapshot.EditorMode != "emacs" && snapshot.EditorMode != "vi-insert") {
		return false
	}
	if includeInput != (snapshot.Buffer != nil) || (snapshot.Buffer != nil && !validBuffer(*snapshot.Buffer)) {
		return false
	}
	if includeDirectory != (snapshot.Directory != nil) {
		return false
	}
	if directory := snapshot.Directory; directory != nil {
		return validPath(directory.Logical) &&
			(directory.Physical == nil || validPath(*directory.Physical)) &&
			(directory.Home == nil || validPath(*directory.Home))
	}
	return true
}

// matchesExpected requires the complete original line, cursor, prompt and requested directory identity.
func matchesExpected(request Request, captured Snapshot) bool {
	return captured.PromptGeneration == request.PromptGeneration &&
		((request.Operation != "apply" && request.Operation != "history-delete") || reflect.DeepEqual(request.Expected, &captured))
}

// mutationConfirmation keeps native history visibility distinct from an applied input buffer.
// No Fish observation can confirm that its history file was durably updated.
func mutationConfirmation(request Request, captured Snapshot) string {
	if captured.PromptGeneration != request.PromptGeneration {
		return "unknown"
	}
	if request.Operation == "apply" && captured.Buffer != nil && request.Replacement != nil &&
		captured.History == nil && *captured.Buffer == *request.Replacement {
		return "applied"
	}
	if request.Operation == "history-delete" && captured.Buffer == nil && captured.History != nil &&
		request.Expected != nil && request.Expected.History != nil {
		history, expected := captured.History, request.Expected.History
		if history.Status == "ok" && len(history.Entries) == 0 && history.Namespace != nil &&
			expected.Namespace != nil && *history.Namespace == *expected.Namespace {
			return "history-removed-from-reader"
		}
	}
	return "unknown"
}
