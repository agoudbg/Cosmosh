package editor

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// exchangeWidget sends one authenticated request to the currently owned socket and bounds its response.
func exchangeWidget(message widgetMessage) (widgetReply, error) {
	var reply widgetReply
	address, err := socketAddress(message.Target)
	if err != nil {
		return reply, err
	}
	connection, err := net.DialTimeout("unix", address, RequestTimeout)
	if err != nil {
		return reply, errors.New("request-unavailable")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(RequestTimeout))
	if err := json.NewEncoder(connection).Encode(message); err != nil {
		return reply, errors.New("request-unavailable")
	}
	line, err := readFrame(bufio.NewReaderSize(connection, 4096))
	if err != nil || decodeFrame(line, &reply) != nil {
		return reply, errors.New("request-unavailable")
	}
	return reply, nil
}

// RunWidget grants mode first, then reads only explicitly permitted fields from the Shell's private stdin.
// Arguments contain only identity and permission metadata. User input is never passed as an OS argument.
func RunWidget(args []string, input io.Reader, output io.Writer) error {
	if len(args) < 7 {
		return errors.New("invalid-widget")
	}
	pid, pidErr := strconv.Atoi(args[3])
	generation, generationErr := strconv.ParseUint(args[5], 10, 64)
	target := Target{InstanceID: args[1], Shell: args[2], PID: pid, StartTime: args[4]}
	if pidErr != nil || generationErr != nil || generation == 0 || !validTarget(target) {
		return errors.New("invalid-widget")
	}
	mode := args[6]
	if args[0] != "reject" && target.Shell == "fish" && checkFishInput(target) != nil {
		message := widgetMessage{Phase: "reject", Target: target, PromptGeneration: generation}
		if len(args) >= 8 && uuidPattern.MatchString(args[7]) {
			message.RequestID = args[7]
		}
		_, _ = exchangeWidget(message)
		return errors.New("unsupported-editor")
	}
	if args[0] == "reject" && (len(args) == 7 || (len(args) == 8 && uuidPattern.MatchString(args[7]))) {
		message := widgetMessage{Phase: "reject", Target: target, PromptGeneration: generation}
		if len(args) == 8 {
			message.RequestID = args[7]
		}
		_, err := exchangeWidget(message)
		return err
	}
	if mode != "emacs" && mode != "vi-insert" {
		return errors.New("unsupported-editor")
	}
	message := widgetMessage{Phase: args[0], Target: target, PromptGeneration: generation}
	if message.Phase == "mode" {
		if len(args) != 7 {
			return errors.New("invalid-widget")
		}
		reply, err := exchangeWidget(message)
		if err != nil || reply.Status != "ok" || !uuidPattern.MatchString(reply.RequestID) {
			return errors.New("request-unavailable")
		}
		directory := "0"
		if reply.IncludeDirectory {
			directory = "1"
		}
		if reply.Operation == "history-delete" {
			if target.Shell != "fish" || reply.IncludeDirectory || reply.History == nil ||
				!validHistory(*reply.History) || reply.History.Status != "ok" || len(reply.History.Entries) != 1 {
				return errors.New("invalid-widget")
			}
			namespace := base64.StdEncoding.EncodeToString([]byte(*reply.History.Namespace))
			entry := base64.StdEncoding.EncodeToString([]byte(reply.History.Entries[0]))
			_, err = fmt.Fprintf(output, "%s\n%s\n%s\n%s\n%s\n", reply.RequestID, reply.Operation, directory, namespace, entry)
		} else {
			_, err = fmt.Fprintf(output, "%s\n%s\n%s\n", reply.RequestID, reply.Operation, directory)
		}
		return err
	}
	if message.Phase == "history" || message.Phase == "history-confirm" {
		if len(args) != 8 || target.Shell != "fish" || !uuidPattern.MatchString(args[7]) {
			return errors.New("invalid-widget")
		}
		history, err := readNativeHistory(input)
		if err != nil {
			return err
		}
		if message.Phase == "history-confirm" {
			message.Phase = "confirm"
		} else {
			message.Phase = "capture"
		}
		message.RequestID = args[7]
		message.Snapshot = &Snapshot{PromptGeneration: generation, EditorMode: mode, History: history}
		reply, err := exchangeWidget(message)
		if err == nil && reply.Status == "apply" && message.Phase == "capture" {
			_, err = fmt.Fprintln(output, "apply")
			return err
		}
		if err != nil || reply.Status != "ok" {
			return errors.New("history-unavailable")
		}
		_, err = fmt.Fprintln(output, "ok")
		return err
	}
	if (message.Phase != "capture" && message.Phase != "confirm") || len(args) != 10 ||
		!uuidPattern.MatchString(args[7]) || (args[8] != "0" && args[8] != "1") || (args[9] != "0" && args[9] != "1") {
		return errors.New("invalid-widget")
	}
	message.RequestID = args[7]
	includeInput, includeDirectory := args[8] == "1", args[9] == "1"
	raw, err := io.ReadAll(io.LimitReader(input, MaxInputBytes+2*MaxPathBytes+128))
	if err != nil || len(raw) >= MaxInputBytes+2*MaxPathBytes+128 {
		return errors.New("unsupported-editor")
	}
	// A fixed four-field private frame preserves empty values and literal trailing newlines.
	fields := strings.Split(string(raw), "\x00")
	if len(fields) != 5 || fields[4] != "" {
		return errors.New("invalid-widget")
	}
	snapshot := Snapshot{PromptGeneration: generation, EditorMode: mode}
	if includeInput {
		// Fish commandline prints one framing newline; keep any earlier user-authored newline
		// so the common single-line validator rejects it instead of silently changing the buffer.
		if target.Shell == "fish" {
			if !strings.HasSuffix(fields[0], "\n") {
				return errors.New("invalid-widget")
			}
			fields[0] = strings.TrimSuffix(fields[0], "\n")
		}
		point, err := strconv.Atoi(fields[1])
		if err != nil {
			return errors.New("unsupported-editor")
		}
		snapshot.Buffer = &Buffer{Text: fields[0], Cursor: point}
	} else if fields[0] != "" || fields[1] != "" {
		return errors.New("invalid-widget")
	}
	if includeDirectory {
		snapshot.Directory = &Directory{Logical: fields[2], Physical: physicalDirectory()}
		if validPath(fields[3]) {
			snapshot.Directory.Home = &fields[3]
		}
	} else if fields[2] != "" || fields[3] != "" {
		return errors.New("invalid-widget")
	}
	if !validSnapshot(snapshot, includeInput, includeDirectory, false) {
		return errors.New("unsupported-editor")
	}
	message.Snapshot = &snapshot
	reply, err := exchangeWidget(message)
	if err != nil {
		return err
	}
	if reply.Status == "apply" && reply.Replacement != nil && validBuffer(*reply.Replacement) {
		encoded := base64.StdEncoding.EncodeToString([]byte(reply.Replacement.Text))
		// Fish command substitutions drop empty records. A non-base64 sentinel preserves an
		// intentionally empty replacement without changing Bash/Zsh's existing private frame.
		if target.Shell == "fish" && encoded == "" {
			encoded = "-"
		}
		_, err = fmt.Fprintf(output, "apply\n%s\n%d\n", encoded, reply.Replacement.Cursor)
		return err
	}
	if reply.Status != "ok" {
		return errors.New("request-unavailable")
	}
	_, err = fmt.Fprintln(output, "ok")
	return err
}
