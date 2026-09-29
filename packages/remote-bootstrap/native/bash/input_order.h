/* SPDX-License-Identifier: GPL-3.0-only
 * Shared input-free metadata. Keep this fixed record aligned with internal/inputorder.
 */
#ifndef COSMOSH_INPUT_ORDER_H
#define COSMOSH_INPUT_ORDER_H
#include <fcntl.h>
#include <sys/file.h>

/** Decode one eight-byte metadata integer without alignment or host-endian assumptions. */
static uint64_t order_number(const unsigned char *value) {
  uint64_t result = 0;
  for (size_t index = 0; index < 8; index++) result = (result << 8) | value[index];
  return result;
}

/** Validate canonical v4 identifiers before deriving a pathname or accepting authority. */
static int order_uuid(const char *value) {
  return uuid(value) && value[14] == '4' && strchr("89ab", value[19]) != NULL;
}

/** Require the exact private regular-file shape; no symlink, shared hardlink or writable mode is accepted. */
static int order_file(const struct stat *value) {
  return S_ISREG(value->st_mode) && (value->st_mode & 07777) == 0600 && value->st_uid == getuid() &&
    value->st_nlink == 1 && value->st_size == 128;
}

/** Validate every field before using a received/delivered boundary. This record never contains command text. */
static int order_record(int fd, const char *epoch, uint64_t sequence, unsigned char *record) {
  if (pread(fd, record, 128, 0) != 128 || memcmp(record, "CSORDER1", 8) || memcmp(record + 8, epoch, 36) ||
      record[44] || record[45] || record[46] || record[47] || record[117] || record[118] || record[119] ||
      sequence > 9007199254740991ULL || order_number(record + 48) != (uint64_t)getpid() ||
      order_number(record + 56) != sequence || order_number(record + 64) != sequence ||
      order_number(record + 72) > sequence) return 0;
  if (record[116] == 0) {
    for (size_t index = 72; index < 116; index++) if (record[index]) return 0;
    return order_number(record + 120) == 0;
  }
  char id[37]; memcpy(id, record + 80, 36); id[36] = 0;
  if (!order_uuid(id)) return 0;
  return (record[116] == 1 && order_number(record + 72) == sequence && order_number(record + 120) != 0) ||
    (record[116] == 2 && order_number(record + 120) == 0);
}

/** Open an independent description and try the lock once; never wait inside Readline for the forwarder. */
static int order_lock(const char *epoch, uint64_t sequence) {
  char directory[80], basename[48];
  struct stat before, opened, entry;
  if (!order_uuid(epoch)) return -1;
  snprintf(directory, sizeof(directory), "/tmp/cosmosh-input-%lu", (unsigned long)getuid());
  snprintf(basename, sizeof(basename), "%s.state", epoch);
  if (lstat(directory, &before) || !S_ISDIR(before.st_mode) || before.st_uid != getuid() ||
      (before.st_mode & 07777) != 0700) return -1;
  int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) return -1;
  int fd = -1, valid = 0;
  if (fstat(parent, &opened) || before.st_dev != opened.st_dev || before.st_ino != opened.st_ino) goto done;
  fd = openat(parent, basename, O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &opened) || !order_file(&opened) || flock(fd, LOCK_EX | LOCK_NB)) goto done;
  if (fstatat(parent, basename, &entry, AT_SYMLINK_NOFOLLOW) || !order_file(&entry) ||
      opened.st_dev != entry.st_dev || opened.st_ino != entry.st_ino) goto done;
  unsigned char record[128];
  valid = order_record(fd, epoch, sequence, record);
done:
  close(parent);
  if (!valid && fd >= 0) { close(fd); fd = -1; }
  return fd;
}

/** Consume one live authorization while its inode remains exclusively locked until native assignment ends. */
static int order_consume(int fd, const char *epoch, uint64_t sequence, const char *request) {
  unsigned char record[128]; struct timespec now;
  if (!order_record(fd, epoch, sequence, record) || record[116] != 1 || memcmp(record + 80, request, 36) ||
      clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 ||
      (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec >= order_number(record + 120)) return 0;
  record[116] = 2;
  memset(record + 120, 0, 8);
  return pwrite(fd, record, 128, 0) == 128;
}
#endif
