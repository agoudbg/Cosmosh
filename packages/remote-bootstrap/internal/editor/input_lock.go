package editor

import (
	"errors"
	"strconv"

	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/inputorder"
)

// ClaimInputLock authenticates metadata-only arguments and keeps the parent's scoped FD 9 locked.
// The Shell closes that descriptor before redraw, remote acknowledgement, or any error report.
func ClaimInputLock(args []string) error {
	if len(args) != 7 { return errors.New("invalid-input-lock") }
	pid, pidErr := strconv.Atoi(args[2])
	sequence, seqErr := strconv.ParseUint(args[5], 10, 64)
	target := Target{InstanceID: args[0], Shell: args[1], PID: pid, StartTime: args[3]}
	boundary := inputorder.Boundary{Epoch: args[4], Sequence: sequence}
	if pidErr != nil || seqErr != nil || !validTarget(target) || !validInputBoundary(boundary) ||
		!uuidPattern.MatchString(args[6]) || checkTarget(target, false) != nil {
		return errors.New("invalid-input-lock")
	}
	if !inputorder.ClaimFD(9, pid, boundary, args[6]) { return errors.New("input-lock-unavailable") }
	// This kernel check is inside the lock: the forwarder cannot enqueue new PTY input
	// between this empty-queue observation and the parent's immediate native assignment.
	if checkFishInput(target) != nil {
		_ = inputorder.UnlockFD(9)
		return errors.New("input-pending")
	}
	return nil
}
