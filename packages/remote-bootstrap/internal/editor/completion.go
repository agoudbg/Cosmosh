package editor

import (
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"
)

const (
	maxCompletionEnvironmentBytes = 64 * 1024
	maxCompletionOutputBytes      = 256 * 1024
	maxCompletionEntries          = 128
)

// NativeCompletionEntry retains the Fish token for syntax validation as well as its native decoded value.
type NativeCompletionEntry struct {
	Token  string  `json:"token"`
	Value  string  `json:"value"`
	Detail *string `json:"detail"`
}

// NativeCompletionResult is private, bounded advisory data. It never contains the query environment.
type NativeCompletionResult struct {
	Status  string                  `json:"status"`
	Entries []NativeCompletionEntry `json:"entries"`
}

// completionFailure keeps failures observable without reflecting configuration, input or process errors.
func completionFailure(status string) NativeCompletionResult {
	return NativeCompletionResult{Status: status, Entries: []NativeCompletionEntry{}}
}

// validCompletionEnvironment bounds the explicit remote-only exported environment permission.
func validCompletionEnvironment(environment []string) bool {
	if len(environment) == 0 || len(environment) > 1024 {
		return false
	}
	total := 0
	names := make(map[string]bool)
	for _, entry := range environment {
		name, _, found := strings.Cut(entry, "=")
		total += len(entry) + 1
		if !found || name == "" || strings.ContainsRune(entry, 0) || !utf8.ValidString(entry) ||
			total > maxCompletionEnvironmentBytes || names[name] {
			return false
		}
		names[name] = true
	}
	return true
}

// completionText excludes terminal controls; native newline filenames remain available through native Tab.
func completionText(value string, maximum int) bool {
	if len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, point := range value {
		if point < 32 || (point >= 127 && point <= 159) {
			return false
		}
	}
	return true
}

// decodeCompletionField uses standard percent decoding of Fish string escape --style=url output.
func decodeCompletionField(value string) (string, error) {
	decoded, err := url.PathUnescape(value)
	if err != nil || !utf8.ValidString(decoded) {
		return "", errors.New("invalid-completion")
	}
	return decoded, nil
}

// parseNativeCompletion reads the fixed NUL frame emitted by our script, not an invented Shell parser.
// Fish's underlying LF/TAB completion format cannot distinguish multiline descriptions from extra rows.
func parseNativeCompletion(raw []byte) NativeCompletionResult {
	failure := completionFailure("unavailable")
	if len(raw) > maxCompletionOutputBytes || !utf8.Valid(raw) {
		return failure
	}
	fields := strings.Split(string(raw), "\x00")
	if len(fields) < 4 || fields[0] != "cosmosh-fish-completion-v1" || fields[len(fields)-1] != "" {
		return failure
	}
	result := completionFailure("ok")
	seen := make(map[string]bool)
	total := 0
	index := 1
	for index < len(fields)-1 {
		switch fields[index] {
		case "end":
			if index != len(fields)-3 || fields[index+1] != "0" {
				return failure
			}
			return result
		case "entry":
			if index+4 >= len(fields) {
				return failure
			}
			token, tokenErr := decodeCompletionField(fields[index+1])
			decoded, valueErr := decodeCompletionField(fields[index+2])
			detail, detailErr := decodeCompletionField(fields[index+3])
			index += 4
			// Native unescape prints exactly one newline. Strip only that framing byte.
			if tokenErr != nil || valueErr != nil || detailErr != nil || !strings.HasSuffix(decoded, "\n") {
				return failure
			}
			value := strings.TrimSuffix(decoded, "\n")
			if token == "" || value == "" || !completionText(token, MaxInputBytes) || !completionText(value, MaxInputBytes) {
				result.Status = "partial"
				continue
			}
			var description *string
			if detail != "" && completionText(detail, 1024) {
				description = &detail
			}
			key := token + "\x00" + value
			if seen[key] {
				continue
			}
			if len(result.Entries) == maxCompletionEntries || total+len(token)+len(value)+len(detail) > 64*1024 {
				result.Status = "partial"
				continue
			}
			seen[key] = true
			total += len(token) + len(value) + len(detail)
			result.Entries = append(result.Entries, NativeCompletionEntry{Token: token, Value: value, Detail: description})
		default:
			return failure
		}
	}
	return failure
}
