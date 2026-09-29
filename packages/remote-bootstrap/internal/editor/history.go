package editor

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const (
	// MaxHistoryEntries and MaxHistoryBytes bound a single in-memory native observation.
	MaxHistoryEntries = 200
	MaxHistoryBytes   = 64 * 1024
)

// History retains exact native records. It never represents a guessed or parsed history file.
type History struct {
	Status    string   `json:"status"`
	Namespace *string  `json:"namespace"`
	Entries   []string `json:"entries"`
}

// validHistory checks every privacy and size boundary without echoing rejected record text.
func validHistory(history History) bool {
	if history.Entries == nil || len(history.Entries) > MaxHistoryEntries {
		return false
	}
	if history.Status == "private" {
		return history.Namespace == nil && len(history.Entries) == 0
	}
	if (history.Status != "ok" && history.Status != "partial") || history.Namespace == nil ||
		len(*history.Namespace) == 0 || len(*history.Namespace) > MaxPathBytes ||
		!utf8.ValidString(*history.Namespace) || strings.ContainsRune(*history.Namespace, 0) {
		return false
	}
	total := 0
	for _, entry := range history.Entries {
		if len(entry) == 0 || strings.HasPrefix(entry, " ") || len(entry) > MaxInputBytes || !utf8.ValidString(entry) || strings.ContainsRune(entry, 0) {
			return false
		}
		total += len(entry)
	}
	encoded, err := json.Marshal(history)
	return total <= MaxHistoryBytes && err == nil && len(encoded) <= MaxMessageBytes-1024
}

// readNativeHistory accepts a NUL-framed native stream with a final builtin exit status.
// Oversized records/results remain visibly partial; privacy results cannot carry any history text.
func readNativeHistory(input io.Reader) (*History, error) {
	raw, err := io.ReadAll(io.LimitReader(input, MaxMessageBytes+1))
	if err != nil {
		return nil, errors.New("history-unavailable")
	}
	truncated := len(raw) > MaxMessageBytes
	if truncated {
		raw = raw[:MaxMessageBytes]
	}
	fields := strings.Split(string(raw), "\x00")
	if len(fields) < 3 {
		return nil, errors.New("invalid-history")
	}
	history := &History{Status: fields[0], Entries: []string{}}
	if history.Status == "private" {
		if truncated || len(fields) != 3 || fields[1] != "" || fields[2] != "" {
			return nil, errors.New("invalid-history")
		}
		return history, nil
	}
	if history.Status != "ok" {
		return nil, errors.New("invalid-history")
	}
	history.Namespace = &fields[1]
	if !validHistory(*history) {
		return nil, errors.New("invalid-history")
	}
	entries := fields[2:]
	if truncated {
		history.Status = "partial"
		entries = entries[:len(entries)-1]
	} else {
		if len(entries) < 2 || entries[len(entries)-1] != "" || entries[len(entries)-2] != "0" {
			return nil, errors.New("history-unavailable")
		}
		entries = entries[:len(entries)-2]
	}
	total := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry, " ") {
			return nil, errors.New("invalid-history")
		}
		if len(entry) == 0 || len(entry) > MaxInputBytes || !utf8.ValidString(entry) ||
			len(history.Entries) >= MaxHistoryEntries || total+len(entry) > MaxHistoryBytes {
			history.Status = "partial"
			continue
		}
		history.Entries = append(history.Entries, entry)
		if !validHistory(*history) {
			history.Entries = history.Entries[:len(history.Entries)-1]
			history.Status = "partial"
			continue
		}
		total += len(entry)
	}
	return history, nil
}
