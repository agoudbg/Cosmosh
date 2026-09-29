package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

const testEpoch = "01234567-89ab-4cde-8fab-0123456789ab"

// shortWriter models the PTY write boundary, including deterministic short writes.
type shortWriter struct {
	output    bytes.Buffer
	limit     int
	failAfter int
}

func (writer *shortWriter) Write(data []byte) (int, error) {
	if writer.failAfter > 0 && writer.output.Len() >= writer.failAfter {
		return 0, errors.New("private input must not escape")
	}
	if len(data) > writer.limit {
		data = data[:writer.limit]
	}
	return writer.output.Write(data)
}

func TestDeliveryFollowsEveryShortWrite(t *testing.T) {
	writer := &shortWriter{limit: 3}
	input := frame{Type: "input", Epoch: testEpoch, Sequence: 4, Data: []byte("secret\x00\x03\r\n中文")}
	acknowledged := 0
	err := deliver(writer, input, func(value frame) error {
		acknowledged++
		if !bytes.Equal(writer.output.Bytes(), input.Data) || value.Type != "delivered" || value.Sequence != 4 || value.Epoch != testEpoch {
			t.Fatal("acknowledged before full delivery")
		}
		return nil
	})
	if err != nil || acknowledged != 1 {
		t.Fatalf("delivery result: %v %d", err, acknowledged)
	}
}

func TestPartialFailureNeverAcknowledgesOrExposesInput(t *testing.T) {
	writer := &shortWriter{limit: 2, failAfter: 4}
	err := deliver(writer, frame{Data: []byte("password")}, func(frame) error { t.Fatal("partial input acknowledged"); return nil })
	if err == nil || err.Error() != "session-input-failed" || writer.output.String() != "pass" {
		t.Fatalf("unexpected partial result: %v", err)
	}
}

// delayedWriter blocks the external PTY boundary while the delivery loop stays real.
type delayedWriter struct {
	entered chan struct{}
	release chan struct{}
}

func (writer delayedWriter) Write(data []byte) (int, error) {
	close(writer.entered)
	<-writer.release
	return len(data), nil
}

func TestBlockedPTYCannotAcknowledgeEarly(t *testing.T) {
	writer := delayedWriter{make(chan struct{}), make(chan struct{})}
	ack := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- deliver(writer, frame{Data: []byte("delayed")}, func(frame) error { close(ack); return nil })
	}()
	<-writer.entered
	select {
	case <-ack:
		t.Fatal("early acknowledgement")
	default:
	}
	close(writer.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	<-ack
}

func TestProtocolBoundsAndSessionOrder(t *testing.T) {
	start := frame{Type: "start", Protocol: ProtocolVersion, Epoch: testEpoch, Rows: 32, Cols: 120, Term: "xterm-256color"}
	if !start.validStart() {
		t.Fatal("valid start rejected")
	}
	start.Protocol = 1
	if start.validStart() {
		t.Fatal("protocol v1 start accepted")
	}
	start.Protocol = ProtocolVersion
	start.Data = []byte("injected")
	if start.validStart() {
		t.Fatal("start accepted input")
	}
	input := frame{Type: "input", Epoch: testEpoch, Sequence: 1, Data: []byte("a")}
	if !input.validControl(testEpoch, 0) || input.validControl(testEpoch, 1) || input.validControl("other", 0) {
		t.Fatal("sequence or epoch mismatch accepted")
	}
	input.Sequence = maxSequence + 1
	if input.validControl(testEpoch, maxSequence) {
		t.Fatal("unsafe JS number accepted")
	}
	authorize := frame{Type: "authorize-editor", Epoch: testEpoch, Sequence: 1, RequestID: testEpoch}
	if !authorize.validControl(testEpoch, 1) {
		t.Fatal("valid editor authorization rejected")
	}
	falseValue := false
	authorize.Approved = &falseValue
	if authorize.validControl(testEpoch, 1) {
		t.Fatal("response-only approval accepted as control input")
	}
	authorize.Approved = nil
	authorize.RequestID = "not-a-uuid"
	if authorize.validControl(testEpoch, 1) {
		t.Fatal("invalid request UUID accepted")
	}
	revoke := frame{Type: "revoke-editor", Epoch: testEpoch, RequestID: testEpoch}
	if !revoke.validControl(testEpoch, 1) {
		t.Fatal("valid revoke rejected")
	}
	revoke.Sequence = 1
	if revoke.validControl(testEpoch, 1) {
		t.Fatal("revoke with sequence accepted")
	}
	for _, source := range []string{`{"type":"input","extra":true}`, `{"type":"input"} {}`, strings.Repeat("x", maxFrameBytes)} {
		if _, err := newFrameReader(strings.NewReader(source + "\n")).read(); err == nil {
			t.Fatal("invalid frame accepted")
		}
	}
	if _, err := newFrameReader(strings.NewReader("")).read(); !errors.Is(err, io.EOF) {
		t.Fatal("EOF not recognized")
	}
}

func TestEditorAuthorizationSerializesZeroSequence(t *testing.T) {
	var output bytes.Buffer
	writer := frameWriter{encoder: json.NewEncoder(&output)}
	approved := true
	if err := writer.write(frame{Type: "editor-authorized", Epoch: testEpoch,
		Sequence: 0, RequestID: testEpoch, Approved: &approved}); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(output.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 5 || string(fields["sequence"]) != "0" ||
		string(fields["approved"]) != "true" {
		t.Fatalf("authorization wire omitted required zero sequence: %s", output.String())
	}
}
