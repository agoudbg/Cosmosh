//go:build linux

package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

const (
	sessionTestProcess  = "COSMOSH_TEST_SESSION_PROCESS"
	sessionTestFixture  = "COSMOSH_TEST_SESSION_FIXTURE"
	sessionTestProgress = "COSMOSH_TEST_SESSION_PROGRESS"
	sessionTestRawReady = "session-test-raw-ready\n"
)

// TestMain reuses this binary as the real forwarder and as its native raw PTY child.
// No production I/O, framing, queue, cancellation, or PTY code is replaced.
func TestMain(tests *testing.M) {
	if os.Getenv(sessionTestProcess) != "1" {
		os.Exit(tests.Run())
	}
	if len(os.Args) == 2 && os.Args[1] == "-i" {
		if err := runSessionPTYFixture(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(90)
		}
		os.Exit(0)
	}
	// Inherited SSH pipes start blocking. Testing only Run with os.Pipe would miss
	// the regression because os.Pipe already registers descriptors with Go's poller.
	for _, file := range []*os.File{os.Stdin, os.Stdout} {
		flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, file.Fd(), syscall.F_GETFL, 0)
		if errno != 0 || flags&syscall.O_NONBLOCK != 0 {
			fmt.Fprintln(os.Stderr, "session-test-requires-blocking-stdio")
			os.Exit(91)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGPIPE)
	err := RunStandardIO(ctx)
	stop()
	if err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

// runSessionPTYFixture holds a real raw terminal without consuming subsequent input.
func runSessionPTYFixture() error {
	var mode syscall.Termios
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, os.Stdin.Fd(), syscall.TCGETS, uintptr(unsafe.Pointer(&mode))); errno != 0 {
		return errors.New("session-test-read-termios-failed")
	}
	mode.Iflag &^= syscall.IGNBRK | syscall.BRKINT | syscall.PARMRK | syscall.ISTRIP | syscall.INLCR | syscall.IGNCR | syscall.ICRNL | syscall.IXON
	mode.Oflag &^= syscall.OPOST
	mode.Lflag &^= syscall.ECHO | syscall.ECHONL | syscall.ICANON | syscall.ISIG | syscall.IEXTEN
	mode.Cflag &^= syscall.CSIZE | syscall.PARENB
	mode.Cflag |= syscall.CS8
	mode.Cc[syscall.VMIN], mode.Cc[syscall.VTIME] = 1, 0
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, os.Stdin.Fd(), syscall.TCSETS, uintptr(unsafe.Pointer(&mode))); errno != 0 {
		return errors.New("session-test-write-termios-failed")
	}
	if _, err := io.WriteString(os.Stdout, sessionTestRawReady); err != nil {
		return errors.New("session-test-ready-failed")
	}
	if os.Getenv(sessionTestFixture) == "output" {
		// The parent first consumes the ready frame, then explicitly starts flooding.
		var trigger [1]byte
		if _, err := io.ReadFull(os.Stdin, trigger[:]); err != nil {
			return errors.New("session-test-trigger-failed")
		}
	}
	// This side channel carries only a boolean fixture milestone. Observing bytes in
	// the actual slave input queue proves the forwarder reached its PTY write.
	go func() {
		for {
			pending, err := sessionPipeBytes(os.Stdin)
			if err != nil {
				return
			}
			if pending > 0 {
				_ = os.WriteFile(os.Getenv(sessionTestProgress), []byte("ready"), 0600)
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	if os.Getenv(sessionTestFixture) == "output" {
		if _, err := os.Stdout.Write(bytes.Repeat([]byte("x"), 8*1024*1024)); err != nil {
			return errors.New("session-test-flood-failed")
		}
	}
	time.Sleep(time.Hour)
	return errors.New("session-test-unexpected-fixture-timeout")
}

// sessionTestChild owns one independently spawned forwarder and its real pipe endpoints.
type sessionTestChild struct {
	command     *exec.Cmd
	input       *os.File
	output      *os.File
	outputProbe *os.File
	reader      *frameReader
	done        chan struct{}
	waitError   error
	ptyProcess  *os.Process
	progress    string
}

// startSessionTestChild creates inherited blocking pipes and registers bounded cleanup.
func startSessionTestChild(t *testing.T, fixture string) *sessionTestChild {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	inputRead, inputWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = inputRead.Close(); _ = inputWrite.Close() })
	outputRead, outputWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = outputRead.Close(); _ = outputWrite.Close() })
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, outputWrite.Fd(), syscall.F_SETPIPE_SZ, 4096)
	if errno != 0 {
		t.Fatal(errno)
	}
	child := &sessionTestChild{
		input:       inputWrite,
		output:      outputRead,
		outputProbe: outputWrite,
		reader:      newFrameReader(outputRead),
		done:        make(chan struct{}),
		progress:    filepath.Join(t.TempDir(), "pty-input-observed"),
	}
	child.command = exec.Command(executable, "-test.run=^$")
	child.command.Env = append(os.Environ(), sessionTestProcess+"=1", sessionTestFixture+"="+fixture,
		sessionTestProgress+"="+child.progress, "SHELL="+executable)
	child.command.Stdin, child.command.Stdout, child.command.Stderr = inputRead, outputWrite, os.Stderr
	if err = child.command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = inputRead.Close()
	// Retain this endpoint only to observe kernel writability; the fixture never
	// writes through it. Pipe EOF is not used by these cancellation assertions.
	go func() {
		child.waitError = child.command.Wait()
		close(child.done)
	}()
	t.Cleanup(func() {
		_ = child.input.Close()
		_ = child.output.Close()
		_ = child.command.Process.Signal(syscall.SIGTERM)
		select {
		case <-child.done:
		case <-time.After(2 * time.Second):
			_ = child.command.Process.Kill()
			select {
			case <-child.done:
			case <-time.After(2 * time.Second):
				t.Error("session-test-forwarder-cleanup-timeout")
			}
		}
		if child.ptyProcess != nil {
			_ = child.ptyProcess.Kill()
			_ = child.ptyProcess.Release()
		}
	})
	if hello := child.read(t); hello.Type != "hello" || hello.Protocol != ProtocolVersion {
		t.Fatal("missing session hello")
	}
	return child
}

// read keeps an unexpected missing frame from hanging the test process.
func (child *sessionTestChild) read(t *testing.T) frame {
	t.Helper()
	if err := child.output.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	value, err := child.reader.read()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

// send exercises the same bounded JSON line format used by the SSH transport.
func (child *sessionTestChild) send(t *testing.T, value frame) {
	t.Helper()
	if err := child.input.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(child.input).Encode(value); err != nil {
		t.Fatal(err)
	}
}

// start waits for both the real child PID and its completed raw-mode setup.
func (child *sessionTestChild) start(t *testing.T) {
	t.Helper()
	child.send(t, frame{Type: "start", Protocol: ProtocolVersion, Epoch: testEpoch, Rows: 24, Cols: 80, Term: "xterm-256color"})
	ready := child.read(t)
	if ready.Type != "ready" || ready.Epoch != testEpoch || ready.PID <= 0 {
		t.Fatal("missing session ready")
	}
	process, err := os.FindProcess(ready.PID)
	if err != nil {
		t.Fatal(err)
	}
	child.ptyProcess = process
	var output []byte
	for !bytes.Contains(output, []byte(sessionTestRawReady)) {
		value := child.read(t)
		if value.Type != "output" || len(output)+len(value.Data) > 1024 {
			t.Fatal("unexpected fixture startup output")
		}
		output = append(output, value.Data...)
	}
}

// wait checks that cancellation returns through production code rather than a forced kill.
func (child *sessionTestChild) wait(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case <-child.done:
		var exit *exec.ExitError
		if !errors.As(child.waitError, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("unexpected cancelled forwarder exit: %v", child.waitError)
		}
		if child.ptyProcess != nil {
			err := child.ptyProcess.Signal(syscall.Signal(0))
			if !errors.Is(err, os.ErrProcessDone) && !errors.Is(err, syscall.ESRCH) {
				t.Fatalf("forwarder returned before its PTY child terminated: %v", err)
			}
		}
	case <-time.After(timeout):
		t.Fatal("forwarder did not terminate within its cancellation bound")
	}
}

// waitForSessionCondition polls only observable fixture or kernel metadata.
func waitForSessionCondition(t *testing.T, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal(description)
		}
		time.Sleep(time.Millisecond)
	}
}

// sessionPipeBytes reads Linux's actual unread-byte count without consuming the stream.
func sessionPipeBytes(file *os.File) (int, error) {
	connection, err := file.SyscallConn()
	if err != nil {
		return 0, err
	}
	var count int32
	var errno syscall.Errno
	err = connection.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCINQ, uintptr(unsafe.Pointer(&count)))
	})
	if err != nil {
		return 0, err
	}
	if errno != 0 {
		return 0, errno
	}
	return int(count), nil
}

// sessionPipeWritable observes backpressure without assuming unread bytes equal
// capacity: Linux can stop a large write with a partially occupied final page.
func sessionPipeWritable(file *os.File) (bool, error) {
	connection, err := file.SyscallConn()
	if err != nil {
		return false, err
	}
	var writable bool
	var selectError error
	err = connection.Control(func(fd uintptr) {
		var descriptors syscall.FdSet
		wordBits := uintptr(unsafe.Sizeof(descriptors.Bits[0]) * 8)
		if fd/wordBits >= uintptr(len(descriptors.Bits)) {
			selectError = errors.New("session-test-descriptor-out-of-range")
			return
		}
		descriptors.Bits[fd/wordBits] |= 1 << (fd % wordBits)
		timeout := syscall.Timeval{}
		count, err := syscall.Select(int(fd)+1, nil, &descriptors, nil, &timeout)
		writable, selectError = count > 0, err
	})
	if err != nil {
		return false, err
	}
	return writable, selectError
}

func TestStandardIOStartupTimeoutInterruptsBlockedRead(t *testing.T) {
	started := time.Now()
	child := startSessionTestChild(t, "idle")
	// Keep stdin open and supply no start frame: the real ten-second timer must
	// interrupt an inherited blocking descriptor through RunStandardIO's duplicate.
	child.wait(t, 12*time.Second)
	if elapsed := time.Since(started); elapsed < 9*time.Second {
		t.Fatal("forwarder exited before the production startup deadline")
	}
}

func TestSessionEOFInterruptsBlockedPTYWrite(t *testing.T) {
	child := startSessionTestChild(t, "raw")
	child.start(t)
	child.send(t, frame{Type: "input", Epoch: testEpoch, Sequence: 1, Data: bytes.Repeat([]byte("a"), maxDataBytes)})
	waitForSessionCondition(t, func() bool {
		_, err := os.Stat(child.progress)
		return err == nil
	}, "raw PTY did not receive the first input")
	child.send(t, frame{Type: "input", Epoch: testEpoch, Sequence: 2, Data: bytes.Repeat([]byte("b"), maxDataBytes)})
	// The second decoded frame must not prevent the independent reader from
	// reaching EOF while the first full-size write cannot finish.
	if err := child.input.Close(); err != nil {
		t.Fatal(err)
	}
	child.wait(t, 2*time.Second)
}

func TestStandardIOCancellationInterruptsBlockedOutput(t *testing.T) {
	child := startSessionTestChild(t, "output")
	child.start(t)
	child.send(t, frame{Type: "input", Epoch: testEpoch, Sequence: 1, Data: []byte("s")})
	waitForSessionCondition(t, func() bool {
		count, err := sessionPipeBytes(child.output)
		writable, pollError := sessionPipeWritable(child.outputProbe)
		return err == nil && pollError == nil && count > 0 && !writable
	}, "forwarder output pipe did not fill")
	child.send(t, frame{Type: "input", Epoch: testEpoch, Sequence: 2, Data: []byte("x")})
	waitForSessionCondition(t, func() bool {
		_, err := os.Stat(child.progress)
		return err == nil
	}, "forwarder did not deliver input while output was blocked")
	// The encoder is now blocked on a full real pipe and input needs the same
	// writer for its acknowledgement. Signal cancellation must release both.
	if err := child.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	child.wait(t, 2*time.Second)
}

func TestSessionPreservesSignalInExitCode(t *testing.T) {
	child := startSessionTestChild(t, "raw")
	child.start(t)
	if err := child.ptyProcess.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	value := child.read(t)
	if value.Type != "exit" || value.Code == nil || *value.Code != 128+int(syscall.SIGTERM) {
		t.Fatal("signal termination lost its 128+signal exit status")
	}
	select {
	case <-child.done:
		if child.waitError != nil {
			t.Fatalf("normal session protocol exit failed: %v", child.waitError)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("forwarder did not exit after reporting its child signal")
	}
}
