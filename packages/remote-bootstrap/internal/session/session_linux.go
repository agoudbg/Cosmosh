//go:build linux

package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/inputorder"
	"github.com/creack/pty"
)

// RunStandardIO makes SSH's inherited pipe descriptors cancellable before using them.
// os.Stdin/os.Stdout may wrap blocking descriptors whose Close cannot interrupt an active syscall.
func RunStandardIO(ctx context.Context) error {
	input, err := pollableDuplicate(os.Stdin)
	if err != nil {
		return errors.New("session-input-unavailable")
	}
	defer input.Close()
	output, err := pollableDuplicate(os.Stdout)
	if err != nil {
		return errors.New("session-output-unavailable")
	}
	defer output.Close()
	return Run(ctx, input, output)
}

// pollableDuplicate lets the Go runtime interrupt blocked reads and writes on cancellation.
func pollableDuplicate(source *os.File) (*os.File, error) {
	fd, err := syscall.Dup(int(source.Fd()))
	if err != nil {
		return nil, err
	}
	syscall.CloseOnExec(fd)
	if err = syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), "cosmosh-session-io"), nil
}

// Run forwards a login Shell through a private SSH exec channel without an outer PTY.
// It owns input/output until return. Cancellation closes descriptors to interrupt blocked I/O.
func Run(parent context.Context, input io.ReadCloser, output io.WriteCloser) error {
	ctx, cancel := context.WithCancel(parent)
	stopIO := context.AfterFunc(ctx, func() { _ = input.Close(); _ = output.Close() })
	defer func() { cancel(); stopIO(); _ = input.Close(); _ = output.Close() }()
	writer := &frameWriter{encoder: json.NewEncoder(output)}
	reader := newFrameReader(input)
	startupTimer := time.AfterFunc(10*time.Second, cancel)
	defer startupTimer.Stop()
	if err := writer.write(frame{Type: "hello", Protocol: ProtocolVersion}); err != nil {
		return err
	}
	start, err := reader.read()
	if err != nil || !start.validStart() || ctx.Err() != nil {
		return errors.New("session-invalid-start")
	}
	startupTimer.Stop()
	order, err := inputorder.Create(start.Epoch)
	if err != nil {
		_ = writer.write(frame{Type: "start-rejected", Epoch: start.Epoch})
		return errors.New("session-input-order-unavailable")
	}
	defer func() {
		cancel()
		_ = order.Close()
	}()

	// sshd provides the account's configured Shell. No command text enters exec argv.
	shell := os.Getenv("SHELL")
	if !filepath.IsAbs(shell) {
		return errors.New("session-shell-unavailable")
	}
	command := exec.Command(shell, "-i")
	command.Args[0] = "-" + filepath.Base(shell)
	terminal, err := startTerminal(command, start)
	if err != nil {
		return errors.New("session-shell-start-failed")
	}
	defer terminal.Close()

	// os.Process uses Go's live process handle; never signal a recycled process-group id.
	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()
	childReaped := false
	stopChild := context.AfterFunc(ctx, func() { _ = terminal.Close(); _ = command.Process.Kill() })
	defer stopChild()
	defer func() {
		_ = terminal.Close()
		if !childReaped {
			_ = command.Process.Kill()
			select {
			case <-waited:
			case <-time.After(time.Second):
			}
		}
	}()
	if order.SetShellPID(command.Process.Pid) != nil {
		return errors.New("session-input-order-failed")
	}
	if err := writer.write(frame{Type: "ready", Epoch: start.Epoch, PID: command.Process.Pid}); err != nil {
		return err
	}

	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		buffer := make([]byte, 32*1024)
		for {
			count, readError := terminal.Read(buffer)
			if count > 0 && writer.write(frame{Type: "output", Epoch: start.Epoch, Data: buffer[:count]}) != nil {
				cancel()
				return
			}
			if readError != nil {
				return
			}
		}
	}()
	// The reader must reach EOF even when a PTY write is blocked. Both queued bytes and
	// frame count are bounded; overload closes the session instead of dropping/replaying input.
	inputs := make(chan frame, 4096)
	var queuedBytes atomic.Int64
	go func() {
		var received uint64
		for {
			value, readError := reader.read()
			if readError != nil || !value.validControl(start.Epoch, received) {
				cancel()
				return
			}
			if queuedBytes.Add(int64(len(value.Data)+128)) > 1024*1024 {
				cancel()
				return
			}
			if value.Type == "input" {
				// Claim the sequence before the queued frame can reach a blocked PTY write.
				if order.Receive(ctx, value.Sequence) != nil {
					cancel()
					return
				}
				received = value.Sequence
			}
			select {
			case inputs <- value:
			case <-ctx.Done():
				return
			default:
				cancel()
				return
			}
		}
	}()
	var delivered uint64
	for {
		select {
		case <-ctx.Done():
			return errors.New("session-closed")
		case waitError := <-waited:
			childReaped = true
			// A background descendant can keep the slave open after the login Shell exits.
			// Drain ordinary tail output briefly, then close instead of waiting indefinitely.
			drain := time.NewTimer(300 * time.Millisecond)
			select {
			case <-outputDone:
			case <-drain.C:
				_ = terminal.Close()
			case <-ctx.Done():
			}
			drain.Stop()
			// No output frame may race behind exit. Cancellation interrupts a blocked encoder.
			select {
			case <-outputDone:
			case <-time.After(time.Second):
				cancel()
				return errors.New("session-output-blocked")
			case <-ctx.Done():
				return errors.New("session-closed")
			}
			code := 0
			if waitError != nil {
				code = 1
				var exit *exec.ExitError
				if errors.As(waitError, &exit) {
					code = exit.ExitCode()
					if code < 0 {
						code = 128
						if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
							code += int(status.Signal())
						}
					}
				}
			}
			deadline := time.AfterFunc(time.Second, cancel)
			err := writer.write(frame{Type: "exit", Epoch: start.Epoch, Code: &code})
			deadline.Stop()
			return err
		case value := <-inputs:
			queuedBytes.Add(-int64(len(value.Data) + 128))
			if !value.validControl(start.Epoch, delivered) {
				return errors.New("session-invalid-control")
			}
			switch value.Type {
			case "input":
				if err := deliver(terminal, value, func(ack frame) error {
					if order.Deliver(ctx, ack.Sequence) != nil {
						return errors.New("session-input-order-failed")
					}
					return writer.write(ack)
				}); err != nil {
					return err
				}
				delivered = value.Sequence
			case "resize":
				if resizeTerminal(terminal, value.Rows, value.Cols) != nil {
					return errors.New("session-resize-failed")
				}
			case "authorize-editor":
				approved, err := order.Authorize(ctx, value.RequestID, value.Sequence)
				if err != nil {
					return errors.New("session-input-order-failed")
				}
				if err := writer.write(frame{
					Type: "editor-authorized", Epoch: start.Epoch, Sequence: value.Sequence,
					RequestID: value.RequestID, Approved: &approved,
				}); err != nil {
					return err
				}
			case "revoke-editor":
				if order.Revoke(ctx, value.RequestID) != nil {
					return errors.New("session-input-order-failed")
				}
			}
		}
	}
}

// startTerminal restores native terminal descriptors, foreground ownership and login argv0.
func startTerminal(command *exec.Cmd, start frame) (*os.File, error) {
	master, slave, err := pty.Open()
	if err != nil {
		return nil, err
	}
	defer slave.Close()
	pollable, err := pollableDuplicate(master)
	master.Close()
	if err != nil {
		return nil, err
	}
	master = pollable
	if err = resizeTerminal(master, start.Rows, start.Cols); err != nil {
		master.Close()
		return nil, err
	}
	command.Env = append(os.Environ(), "TERM="+start.Term, "SSH_TTY="+slave.Name())
	command.Stdin, command.Stdout, command.Stderr = slave, slave, slave
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err = command.Start(); err != nil {
		master.Close()
		return nil, err
	}
	return master, nil
}

// resizeTerminal preserves runtime polling while applying the standard Linux PTY ioctl.
func resizeTerminal(terminal *os.File, rows, cols uint16) error {
	connection, err := terminal.SyscallConn()
	if err != nil {
		return err
	}
	size := pty.Winsize{Rows: rows, Cols: cols}
	var resizeError syscall.Errno
	if err = connection.Control(func(fd uintptr) {
		_, _, resizeError = syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&size)))
	}); err != nil {
		return err
	}
	if resizeError != 0 {
		return resizeError
	}
	return nil
}
