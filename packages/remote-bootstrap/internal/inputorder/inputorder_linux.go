//go:build linux

// Package inputorder owns session-scoped, input-free authorization metadata.
package inputorder

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	recordSize       = 128
	maxSequence      = uint64(1<<53 - 1)
	maxPID           = uint64(1<<31 - 1)
	authorizationTTL = 1500 * time.Millisecond
	stateNone        = byte(0)
	stateAuthorized  = byte(1)
	stateConsumed    = byte(2)
)

var (
	errInvalid     = errors.New("input-order-invalid")
	errUnavailable = errors.New("input-order-unavailable")
	uuidPattern    = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
)

// Boundary identifies one remote session and its complete input delivery point.
type Boundary struct {
	Epoch    string `json:"epoch"`
	Sequence uint64 `json:"sequence"`
}

type record struct {
	epoch        string
	pid          uint64
	received     uint64
	delivered    uint64
	authSequence uint64
	requestID    string
	authState    byte
	expiryNS     uint64
}

// Store pins one owned metadata inode for the life of a forwarded Shell.
type Store struct {
	mu        sync.RWMutex
	path      string
	directory string
	file      *os.File
	fileInfo  os.FileInfo
	dirInfo   os.FileInfo
	epoch     string
	closed    bool
}

// Path returns the predictable path only for a canonical session UUID.
func Path(epoch string) (string, error) {
	if !uuidPattern.MatchString(epoch) {
		return "", errInvalid
	}
	return filepath.Join(directoryPath(), epoch+".state"), nil
}

// Path returns the Store's fixed metadata location without exposing input.
func (store *Store) Path() string { return store.path }

func directoryPath() string {
	return filepath.Join("/tmp", "cosmosh-input-"+strconv.Itoa(os.Geteuid()))
}

func ownedDirectory(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&^os.ModeDir != 0o700 {
		return nil, errUnavailable
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, errUnavailable
	}
	return info, nil
}

func ownedFile(info os.FileInfo) bool {
	if info == nil || info.Mode() != 0o600 || info.Size() != recordSize {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid()) && stat.Nlink == 1
}

func openExclusive(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, errUnavailable
	}
	return os.NewFile(uintptr(fd), path), nil
}

func openExisting(path string) (*os.File, os.FileInfo, error) {
	before, err := os.Lstat(path)
	if err != nil || !ownedFile(before) {
		return nil, nil, errUnavailable
	}
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, errUnavailable
	}
	file := os.NewFile(uintptr(fd), path)
	opened, err := file.Stat()
	if err != nil || !ownedFile(opened) || !os.SameFile(before, opened) {
		_ = file.Close()
		return nil, nil, errUnavailable
	}
	return file, opened, nil
}

func samePath(path string, original os.FileInfo) bool {
	current, err := os.Lstat(path)
	return err == nil && ownedFile(current) && os.SameFile(original, current)
}

// Create exclusively initializes a fixed 128-byte record before any Shell starts.
func Create(epoch string) (*Store, error) {
	path, err := Path(epoch)
	if err != nil {
		return nil, err
	}
	directory := directoryPath()
	if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, errUnavailable
	}
	dirInfo, err := ownedDirectory(directory)
	if err != nil {
		return nil, err
	}
	file, err := openExclusive(path)
	if err != nil {
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = file.Close()
			_ = os.Remove(path)
		}
	}()
	if err := file.Truncate(recordSize); err != nil {
		return nil, errUnavailable
	}
	if err := file.Chmod(0o600); err != nil {
		return nil, errUnavailable
	}
	info, err := file.Stat()
	if err != nil || !ownedFile(info) || !samePath(path, info) {
		return nil, errUnavailable
	}
	if err := writeRecord(file, record{epoch: epoch}); err != nil {
		return nil, err
	}
	cleanup = false
	return &Store{path: path, directory: directory, file: file, fileInfo: info, dirInfo: dirInfo, epoch: epoch}, nil
}

func encode(value record) ([recordSize]byte, error) {
	var result [recordSize]byte
	if !uuidPattern.MatchString(value.epoch) || value.pid > maxPID ||
		value.received > maxSequence || value.delivered > value.received ||
		value.authSequence > maxSequence || value.authSequence > value.received {
		return result, errInvalid
	}
	switch value.authState {
	case stateNone:
		if value.authSequence != 0 || value.requestID != "" || value.expiryNS != 0 {
			return result, errInvalid
		}
	case stateAuthorized:
		if !uuidPattern.MatchString(value.requestID) || value.expiryNS == 0 ||
			value.authSequence != value.received || value.received != value.delivered || value.pid == 0 {
			return result, errInvalid
		}
	case stateConsumed:
		if !uuidPattern.MatchString(value.requestID) || value.expiryNS != 0 {
			return result, errInvalid
		}
	default:
		return result, errInvalid
	}
	copy(result[:8], "CSORDER1")
	copy(result[8:44], value.epoch)
	binary.BigEndian.PutUint64(result[48:56], value.pid)
	binary.BigEndian.PutUint64(result[56:64], value.received)
	binary.BigEndian.PutUint64(result[64:72], value.delivered)
	binary.BigEndian.PutUint64(result[72:80], value.authSequence)
	copy(result[80:116], value.requestID)
	result[116] = value.authState
	binary.BigEndian.PutUint64(result[120:128], value.expiryNS)
	return result, nil
}

func decode(data []byte) (record, error) {
	if len(data) != recordSize || string(data[:8]) != "CSORDER1" {
		return record{}, errInvalid
	}
	for _, offset := range []int{44, 45, 46, 47, 117, 118, 119} {
		if data[offset] != 0 {
			return record{}, errInvalid
		}
	}
	value := record{
		epoch:        string(data[8:44]),
		pid:          binary.BigEndian.Uint64(data[48:56]),
		received:     binary.BigEndian.Uint64(data[56:64]),
		delivered:    binary.BigEndian.Uint64(data[64:72]),
		authSequence: binary.BigEndian.Uint64(data[72:80]),
		authState:    data[116],
		expiryNS:     binary.BigEndian.Uint64(data[120:128]),
	}
	if value.authState != stateNone {
		value.requestID = string(data[80:116])
	} else {
		for _, part := range data[80:116] {
			if part != 0 {
				return record{}, errInvalid
			}
		}
	}
	encoded, err := encode(value)
	if err != nil || string(encoded[:]) != string(data) {
		return record{}, errInvalid
	}
	return value, nil
}

func readRecord(file *os.File) (record, error) {
	var data [recordSize]byte
	n, err := file.ReadAt(data[:], 0)
	if err != nil || n != len(data) {
		return record{}, errUnavailable
	}
	return decode(data[:])
}

func writeRecord(file *os.File, value record) error {
	data, err := encode(value)
	if err != nil {
		return err
	}
	n, err := file.WriteAt(data[:], 0)
	if err != nil || n != len(data) {
		return errUnavailable
	}
	return nil
}

func lock(ctx context.Context, fd int) error {
	for {
		if ctx.Err() != nil {
			return errUnavailable
		}
		err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN && err != syscall.EINTR {
			return errUnavailable
		}
		timer := time.NewTimer(2 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errUnavailable
		case <-timer.C:
		}
	}
}

func tryLock(fd int) error {
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errUnavailable
	}
	return nil
}

func unlock(fd int) {
	_ = syscall.Flock(fd, syscall.LOCK_UN)
}

func monotonicNS() (uint64, error) {
	var value syscall.Timespec
	_, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&value)), 0)
	if errno != 0 || value.Sec < 0 || value.Nsec < 0 || value.Nsec >= 1e9 {
		return 0, errUnavailable
	}
	return uint64(value.Sec)*1e9 + uint64(value.Nsec), nil
}

func (store *Store) update(ctx context.Context, change func(*record) error) error {
	ctx, cancel := context.WithTimeout(ctx, authorizationTTL)
	defer cancel()
	store.mu.RLock()
	defer store.mu.RUnlock()
	if store.closed {
		return errUnavailable
	}
	file, info, err := openExisting(store.path)
	if err != nil {
		return err
	}
	defer file.Close()
	if !os.SameFile(info, store.fileInfo) || !samePath(store.path, store.fileInfo) {
		return errUnavailable
	}
	if err := lock(ctx, int(file.Fd())); err != nil {
		return err
	}
	defer unlock(int(file.Fd()))
	if ctx.Err() != nil {
		return errUnavailable
	}
	if !samePath(store.path, store.fileInfo) {
		return errUnavailable
	}
	value, err := readRecord(file)
	if err != nil || value.epoch != store.epoch {
		return errUnavailable
	}
	if err := change(&value); err != nil {
		return err
	}
	if !samePath(store.path, store.fileInfo) {
		return errUnavailable
	}
	if ctx.Err() != nil {
		return errUnavailable
	}
	return writeRecord(file, value)
}

// SetShellPID records the original child only once, after spawn and before ready.
func (store *Store) SetShellPID(pid int) error {
	if pid <= 0 || uint64(pid) > maxPID {
		return errInvalid
	}
	return store.update(context.Background(), func(value *record) error {
		if value.pid != 0 {
			return errInvalid
		}
		value.pid = uint64(pid)
		return nil
	})
}

// Receive claims input before any PTY write and invalidates an outstanding edit.
func (store *Store) Receive(ctx context.Context, sequence uint64) error {
	return store.update(ctx, func(value *record) error {
		if value.pid == 0 || sequence == 0 || sequence > maxSequence || sequence != value.received+1 {
			return errInvalid
		}
		value.received = sequence
		if value.authState != stateNone {
			value.authState = stateConsumed
			value.expiryNS = 0
		}
		return nil
	})
}

// Deliver advances only after the complete PTY write has returned.
func (store *Store) Deliver(ctx context.Context, sequence uint64) error {
	return store.update(ctx, func(value *record) error {
		if value.pid == 0 || sequence == 0 || sequence != value.delivered+1 || sequence > value.received {
			return errInvalid
		}
		value.delivered = sequence
		return nil
	})
}

// Authorize grants one bounded, single-use exact-sequence edit.
func (store *Store) Authorize(ctx context.Context, requestID string, sequence uint64) (bool, error) {
	if !uuidPattern.MatchString(requestID) || sequence > maxSequence {
		return false, errInvalid
	}
	approved := false
	err := store.update(ctx, func(value *record) error {
		if value.pid == 0 || sequence != value.received || sequence != value.delivered ||
			requestID == value.requestID {
			return nil
		}
		now, err := monotonicNS()
		if err != nil || now > ^uint64(0)-uint64(authorizationTTL) {
			return errUnavailable
		}
		value.authSequence = sequence
		value.requestID = requestID
		value.authState = stateAuthorized
		value.expiryNS = now + uint64(authorizationTTL)
		approved = true
		return nil
	})
	return approved, err
}

// Revoke consumes only the matching authorization; another request is untouched.
func (store *Store) Revoke(ctx context.Context, requestID string) error {
	if !uuidPattern.MatchString(requestID) {
		return errInvalid
	}
	return store.update(ctx, func(value *record) error {
		if value.requestID == requestID && value.authState == stateAuthorized {
			value.authState = stateConsumed
			value.expiryNS = 0
		}
		return nil
	})
}

func openBoundary(pid int, boundary Boundary) (*os.File, os.FileInfo, record, error) {
	path, err := Path(boundary.Epoch)
	if err != nil || pid <= 0 || uint64(pid) > maxPID || boundary.Sequence > maxSequence {
		return nil, nil, record{}, errInvalid
	}
	if _, err := ownedDirectory(filepath.Dir(path)); err != nil {
		return nil, nil, record{}, err
	}
	file, info, err := openExisting(path)
	if err != nil {
		return nil, nil, record{}, err
	}
	value, err := readRecord(file)
	if err != nil || value.epoch != boundary.Epoch || value.pid != uint64(pid) {
		_ = file.Close()
		return nil, nil, record{}, errUnavailable
	}
	return file, info, value, nil
}

func matchesBoundary(value record, boundary Boundary) bool {
	return value.epoch == boundary.Epoch && value.received == boundary.Sequence &&
		value.delivered == boundary.Sequence
}

// CheckBoundary observes a delivered boundary without holding a lock afterward.
func CheckBoundary(pid int, boundary Boundary) bool {
	file, info, _, err := openBoundary(pid, boundary)
	if err != nil {
		return false
	}
	defer file.Close()
	if tryLock(int(file.Fd())) != nil {
		return false
	}
	defer unlock(int(file.Fd()))
	value, err := readRecord(file)
	return err == nil && samePath(file.Name(), info) && value.pid == uint64(pid) &&
		matchesBoundary(value, boundary)
}

func claim(fd, pid int, boundary Boundary, requestID string, authorized bool) bool {
	file, info, _, err := openBoundary(pid, boundary)
	if err != nil {
		return false
	}
	defer file.Close()
	var inherited syscall.Stat_t
	if syscall.Fstat(fd, &inherited) != nil {
		return false
	}
	owned, ok := info.Sys().(*syscall.Stat_t)
	if !ok || inherited.Dev != owned.Dev || inherited.Ino != owned.Ino ||
		inherited.Uid != uint32(os.Geteuid()) || inherited.Nlink != 1 ||
		inherited.Size != recordSize || inherited.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return false
	}
	if tryLock(fd) != nil {
		return false
	}
	success := false
	defer func() {
		if !success {
			unlock(fd)
		}
	}()
	if !samePath(file.Name(), info) {
		return false
	}
	value, err := readRecord(file)
	if err != nil || value.pid != uint64(pid) || !matchesBoundary(value, boundary) {
		return false
	}
	if authorized {
		now, err := monotonicNS()
		if err != nil || value.authState != stateAuthorized || value.requestID != requestID ||
			value.authSequence != boundary.Sequence || now >= value.expiryNS {
			return false
		}
		value.authState = stateConsumed
		value.expiryNS = 0
		if writeRecord(file, value) != nil {
			return false
		}
	}
	success = true
	return true
}

// ClaimFD consumes one authorized edit and leaves the parent's inherited OFD locked.
// The caller must close its scoped descriptor or invoke UnlockFD after local mutation.
func ClaimFD(fd, originalPID int, boundary Boundary, requestID string) bool {
	return uuidPattern.MatchString(requestID) && claim(fd, originalPID, boundary, requestID, true)
}

// ClaimReadFD holds the same ordering boundary for a local read-only capture.
func ClaimReadFD(fd, originalPID int, boundary Boundary) bool {
	return claim(fd, originalPID, boundary, "", false)
}

// UnlockFD releases a successful inherited-FD claim before any network or redraw.
func UnlockFD(fd int) error {
	if fd < 0 || syscall.Flock(fd, syscall.LOCK_UN) != nil {
		return errUnavailable
	}
	return nil
}

// Close removes only the metadata inode owned by this Store.
func (store *Store) Close() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return nil
	}
	store.closed = true
	_ = store.file.Close()
	if samePath(store.path, store.fileInfo) {
		if err := os.Remove(store.path); err != nil {
			return errUnavailable
		}
	}
	if current, err := ownedDirectory(store.directory); err == nil && os.SameFile(current, store.dirInfo) {
		_ = os.Remove(store.directory) // Other sessions may still own records.
	}
	return nil
}
