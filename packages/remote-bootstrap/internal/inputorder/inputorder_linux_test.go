//go:build linux

package inputorder

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	firstRequest  = "11111111-2222-4333-8abc-111111111111"
	secondRequest = "22222222-3333-4444-8abc-222222222222"
)

func randomEpoch(t *testing.T) string {
	t.Helper()
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		t.Fatal(err)
	}
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		binary.BigEndian.Uint32(data[:4]), binary.BigEndian.Uint16(data[4:6]),
		binary.BigEndian.Uint16(data[6:8]), binary.BigEndian.Uint16(data[8:10]), data[10:])
}

func newTestStore(t *testing.T) (*Store, Boundary) {
	t.Helper()
	epoch := randomEpoch(t)
	store, err := Create(epoch)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.SetShellPID(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	return store, Boundary{Epoch: epoch}
}

func readOnlyFD(t *testing.T, path string) *os.File {
	t.Helper()
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(fd), path)
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func TestRecordLayoutAndReservedBytes(t *testing.T) {
	store, boundary := newTestStore(t)
	data, err := os.ReadFile(store.Path())
	if err != nil || len(data) != recordSize {
		t.Fatalf("invalid fixed record: %v", err)
	}
	if string(data[:8]) != "CSORDER1" || string(data[8:44]) != boundary.Epoch ||
		binary.BigEndian.Uint64(data[48:56]) != uint64(os.Getpid()) ||
		!bytes.Equal(data[44:48], make([]byte, 4)) ||
		!bytes.Equal(data[117:120], make([]byte, 3)) {
		t.Fatal("record layout or zero reservation changed")
	}
	if !CheckBoundary(os.Getpid(), boundary) {
		t.Fatal("empty delivered boundary rejected")
	}
	file, err := os.OpenFile(store.Path(), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte{1}, 44); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if CheckBoundary(os.Getpid(), boundary) || store.Receive(context.Background(), 1) == nil {
		t.Fatal("nonzero reserved byte accepted")
	}
}

func TestReceiveDeliveryAuthorizationAndRevocation(t *testing.T) {
	store, boundary := newTestStore(t)
	ctx := context.Background()
	if err := store.Receive(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if CheckBoundary(os.Getpid(), boundary) {
		t.Fatal("pending input looked delivered")
	}
	if approved, err := store.Authorize(ctx, firstRequest, 0); err != nil || approved {
		t.Fatalf("pending input authorized: %v %v", approved, err)
	}
	if err := store.Deliver(ctx, 1); err != nil {
		t.Fatal(err)
	}
	boundary.Sequence = 1
	if !CheckBoundary(os.Getpid(), boundary) {
		t.Fatal("complete delivery not observed")
	}
	if approved, err := store.Authorize(ctx, firstRequest, 1); err != nil || !approved {
		t.Fatalf("fresh request not authorized: %v %v", approved, err)
	}
	if approved, err := store.Authorize(ctx, firstRequest, 1); err != nil || approved {
		t.Fatalf("duplicate authorization accepted: %v %v", approved, err)
	}
	fd := readOnlyFD(t, store.Path())
	if !ClaimFD(int(fd.Fd()), os.Getpid(), boundary, firstRequest) {
		t.Fatal("read-only inherited FD did not claim authorized edit")
	}
	if CheckBoundary(os.Getpid(), boundary) {
		t.Fatal("a separate open description acquired the held lock")
	}
	if err := UnlockFD(int(fd.Fd())); err != nil {
		t.Fatal(err)
	}
	if ClaimFD(int(fd.Fd()), os.Getpid(), boundary, firstRequest) {
		t.Fatal("consumed request replayed")
	}
	if approved, err := store.Authorize(ctx, firstRequest, 1); err != nil || approved {
		t.Fatalf("consumed request reauthorized: %v %v", approved, err)
	}
	if approved, err := store.Authorize(ctx, secondRequest, 1); err != nil || !approved {
		t.Fatalf("new request not authorized: %v %v", approved, err)
	}
	if err := store.Receive(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if ClaimFD(int(fd.Fd()), os.Getpid(), boundary, secondRequest) {
		t.Fatal("new input did not revoke authorization")
	}
	if err := store.Deliver(ctx, 2); err != nil {
		t.Fatal(err)
	}
	boundary.Sequence = 2
	if approved, err := store.Authorize(ctx, secondRequest, 2); err != nil || approved {
		t.Fatalf("revoked request reauthorized: %v %v", approved, err)
	}
}

func TestClaimIdentityAndExpiry(t *testing.T) {
	store, boundary := newTestStore(t)
	fd := readOnlyFD(t, store.Path())
	if ClaimReadFD(int(fd.Fd()), os.Getpid()+1, boundary) ||
		ClaimReadFD(int(fd.Fd()), os.Getpid(), Boundary{Epoch: randomEpoch(t)}) ||
		ClaimFD(int(fd.Fd()), os.Getpid(), boundary, firstRequest) {
		t.Fatal("foreign PID, epoch or absent authorization accepted")
	}
	if approved, err := store.Authorize(context.Background(), firstRequest, 0); err != nil || !approved {
		t.Fatalf("zero-sequence authorization failed: %v %v", approved, err)
	}
	if err := store.update(context.Background(), func(value *record) error {
		value.expiryNS = 1
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if ClaimFD(int(fd.Fd()), os.Getpid(), boundary, firstRequest) {
		t.Fatal("expired request claimed")
	}
	if err := store.Revoke(context.Background(), secondRequest); err != nil {
		t.Fatal(err)
	}
	if err := store.Revoke(context.Background(), firstRequest); err != nil {
		t.Fatal(err)
	}
	if ClaimFD(int(fd.Fd()), os.Getpid(), boundary, firstRequest) {
		t.Fatal("revoked request claimed")
	}
}

func TestPermissionLinksAndReplacementReject(t *testing.T) {
	store, boundary := newTestStore(t)
	fd := readOnlyFD(t, store.Path())
	if err := os.Chmod(store.Path(), 0o666); err != nil {
		t.Fatal(err)
	}
	if CheckBoundary(os.Getpid(), boundary) || ClaimReadFD(int(fd.Fd()), os.Getpid(), boundary) {
		t.Fatal("world-writable metadata accepted")
	}
	if err := os.Chmod(store.Path(), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(filepath.Dir(store.Path()), boundary.Epoch+".link")
	if err := os.Link(store.Path(), link); err != nil {
		t.Fatal(err)
	}
	if CheckBoundary(os.Getpid(), boundary) || ClaimReadFD(int(fd.Fd()), os.Getpid(), boundary) {
		t.Fatal("multiply linked metadata accepted")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	backup := store.Path() + ".owned"
	if err := os.Rename(store.Path(), backup); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(backup, store.Path()); err != nil {
		t.Fatal(err)
	}
	if CheckBoundary(os.Getpid(), boundary) || ClaimReadFD(int(fd.Fd()), os.Getpid(), boundary) {
		t.Fatal("symlink metadata accepted")
	}
	if err := os.Remove(store.Path()); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.Path(), original, 0o600); err != nil {
		t.Fatal(err)
	}
	if store.Receive(context.Background(), 1) == nil || ClaimReadFD(int(fd.Fd()), os.Getpid(), boundary) {
		t.Fatal("Store or inherited FD accepted a replacement inode")
	}
	if err := os.Remove(store.Path()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, store.Path()); err != nil {
		t.Fatal(err)
	}
}

func TestInheritedLockSurvivesOneShotHelperExit(t *testing.T) {
	if os.Getenv("COSMOSH_INPUT_ORDER_CHILD") == "1" {
		pid, _ := strconv.Atoi(os.Getenv("COSMOSH_INPUT_ORDER_PID"))
		boundary := Boundary{Epoch: os.Getenv("COSMOSH_INPUT_ORDER_EPOCH")}
		if !ClaimFD(3, pid, boundary, firstRequest) {
			os.Exit(2)
		}
		os.Exit(0)
	}
	store, boundary := newTestStore(t)
	if approved, err := store.Authorize(context.Background(), firstRequest, 0); err != nil || !approved {
		t.Fatalf("authorization failed: %v %v", approved, err)
	}
	fd := readOnlyFD(t, store.Path())
	command := exec.Command(os.Args[0], "-test.run=^TestInheritedLockSurvivesOneShotHelperExit$")
	command.ExtraFiles = []*os.File{fd}
	command.Env = append(os.Environ(),
		"COSMOSH_INPUT_ORDER_CHILD=1",
		"COSMOSH_INPUT_ORDER_PID="+strconv.Itoa(os.Getpid()),
		"COSMOSH_INPUT_ORDER_EPOCH="+boundary.Epoch)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("one-shot claim failed: %v %s", err, output)
	}
	if CheckBoundary(os.Getpid(), boundary) {
		t.Fatal("helper exit released the parent Shell's inherited OFD lock")
	}
	if err := UnlockFD(int(fd.Fd())); err != nil {
		t.Fatal(err)
	}
	if !CheckBoundary(os.Getpid(), boundary) {
		t.Fatal("explicit unlock did not release the parent lock")
	}
}

func TestClosePreservesOtherSessionAndOwnedPath(t *testing.T) {
	first, boundary := newTestStore(t)
	second, _ := newTestStore(t)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(first.Path()); !os.IsNotExist(err) {
		t.Fatalf("closed session record remains: %v", err)
	}
	if _, err := os.Lstat(second.Path()); err != nil {
		t.Fatalf("other session record was removed: %v", err)
	}
	if _, err := Path(strings.ToUpper(boundary.Epoch)); err == nil {
		t.Fatal("noncanonical UUID accepted")
	}
}

func TestBlockedMetadataLockTimesOutWithoutForwarding(t *testing.T) {
	store, boundary := newTestStore(t)
	fd := readOnlyFD(t, store.Path())
	if !ClaimReadFD(int(fd.Fd()), os.Getpid(), boundary) {
		t.Fatal("cannot hold inherited lock for timeout test")
	}
	started := time.Now()
	if err := store.Receive(context.Background(), 1); err == nil {
		t.Fatal("blocked receiver advanced input without the lock")
	}
	if time.Since(started) < authorizationTTL {
		t.Fatal("blocked receiver failed before its bounded lock wait")
	}
	if err := UnlockFD(int(fd.Fd())); err != nil {
		t.Fatal(err)
	}
	if !CheckBoundary(os.Getpid(), boundary) {
		t.Fatal("timed-out receiver changed metadata")
	}
}
