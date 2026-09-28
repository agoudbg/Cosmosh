// Package paths performs bounded, data-only directory queries for terminal completion.
package paths

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	maxRequestBytes  = 32 * 1024
	maxScanEntries   = 10_000
	maxResultEntries = 128
)

// Request contains literal filesystem data; no field is interpreted as Shell syntax.
type Request struct {
	Directory       string `json:"directory"`
	Fragment        string `json:"fragment"`
	DirectoriesOnly bool   `json:"directoriesOnly"`
	FuzzyMatch      bool   `json:"fuzzyMatch"`
	Limit           int    `json:"limit"`
}

// Entry preserves a complete filename, including whitespace, without line-based framing.
type Entry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// Result uses stable status codes so filesystem errors cannot disclose unrelated path text.
type Result struct {
	Status  string  `json:"status"`
	Entries []Entry `json:"entries"`
	Scanned int     `json:"scanned"`
}

// Run reads one bounded JSON document and writes one result within a fixed lifetime.
// Blocking filesystem calls run in the request process; its main returns at the deadline.
func Run(ctx context.Context, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	complete := make(chan Result, 1)
	go func() {
		request, err := readRequest(input)
		if err != nil {
			complete <- Result{Status: "invalid", Entries: []Entry{}}
			return
		}
		complete <- Query(ctx, request)
	}()
	var result Result
	select {
	case result = <-complete:
	case <-ctx.Done():
		result = Result{Status: "timeout", Entries: []Entry{}}
		if errors.Is(ctx.Err(), context.Canceled) {
			result.Status = "cancelled"
		}
	}
	return json.NewEncoder(output).Encode(result)
}

// readRequest validates the exact JSON boundary without putting request contents in errors.
func readRequest(input io.Reader) (Request, error) {
	var request Request
	raw, err := io.ReadAll(io.LimitReader(input, maxRequestBytes+1))
	if err != nil || len(raw) > maxRequestBytes || !utf8.Valid(raw) {
		return request, errors.New("invalid path request")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || !validRequest(request) {
		return Request{}, errors.New("invalid path request")
	}
	return request, nil
}

// validRequest bounds paths and matching work, preserving the operating system's symlink semantics.
func validRequest(request Request) bool {
	return strings.HasPrefix(request.Directory, "/") && len(request.Directory) <= 4096 &&
		!strings.ContainsRune(request.Directory, 0) && utf8.ValidString(request.Directory) &&
		len(request.Fragment) <= 4096 && !strings.ContainsAny(request.Fragment, "/\x00") && utf8.ValidString(request.Fragment) &&
		request.Limit > 0 && request.Limit <= maxResultEntries
}

// Query scans at most 10,000 entries, matches before limiting, and never evaluates a filename.
// The caller's context interrupts between reads; Run bounds a blocked kernel filesystem operation.
func Query(ctx context.Context, request Request) Result {
	result := Result{Status: "ok", Entries: []Entry{}}
	if !validRequest(request) {
		result.Status = "invalid"
		return result
	}
	directory, err := os.Open(request.Directory)
	if err != nil {
		result.Status = errorStatus(err)
		return result
	}
	defer directory.Close()
	// Do not filepath.Clean/Join the supplied directory: link/.. must be resolved by the remote kernel.
	for {
		if ctx.Err() != nil {
			result.Status = "cancelled"
			result.Entries = []Entry{}
			return result
		}
		batch, readErr := directory.ReadDir(256)
		for _, entry := range batch {
			if result.Scanned == maxScanEntries {
				result.Status = "partial"
				break
			}
			result.Scanned++
			name := entry.Name()
			if !utf8.ValidString(name) || len(name) > 1024 || matchScore(request.Fragment, name, request.FuzzyMatch) == 0 {
				continue
			}
			isDirectory := entry.IsDir()
			if entry.Type()&os.ModeSymlink != 0 {
				info, statErr := os.Stat(request.Directory + "/" + name)
				isDirectory = statErr == nil && info.IsDir()
			}
			if request.DirectoriesOnly && !isDirectory {
				continue
			}
			kind := "file"
			if isDirectory {
				kind = "directory"
			}
			result.Entries = append(result.Entries, Entry{Name: name, Kind: kind})
		}
		if result.Status == "partial" || errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			result.Status = errorStatus(readErr)
			result.Entries = []Entry{}
			return result
		}
	}
	sort.Slice(result.Entries, func(left, right int) bool {
		a, b := result.Entries[left], result.Entries[right]
		aScore, bScore := matchScore(request.Fragment, a.Name, request.FuzzyMatch), matchScore(request.Fragment, b.Name, request.FuzzyMatch)
		if aScore != bScore {
			return aScore > bScore
		}
		if a.Kind != b.Kind {
			return a.Kind == "directory"
		}
		return a.Name < b.Name
	})
	if len(result.Entries) > request.Limit {
		result.Entries = result.Entries[:request.Limit]
	}
	return result
}

// matchScore ranks literal case-insensitive prefixes, substrings and optional subsequences.
func matchScore(fragment, candidate string, fuzzy bool) int {
	fragment, candidate = strings.ToLower(fragment), strings.ToLower(candidate)
	if fragment == "" {
		return 300
	}
	if strings.HasPrefix(candidate, fragment) {
		return 1000 - min(120, utf8.RuneCountInString(candidate)-utf8.RuneCountInString(fragment))
	}
	if strings.Contains(candidate, fragment) {
		return 700 - min(150, utf8.RuneCountInString(candidate)-utf8.RuneCountInString(fragment))
	}
	if !fuzzy {
		return 0
	}
	needle := []rune(fragment)
	matched, gaps := 0, 0
	for _, character := range candidate {
		if character == needle[matched] {
			matched++
			if matched == len(needle) {
				return max(180, 320-gaps)
			}
		} else {
			gaps++
		}
	}
	return 0
}

// errorStatus categorizes only filesystem failure classes, never the raw error string.
func errorStatus(err error) string {
	switch {
	case errors.Is(err, os.ErrPermission):
		return "denied"
	case errors.Is(err, os.ErrNotExist):
		return "missing"
	case errors.Is(err, syscall.ENOTDIR):
		return "not-directory"
	default:
		return "unavailable"
	}
}
