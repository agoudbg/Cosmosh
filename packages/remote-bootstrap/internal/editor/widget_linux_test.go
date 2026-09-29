//go:build linux

package editor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/inputorder"
)

func TestWidgetModeReturnsSixInputBoundaryFields(t *testing.T) {
	store, err := inputorder.Create(testInputBoundary.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.SetShellPID(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	target := Target{InstanceID: fmt.Sprintf("abcdef01-2345-4789-abcd-%012x", os.Getpid()),
		Shell: "zsh", PID: os.Getpid(), StartTime: "1234"}
	address, err := socketAddress(target)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.Remove(address)
	})
	if err := listener.(*net.UnixListener).SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	received := make(chan widgetMessage, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		var message widgetMessage
		if json.NewDecoder(connection).Decode(&message) != nil {
			return
		}
		received <- message
		_ = json.NewEncoder(connection).Encode(widgetReply{Status: "ok",
			RequestID: "11111111-2222-4333-8abc-111111111111", Operation: "snapshot",
			InputBoundary: testInputBoundary})
	}()
	args := []string{"mode", target.InstanceID, target.Shell, fmt.Sprint(target.PID),
		target.StartTime, "1", "emacs"}
	var output bytes.Buffer
	if err := RunWidget(args, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	expected := fmt.Sprintf("%s\nsnapshot\n0\n%s\n0\n%s\n",
		"11111111-2222-4333-8abc-111111111111", testInputBoundary.Epoch, store.Path())
	if output.String() != expected {
		t.Fatalf("widget mode boundary fields changed: %q", output.String())
	}
	select {
	case message := <-received:
		if message.Phase != "mode" || message.Target != target || message.PromptGeneration != 1 {
			t.Fatal("widget sent an unexpected private request")
		}
	default:
		t.Fatal("widget did not send its mode request")
	}
}
