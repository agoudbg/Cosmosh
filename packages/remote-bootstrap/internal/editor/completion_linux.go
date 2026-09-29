//go:build linux

package editor

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

//go:embed fish-completion.fish
var fishCompletionScript string

// queryNativeCompletion executes the same verified Fish binary under the current remote user.
func queryNativeCompletion(ctx context.Context, target Target, snapshot Snapshot, environment []string) NativeCompletionResult {
	if target.Shell != "fish" || checkTarget(target, false) != nil {
		return completionFailure("unavailable")
	}
	executable, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", target.PID))
	if err != nil || filepath.Base(executable) != "fish" {
		return completionFailure("unavailable")
	}
	return runFishCompletion(ctx, executable, snapshot, environment)
}

// completionNoise discards startup/script chatter and cancels excessive output without retaining it.
type completionNoise struct {
	mutex  sync.Mutex
	bytes  int
	cancel context.CancelFunc
}

// Write bounds combined stdout/stderr even when os/exec copies the two streams concurrently.
func (writer *completionNoise) Write(value []byte) (int, error) {
	writer.mutex.Lock()
	defer writer.mutex.Unlock()
	writer.bytes += len(value)
	if writer.bytes > 64*1024 {
		writer.cancel()
		return 0, errors.New("query-output-limit")
	}
	return len(value), nil
}

// runFishCompletion owns a separate session/process group; it never acquires or writes the original PTY.
// The child loads saved noninteractive Fish configuration. Query/environment bytes remain remote-only.
func runFishCompletion(parent context.Context, executable string, snapshot Snapshot, environment []string) NativeCompletionResult {
	return runFishCompletionWithPipes(parent, executable, snapshot, environment, os.Pipe)
}

// runFishCompletionWithPipes isolates pipe creation as an OS boundary for real small-capacity cleanup tests.
func runFishCompletionWithPipes(parent context.Context, executable string, snapshot Snapshot, environment []string,
	newPipe func() (*os.File, *os.File, error)) NativeCompletionResult {
	if !validSnapshot(snapshot, true, true, false) || snapshot.Directory.Physical == nil ||
		!validCompletionEnvironment(environment) || snapshot.Buffer.Cursor != len([]rune(snapshot.Buffer.Text)) {
		return completionFailure("unavailable")
	}
	ctx, cancel := context.WithTimeout(parent, time.Second)
	defer cancel()
	inputRead, inputWrite, err := newPipe()
	if err != nil {
		return completionFailure("unavailable")
	}
	defer inputRead.Close()
	defer inputWrite.Close()
	resultRead, resultWrite, err := newPipe()
	if err != nil {
		return completionFailure("unavailable")
	}
	defer resultRead.Close()
	defer resultWrite.Close()
	command := exec.Command(executable, "--private", "--command", fishCompletionScript)
	command.Env = environment
	command.Dir = *snapshot.Directory.Physical
	command.ExtraFiles = []*os.File{inputRead, resultWrite}
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	command.WaitDelay = 100 * time.Millisecond
	noise := &completionNoise{cancel: cancel}
	command.Stdout, command.Stderr = noise, noise
	if ctx.Err() != nil || command.Start() != nil {
		return completionFailure("unavailable")
	}
	inputRead.Close()
	resultWrite.Close()
	// Kill before Wait reaps the leader, so its PID cannot be reused by an unrelated process group.
	kill := func() { _ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		kill()
		resultRead.Close()
		inputWrite.Close()
		close(stopped)
	})
	payload := []byte(snapshot.Buffer.Text + "\x00" + snapshot.Directory.Logical + "\x00" + *snapshot.Directory.Physical + "\x00")
	written := make(chan error, 1)
	go func() {
		_, err := io.Copy(inputWrite, bytes.NewReader(payload))
		inputWrite.Close()
		written <- err
	}()
	raw, readErr := io.ReadAll(io.LimitReader(resultRead, maxCompletionOutputBytes+1))
	// A detached descendant may retain stdin after closing result output; never wait on its reader.
	inputWrite.Close()
	kill()
	if !stop() {
		<-stopped
	}
	waitErr := command.Wait()
	writeErr := <-written
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return completionFailure("timeout")
	}
	if ctx.Err() != nil || readErr != nil || writeErr != nil || len(raw) > maxCompletionOutputBytes {
		return completionFailure("unavailable")
	}
	// The script's final frame proves completion status. Cleanup may kill Fish after it closes fd 4.
	_ = waitErr
	return parseNativeCompletion(raw)
}
