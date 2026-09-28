package paths

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLiteralRequestBoundary(t *testing.T) {
	for _, raw := range []string{
		`{"directory":"relative","fragment":"","limit":10}`,
		`{"directory":"/tmp","fragment":"a/b","limit":10}`,
		`{"directory":"/tmp","fragment":"","limit":129}`,
		`{"directory":"/tmp","fragment":"","limit":10,"command":"anything"}`,
		`{"directory":"/tmp","fragment":"","limit":10} {}`,
		strings.Repeat(" ", maxRequestBytes+1),
	} {
		if _, err := readRequest(strings.NewReader(raw)); err == nil {
			t.Fatal("invalid request accepted")
		}
	}
	request, err := readRequest(strings.NewReader(`{"directory":"/tmp/space /link/../","fragment":" a'\\$;🐟 ","limit":10}`))
	if err != nil || request.Directory != "/tmp/space /link/../" || request.Fragment != " a'\\$;🐟 " {
		t.Fatalf("literal request altered: %#v, %v", request, err)
	}
}

func TestRunDeadlineIncludesStalledStdin(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	var output bytes.Buffer
	if err := Run(ctx, reader, &output); err != nil {
		t.Fatal(err)
	}
	var result Result
	if json.Unmarshal(output.Bytes(), &result) != nil || result.Status != "timeout" || len(result.Entries) != 0 {
		t.Fatalf("unexpected deadline result: %s", output.String())
	}
}

func TestQueryMatchesBeforeLimitingAndPreservesNames(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux filesystem query is exercised in the Linux fixture")
	}
	directory := t.TempDir()
	for index := 0; index < 1200; index++ {
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("file-%04d", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	names := []string{" z-last target ", "quote'\\$;🐟", "line\nname", "tab\tname"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(directory, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	request := Request{Directory: directory, Fragment: "1199", Limit: 1}
	result := Query(context.Background(), request)
	if result.Status != "ok" || len(result.Entries) != 1 || result.Entries[0].Name != "file-1199" || result.Scanned != 1204 {
		t.Fatalf("late entry missing: %#v", result)
	}
	for _, name := range names {
		request.Fragment = name
		result = Query(context.Background(), request)
		if len(result.Entries) != 1 || result.Entries[0].Name != name {
			t.Fatalf("filename changed: %#v", result)
		}
	}
	if err := os.Mkdir(filepath.Join(directory, "target-dir"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(directory, "target-dir"), filepath.Join(directory, "alias-dir")); err != nil {
		t.Fatal(err)
	}
	request.Fragment, request.DirectoriesOnly = "dir", true
	result = Query(context.Background(), request)
	if result.Entries[0].Kind != "directory" {
		t.Fatalf("directory identity lost: %#v", result)
	}
	request.Directory, request.Fragment = filepath.Join(directory, "file-0000"), ""
	if result = Query(context.Background(), request); result.Status != "not-directory" {
		t.Fatalf("wrong file failure: %#v", result)
	}
	request.Directory += "/absent"
	if result = Query(context.Background(), request); result.Status != "not-directory" {
		t.Fatalf("wrong parent failure: %#v", result)
	}
}

func TestQueryScanLimitAndSymlinkParentResolution(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux filesystem query is exercised in the Linux fixture")
	}
	directory := t.TempDir()
	for index := 0; index < maxScanEntries+1; index++ {
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("entry-%05d", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result := Query(context.Background(), Request{Directory: directory, Limit: 2})
	if result.Status != "partial" || result.Scanned != maxScanEntries || len(result.Entries) != 2 {
		t.Fatalf("unbounded scan: %#v", result)
	}
	parent := t.TempDir()
	if err := os.Mkdir(filepath.Join(parent, "child"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "outside-target"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(parent, "child"), filepath.Join(directory, "link")); err != nil {
		t.Fatal(err)
	}
	result = Query(context.Background(), Request{Directory: directory + "/link/../", Fragment: "outside-target", Limit: 2})
	if result.Status != "ok" || len(result.Entries) != 1 || result.Entries[0].Name != "outside-target" {
		t.Fatalf("symlink parent was normalized: %#v", result)
	}
}
