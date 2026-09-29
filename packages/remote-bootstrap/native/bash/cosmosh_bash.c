/* SPDX-License-Identifier: GPL-3.0-only
 * Readline idle adapter. No signal handler, terminal key injection, Shell evaluation, or blocking I/O.
 * The small exported ABI declarations follow GNU Bash 5.1 builtins.h/command.h and
 * lib/readline/{readline,history}.h. Runtime symbols are all resolved before installation.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <langinfo.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <wchar.h>

typedef struct word_desc { char *word; int flags; } WORD_DESC;
typedef struct word_list { struct word_list *next; WORD_DESC *word; } WORD_LIST;
struct builtin {
  char *name;
  int (*function)(WORD_LIST *);
  int flags;
  char *const *long_doc;
  const char *short_doc;
  char *handle;
};
typedef struct history_entry { char *line; char *timestamp; void *data; } HIST_ENTRY;
typedef int (*idle_hook)(void);
typedef void (*terminal_hook)(void);

enum { MAX_FRAME = 256 * 1024, COSMOSH_MAX_INPUT = 8192, MAX_PATH = 4096, MAX_HISTORY = 200, HISTORY_BYTES = 65536,
  DELETE_SCAN_ENTRIES = 10000, DELETE_SCAN_BYTES = 8 * 1024 * 1024, DELETE_MATCHES = 200 };
enum { READCMD = 0x8, TERMPREPPED = 0x4, SIGHANDLER = 0x8000 };
/* Nested key readers, search, macros, completion, signal handling, and finished readers cannot observe input. */
static const unsigned long permitted_states = 0x2 | READCMD | TERMPREPPED | 0x2000 | 0x40000;

static struct {
  char *(*variable)(const char *);
  idle_hook *hook, *signal_hook, *startup_hook;
  terminal_hook *deprep;
  void **isearch_context;
  int (*isearch_cleanup)(void *, int);
  unsigned long *state;
  char **line;
  int *point, *end, *editing_mode, *history_enabled, *history_length, *promptvars;
  int *executing_builtin, *running_trap, *dispatching;
  FILE **input;
  int (*begin_undo)(void), (*end_undo)(void), (*delete_text)(int, int), (*insert_text)(const char *);
  void (*redisplay)(void);
  HIST_ENTRY **(*history_list)(void);
  HIST_ENTRY *(*current_history)(void);
  int (*where_history)(void), (*history_set_pos)(int);
  int (*delete_history_range)(int, int);
} api;

typedef struct { unsigned char data[MAX_FRAME + 4]; size_t length, offset; int error; } packet;
static packet incoming, outgoing, captured, comparison;
static idle_hook previous_hook, previous_startup_hook;
static terminal_hook previous_deprep;
static pid_t owner;
static uint64_t generation;
static char instance[37], start_time[21], request_id[37];
static char input_epoch[37];
static char history_target[COSMOSH_MAX_INPUT + 1], history_file[MAX_PATH + 1], history_size[65];
static uint64_t history_revision;
static int history_policy_seen, history_policy_enabled, history_previous_length;
static int history_untrusted;
static uint64_t input_sequence;
static int socket_fd = -1, armed, entered, phase, operation, include_directory;
static int startup_seen, loaded, retired;
static struct timespec started;
static int on_idle(void);
static int on_startup(void);
static void on_deprep(void);

/** Recheck callback ownership at each observation, including changes made by a prior startup hook. */
static int owns_hooks(void) {
  return loaded && !retired && owner == getpid() && api.hook && *api.hook == on_idle &&
    api.startup_hook && *api.startup_hook == on_startup && api.deprep && *api.deprep == on_deprep;
}

/** Return a validated decimal metadata value; user command text never enters this parser. */
static uint64_t decimal(const char *value) {
  uint64_t number = 0;
  if (!value || !*value) return 0;
  for (; *value; value++) {
    if (*value < '0' || *value > '9' || number > (UINT64_MAX - 9) / 10) return 0;
    number = number * 10 + (unsigned)(*value - '0');
  }
  return number;
}

/** Validate UUID metadata before constructing a user-owned socket pathname. */
static int uuid(const char *value) {
  if (!value || strlen(value) != 36) return 0;
  for (size_t index = 0; index < 36; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return 0;
    } else if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

#include "input_order.h"

/** Read only fixed non-secret Shell state. */
static int variable_equals(const char *name, const char *expected) {
  const char *value = api.variable(name);
  return value && strcmp(value, expected) == 0;
}

/** Wipe only initialized bytes before reusing a private packet. */
static void clear_packet(packet *value) {
  volatile unsigned char *bytes = value->data;
  for (size_t index = 0; index < value->length; index++) bytes[index] = 0;
  value->length = value->offset = 0;
  value->error = 0;
}

/** Release a canceled or completed exchange without waiting for the worker. */
static void reset_exchange(void) {
  if (socket_fd >= 0) close(socket_fd);
  socket_fd = -1;
  phase = operation = include_directory = 0;
  clear_packet(&incoming); clear_packet(&outgoing); clear_packet(&captured); clear_packet(&comparison);
  memset(request_id, 0, sizeof(request_id));
  memset(input_epoch, 0, sizeof(input_epoch)); input_sequence = 0;
  memset(history_target, 0, sizeof(history_target));
}

/** Append bounded bytes; an overflow invalidates the entire message. */
static void append(packet *value, const void *data, size_t length) {
  if (value->error || length > MAX_FRAME + 4 - value->length) { value->error = 1; return; }
  memcpy(value->data + value->length, data, length);
  value->length += length;
}

/** Encode a fixed-width unsigned integer in network byte order. */
static void number(packet *value, uint64_t integer, size_t width) {
  unsigned char encoded[8];
  for (size_t index = 0; index < width; index++) encoded[width - index - 1] = (unsigned char)(integer >> (index * 8));
  append(value, encoded, width);
}

/** Encode a bounded NUL-free string; NULL is the protocol's empty optional value. */
static void text(packet *value, const char *string, size_t maximum) {
  size_t length = string ? strnlen(string, maximum + 1) : 0;
  if (length > maximum) { value->error = 1; return; }
  number(value, length, 4);
  append(value, string ? string : "", length);
}

/** Start a fresh versioned record with space reserved for its length prefix. */
static void begin_packet(packet *value, unsigned opcode) {
  clear_packet(value);
  number(value, 0, 4); number(value, 2, 1); number(value, opcode, 1);
}

/** Finalize the length prefix after all field bounds have been checked. */
static int finish_packet(packet *value) {
  if (value->error || value->length < 6 || value->length > MAX_FRAME + 4) return 0;
  uint32_t length = (uint32_t)(value->length - 4);
  for (size_t index = 0; index < 4; index++) value->data[3 - index] = (unsigned char)(length >> (index * 8));
  return 1;
}

/** Decode only complete numeric fields; caller later requires no trailing bytes. */
static uint64_t read_number(packet *value, size_t width) {
  uint64_t result = 0;
  if (value->error || width > value->length - value->offset) { value->error = 1; return 0; }
  for (size_t index = 0; index < width; index++) result = (result << 8) | value->data[value->offset++];
  return result;
}

/** Copy one complete string into caller-owned storage, rejecting embedded NUL bytes. */
static int read_text(packet *value, char *destination, size_t capacity) {
  uint64_t length = read_number(value, 4);
  if (value->error || length >= capacity || length > value->length - value->offset ||
      memchr(value->data + value->offset, 0, (size_t)length)) { value->error = 1; return 0; }
  memcpy(destination, value->data + value->offset, (size_t)length);
  destination[length] = 0;
  value->offset += (size_t)length;
  return 1;
}

/** Validate UTF-8 using the Shell's qualified locale and translate an exact byte cursor to codepoints. */
static int characters(const char *string, size_t maximum, int byte_point, int controls, uint32_t *cursor) {
  size_t length = strnlen(string, maximum + 1), offset = 0;
  uint32_t count = 0;
  int found = byte_point == 0;
  mbstate_t state = {0};
  if (length > maximum || byte_point < 0 || (size_t)byte_point > length) return 0;
  *cursor = 0;
  while (offset < length) {
    wchar_t character;
    size_t bytes = mbrtowc(&character, string + offset, length - offset, &state);
    if (bytes == (size_t)-1 || bytes == (size_t)-2 || bytes == 0 ||
        (controls && ((character < 32 && character != '\t') || (character >= 127 && character <= 159)))) return 0;
    offset += bytes;
    count++;
    if (offset == (size_t)byte_point) { *cursor = count; found = 1; }
  }
  return found;
}

/** Require the original primary Readline reader, foreground terminal and an empty kernel input queue. */
static int eligible(void) {
  int pending = -1;
  struct termios attributes;
  unsigned long state = *api.state;
  if (!armed || !startup_seen || !owns_hooks() || *api.executing_builtin || *api.running_trap ||
      *api.editing_mode != 1 || (state & ~permitted_states) || !*api.promptvars ||
      (state & (READCMD | TERMPREPPED)) != (READCMD | TERMPREPPED) || !api.input || !*api.input ||
      fileno(*api.input) != STDIN_FILENO || tcgetpgrp(STDIN_FILENO) != getpgrp() ||
      tcgetattr(STDIN_FILENO, &attributes) || (attributes.c_lflag & ICANON) ||
      ioctl(STDIN_FILENO, FIONREAD, &pending) || pending != 0 ||
      strcmp(nl_langinfo(CODESET), "UTF-8") != 0 ||
      !variable_equals("__COSMOSH_EDITOR_AVAILABLE", "true") ||
      !variable_equals("__COSMOSH_BASH_PRIMARY", "1") || !variable_equals("__COSMOSH_BASH_PREEXEC_READY", "1") ||
      decimal(api.variable("__COSMOSH_PROMPT_GENERATION")) != generation) return 0;
  const char *ps2 = api.variable("PS2"), *marker = api.variable("__COSMOSH_PS2_MARKER");
  return ps2 && marker && *marker && strncmp(ps2, marker, strlen(marker)) == 0;
}

/** Capture actual directory identity without invoking any Shell function or subprocess. */
static int capture_directory(packet *value) {
  char physical[MAX_PATH + 1];
  const char *logical = api.variable("PWD"), *home = api.variable("HOME");
  uint32_t ignored;
  /* Kernel cwd metadata needs no traversal of a potentially remote user pathname. The worker
   * validates this physical path outside the interactive process with a bounded deadline.
   */
  ssize_t length = readlink("/proc/self/cwd", physical, sizeof(physical));
  if (length <= 0 || (size_t)length >= sizeof(physical)) return 0;
  physical[length] = 0;
  if (!logical || logical[0] != '/' || !characters(logical, MAX_PATH, 0, 0, &ignored) ||
      !characters(physical, MAX_PATH, 0, 0, &ignored)) return 0;
  if (!home || home[0] != '/' || !characters(home, MAX_PATH, 0, 0, &ignored)) home = "";
  text(value, logical, MAX_PATH); text(value, physical, MAX_PATH); text(value, home, MAX_PATH);
  return !value->error;
}

/** Rotate opaque source identity when storage policy changes or the list contracts. */
static int history_namespace(char *namespace, size_t capacity) {
  const char *file = api.variable("HISTFILE"), *size = api.variable("HISTSIZE");
  size_t file_length = file ? strnlen(file, MAX_PATH + 1) : 0;
  size_t size_length = size ? strnlen(size, sizeof(history_size)) : 0;
  if (file_length > MAX_PATH || size_length >= sizeof(history_size) || history_revision == UINT64_MAX) return 0;
  int enabled = *api.history_enabled, length = *api.history_length;
  if (length < 0 || length > 10000000) return 0;
  if (!history_policy_seen || enabled != history_policy_enabled || length < history_previous_length ||
      strcmp(file ? file : "", history_file) || strcmp(size ? size : "", history_size)) {
    history_revision++;
    memcpy(history_file, file ? file : "", file_length + 1);
    memcpy(history_size, size ? size : "", size_length + 1);
    history_policy_enabled = enabled;
    history_policy_seen = 1;
  }
  history_previous_length = length;
  int written = snprintf(namespace, capacity, "%s:%llu", instance, (unsigned long long)history_revision);
  return written > 0 && (size_t)written < capacity;
}

/** Refuse partial deletion when the complete original reader exceeds its bounded scan. */
static int exact_history_matches(const char *target, int *matches, int *temporary) {
  int length = *api.history_length;
  HIST_ENTRY **list = api.history_list();
  size_t bytes = 0;
  *matches = 0;
  *temporary = 0;
  if (history_untrusted || length < 0 || length > DELETE_SCAN_ENTRIES || (length && !list)) return 0;
  for (int index = length - 1; index >= 0; index--) {
    const char *entry = list[index] ? list[index]->line : NULL;
    if (!entry) return 0;
    if (list[index]->data) *temporary = 1;
    size_t size = strnlen(entry, COSMOSH_MAX_INPUT + 1);
    if (size > COSMOSH_MAX_INPUT || bytes + size > DELETE_SCAN_BYTES) return 0;
    bytes += size;
    if (strcmp(entry, target) == 0 && ++*matches > DELETE_MATCHES) return 0;
  }
  return 1;
}

/** Read Bash's accepted in-memory history, newest first; exact deletion reads one target. */
static int capture_history(packet *value) {
  const char *file = api.variable("HISTFILE");
  char namespace[64];
  if (history_untrusted || !history_namespace(namespace, sizeof(namespace))) return 0;
  if (!*api.history_enabled || !file || !*file) {
    number(value, 3, 1); text(value, "", MAX_PATH); number(value, 0, 4); return !value->error;
  }
  if (operation == 5) {
    int matches, temporary;
    if (!exact_history_matches(history_target, &matches, &temporary)) return 0;
    int offset = api.where_history();
    if (offset < 0 || offset > *api.history_length) return 0;
    if (temporary || (offset < *api.history_length &&
        strcmp(api.history_list()[offset]->line, history_target) == 0)) {
      /* Readline may hold unsubmitted edits in history entries or write the active line back. */
      number(value, 4, 1); text(value, "", 63); number(value, 0, 4);
      return !value->error;
    }
    number(value, 1, 1); text(value, namespace, 63); number(value, matches ? 1 : 0, 4);
    if (matches) text(value, history_target, COSMOSH_MAX_INPUT);
    return !value->error;
  }
  HIST_ENTRY **list = api.history_list();
  int length = *api.history_length, count = 0, partial = 0;
  size_t total = 0;
  const char *entries[MAX_HISTORY];
  if (length < 0 || length > 10000000 || (length && !list)) return 0;
  for (int index = length - 1; index >= 0; index--) {
    if (length - index > 2000) { partial = 1; break; }
    uint32_t ignored;
    const char *entry = list[index] ? list[index]->line : NULL;
    /* Readline replaces edited recalled entries and stores their undo list in data. */
    if (list[index] && list[index]->data) { partial = 1; continue; }
    if (!entry || !*entry || *entry == ' ') continue;
    size_t bytes = strnlen(entry, COSMOSH_MAX_INPUT + 1);
    if (count == MAX_HISTORY || total + bytes > HISTORY_BYTES) { partial = 1; break; }
    if (!characters(entry, COSMOSH_MAX_INPUT, 0, 0, &ignored)) { partial = 1; continue; }
    entries[count++] = entry;
    total += bytes;
  }
  number(value, partial ? 2 : 1, 1); text(value, namespace, 63); number(value, (unsigned)count, 4);
  for (int index = 0; index < count; index++) text(value, entries[index], COSMOSH_MAX_INPUT);
  return !value->error;
}

/** Read only the fields granted by this request; metadata-only requests never inspect rl_line_buffer. */
static int capture_snapshot(packet *value) {
  int input = operation == 2 || operation == 3;
  begin_packet(value, 3);
  number(value, generation, 8); number(value, 1, 1);
  number(value, (input ? 1 : 0) | (include_directory ? 2 : 0) | ((operation == 4 || operation == 5) ? 4 : 0), 1);
  if (input) {
    uint32_t cursor;
    if (!*api.line || !characters(*api.line, COSMOSH_MAX_INPUT, *api.point, 1, &cursor) || *api.end < 0 ||
        (size_t)*api.end != strlen(*api.line)) return 0;
    text(value, *api.line, COSMOSH_MAX_INPUT); number(value, cursor, 4);
  }
  if (include_directory && !capture_directory(value)) return 0;
  if ((operation == 4 || operation == 5) && !capture_history(value)) return 0;
  return finish_packet(value);
}

/** Connect only to the protected user-owned endpoint, with a nonblocking descriptor and no retries inside a hook. */
static int open_exchange(void) {
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  char directory[80];
  struct stat info;
  snprintf(directory, sizeof(directory), "/tmp/cosmosh-editor-%lu", (unsigned long)getuid());
  if (lstat(directory, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0700) return 0;
  int length = snprintf(address.sun_path, sizeof(address.sun_path), "%s/%s.sock", directory, instance);
  if (length < 0 || (size_t)length >= sizeof(address.sun_path) || lstat(address.sun_path, &info) ||
      !S_ISSOCK(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0600) return 0;
  socket_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (socket_fd < 0) return 0;
  if (connect(socket_fd, (struct sockaddr *)&address, sizeof(address))) { reset_exchange(); return 0; }
  struct ucred peer;
  socklen_t size = sizeof(peer);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof(peer) || peer.uid != getuid() ||
      clock_gettime(CLOCK_MONOTONIC, &started)) { reset_exchange(); return 0; }
  begin_packet(&outgoing, 1);
  number(&outgoing, (uint32_t)owner, 4); number(&outgoing, generation, 8);
  text(&outgoing, instance, 36); text(&outgoing, start_time, 20);
  phase = 1;
  return finish_packet(&outgoing);
}

/** Apply only under the forwarder's input lock; no pending signal can longjmp past descriptor cleanup. */
static int apply_record(packet *value) {
  char id[37], replacement[COSMOSH_MAX_INPUT + 1];
  if (!read_text(value, id, sizeof(id)) || !read_text(value, replacement, sizeof(replacement))) return 0;
  uint64_t requested = read_number(value, 4);
  if (value->error || value->offset != value->length || strcmp(id, request_id) || operation != 3) return 0;
  uint32_t ignored;
  if (!characters(replacement, COSMOSH_MAX_INPUT, 0, 1, &ignored)) return 0;
  size_t offset = 0, length = strlen(replacement);
  mbstate_t state = {0};
  for (uint64_t count = 0; count < requested; count++) {
    if (offset >= length) return 0;
    size_t bytes = mbrlen(replacement + offset, length - offset, &state);
    if (bytes == (size_t)-1 || bytes == (size_t)-2 || bytes == 0) return 0;
    offset += bytes;
  }
  sigset_t blocked, previous;
  sigfillset(&blocked);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous)) return 0;
  int fd = order_lock(input_epoch, input_sequence);
  int unchanged = fd >= 0 && eligible() && capture_snapshot(&comparison) && comparison.length == captured.length &&
    memcmp(comparison.data, captured.data, captured.length) == 0 && order_consume(fd, input_epoch, input_sequence, request_id);
  unsigned status = 2;
  if (unchanged) {
    api.begin_undo();
    api.delete_text(0, *api.end);
    *api.point = 0;
    api.insert_text(replacement);
    *api.point = (int)offset;
    api.end_undo();
    status = *api.line && strcmp(*api.line, replacement) == 0 && *api.point == (int)offset ? 1 : 3;
  }
  if (fd >= 0) close(fd);
  sigprocmask(SIG_SETMASK, &previous, NULL);
  begin_packet(&outgoing, 5); number(&outgoing, status, 1);
  if (unchanged) api.redisplay();
  phase = 3;
  return finish_packet(&outgoing);
}

/** Use Bash's own range deletion so its session-history counter stays consistent. */
static int delete_history_record(packet *value) {
  char id[37];
  if (!read_text(value, id, sizeof(id)) || value->offset != value->length ||
      strcmp(id, request_id) || operation != 5) return 0;
  sigset_t blocked, previous;
  sigfillset(&blocked);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous)) return 0;
  int fd = order_lock(input_epoch, input_sequence);
  int unchanged = fd >= 0 && eligible() && capture_snapshot(&comparison) &&
    comparison.length == captured.length && memcmp(comparison.data, captured.data, captured.length) == 0;
  int offset = api.where_history();
  if (offset < 0 || offset > *api.history_length ||
      (offset < *api.history_length && strcmp(api.history_list()[offset]->line, history_target) == 0)) unchanged = 0;
  unsigned status = 2;
  int matches = 0, temporary = 0;
  if (unchanged && !exact_history_matches(history_target, &matches, &temporary)) unchanged = 0;
  if (unchanged && !temporary && matches > 0 && order_consume(fd, input_epoch, input_sequence, request_id)) {
    status = 3;
    int removed = 0;
    for (int index = *api.history_length - 1; index >= 0; index--) {
      HIST_ENTRY **list = api.history_list();
      if (strcmp(list[index]->line, history_target)) continue;
      int before = *api.history_length;
      if (!api.delete_history_range(index, index) || *api.history_length != before - 1) break;
      if (index < offset) offset--;
      removed++;
    }
    /* GNU History does not adjust history_offset when removing a range. Keep the
     * same logical entry selected, or the new end position for an empty draft.
     */
    int position_valid = api.history_set_pos(offset);
    int remaining, final_temporary;
    if (position_valid && removed == matches &&
        exact_history_matches(history_target, &remaining, &final_temporary) &&
        remaining == 0 && !final_temporary) status = 1;
  }
  if (fd >= 0) close(fd);
  sigprocmask(SIG_SETMASK, &previous, NULL);
  begin_packet(&outgoing, 5); number(&outgoing, status, 1);
  phase = 3;
  return finish_packet(&outgoing);
}

/** Consume exactly one complete private message; unknown operations close the exchange without reading input. */
static int handle_record(void) {
  incoming.offset = 4;
  if (read_number(&incoming, 1) != 2) return 0;
  unsigned opcode = (unsigned)read_number(&incoming, 1);
  if (phase == 1 && opcode == 2) {
    operation = (int)read_number(&incoming, 1);
    include_directory = (int)read_number(&incoming, 1);
    if (!read_text(&incoming, request_id, sizeof(request_id)) || !order_uuid(request_id) ||
        !read_text(&incoming, input_epoch, sizeof(input_epoch)) || !order_uuid(input_epoch)) return 0;
    input_sequence = read_number(&incoming, 8);
    if (operation == 5 && (!read_text(&incoming, history_target, sizeof(history_target)) || !*history_target ||
        *history_target == ' ')) return 0;
    if (incoming.error ||
        incoming.offset != incoming.length || operation < 1 || operation > 5 || include_directory > 1 ||
        ((operation == 4 || operation == 5) && include_directory)) return 0;
    if (operation == 5) {
      uint32_t ignored;
      if (!characters(history_target, COSMOSH_MAX_INPUT, 0, 0, &ignored)) return 0;
    }
    sigset_t blocked, previous;
    sigfillset(&blocked);
    if (sigprocmask(SIG_BLOCK, &blocked, &previous)) return 0;
    int fd = order_lock(input_epoch, input_sequence);
    int valid = fd >= 0 && eligible() && capture_snapshot(&captured);
    if (fd >= 0) close(fd);
    sigprocmask(SIG_SETMASK, &previous, NULL);
    if (!valid) return 0;
    memcpy(outgoing.data, captured.data, captured.length);
    outgoing.length = captured.length; outgoing.offset = 0; outgoing.error = 0;
    phase = operation == 3 || operation == 5 ? 2 : 3;
    return 1;
  }
  return phase == 2 && opcode == 4 &&
    (operation == 5 ? delete_history_record(&incoming) : apply_record(&incoming));
}

/** Progress bounded nonblocking I/O. No read, write, connect or desktop authorization can suspend the Shell. */
static void progress_exchange(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec - started.tv_sec > 2) { reset_exchange(); return; }
  for (int step = 0; step < 16 && socket_fd >= 0; step++) {
    if (outgoing.offset < outgoing.length) {
      ssize_t written = send(socket_fd, outgoing.data + outgoing.offset, outgoing.length - outgoing.offset, MSG_NOSIGNAL | MSG_DONTWAIT);
      if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return;
      if (written <= 0) { reset_exchange(); return; }
      outgoing.offset += (size_t)written;
      continue;
    }
    if (outgoing.length) {
      clear_packet(&outgoing);
      if (phase == 3) { reset_exchange(); return; }
    }
    size_t desired = 4;
    if (incoming.length >= 4) {
      incoming.offset = 0;
      uint64_t size = read_number(&incoming, 4);
      if (size < 2 || size > MAX_FRAME) { reset_exchange(); return; }
      desired = (size_t)size + 4;
    }
    if (incoming.length == desired && desired > 4) {
      if (!handle_record()) { reset_exchange(); return; }
      clear_packet(&incoming);
      continue;
    }
    ssize_t received = recv(socket_fd, incoming.data + incoming.length, desired - incoming.length, MSG_DONTWAIT);
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return;
    if (received <= 0) { reset_exchange(); return; }
    incoming.length += (size_t)received;
  }
}

/** Confirm a new primary reader before handling abandoned incremental-search state. Bash's
 * Ctrl+C longjmp can leave ISEARCH/MOREINPUT/DISPATCHING and its context behind even without this
 * module. A real new-reader startup proves that context has ended. Cleanup(-1) frees it without
 * restoring the old search text. Other states are never cleared speculatively.
 */
static int on_startup(void) {
  if (loaded && owner == getpid() && *api.editing_mode != 1) history_untrusted = 1;
  if (armed && !startup_seen && owns_hooks() && !*api.executing_builtin && !*api.running_trap &&
      variable_equals("__COSMOSH_BASH_PRIMARY", "1") && variable_equals("__COSMOSH_BASH_PREEXEC_READY", "1") &&
      decimal(api.variable("__COSMOSH_PROMPT_GENERATION")) == generation) {
    startup_seen = 1;
    if ((*api.state & 0x80) && *api.isearch_context) {
      api.isearch_cleanup(*api.isearch_context, -1);
      *api.state &= ~(0x40UL | 0x20UL);
      *api.dispatching = 0;
    }
  }
  return previous_startup_hook ? previous_startup_hook() : 0;
}

/** Signal cleanup can discard undo provenance while leaving an unsubmitted edit in history. */
static void on_deprep(void) {
  if (loaded && owner == getpid() && (*api.state & SIGHANDLER) && api.current_history())
    history_untrusted = 1;
  if (previous_deprep) previous_deprep();
}

/** Chain the prior hook, then observe only a qualified idle reader; recursive callbacks do no work. */
static int on_idle(void) {
  /* Readline's event-hook polling path bypasses rl_getc's signal callback. Bash installs this
   * callback when a signal needs normal-thread handling; preserve its original cancel/trap path.
   * It may longjmp, so it must run before acquiring our recursion guard or retaining an exchange.
   */
  if (api.signal_hook && *api.signal_hook) {
    reset_exchange();
    (*api.signal_hook)();
  }
  if (entered) return 0;
  entered = 1;
  int result = previous_hook ? previous_hook() : 0;
  if (!eligible()) reset_exchange();
  else if (socket_fd >= 0 || open_exchange()) progress_exchange();
  entered = 0;
  return result;
}

/** Arm/disarm only metadata at primary-prompt boundaries; this builtin never reads the command buffer. */
static int cosmosh_editor(WORD_LIST *arguments) {
  if (!arguments || !arguments->word || !arguments->word->word || arguments->next) return 2;
  const char *command = arguments->word->word;
  int owned = owns_hooks();
  if (strcmp(command, "status") == 0) return owned ? 0 : 1;
  if (strcmp(command, "disarm") == 0) { armed = entered = startup_seen = 0; reset_exchange(); return 0; }
  if (strcmp(command, "arm") != 0 || !owned) return 1;
  armed = entered = startup_seen = 0; reset_exchange();
  const char *id = api.variable("__COSMOSH_SHELL_INSTANCE_ID"), *start = api.variable("__COSMOSH_EDITOR_START");
  uint64_t prompt = decimal(api.variable("__COSMOSH_PROMPT_GENERATION"));
  if (!uuid(id) || !start || strlen(start) > 20 || !decimal(start) || !prompt || prompt > 9007199254740991ULL ||
      decimal(api.variable("__COSMOSH_SHELL_OWNER_PID")) != (uint64_t)getpid()) return 1;
  memcpy(instance, id, 37); strcpy(start_time, start); generation = prompt; armed = 1;
  return 0;
}

/** Resolve every required ABI symbol before installing a callback into an existing Bash process. */
int cosmosh_editor_builtin_load(char *name) {
  (void)name;
  if (retired) return 0;
  if (loaded) return owns_hooks();
  void *version_address = dlsym(RTLD_DEFAULT, "shell_version_string");
  char *(*version_function)(void);
  if (!version_address) return 0;
  memcpy(&version_function, &version_address, sizeof(version_address));
  const char *version = version_function();
  if (!version || (strncmp(version, "5.1", 3) && strncmp(version, "5.2", 3)) || (version[3] != '.' && version[3] != '(' && version[3] != 0)) return 0;
#define SYMBOL(field, symbol) do { void *address = dlsym(RTLD_DEFAULT, symbol); if (!address) return 0; memcpy(&api.field, &address, sizeof(address)); } while (0)
  SYMBOL(variable, "get_string_value"); SYMBOL(hook, "rl_event_hook"); SYMBOL(state, "rl_readline_state");
  SYMBOL(signal_hook, "rl_signal_event_hook");
  SYMBOL(startup_hook, "rl_startup_hook"); SYMBOL(isearch_context, "_rl_iscxt"); SYMBOL(isearch_cleanup, "_rl_isearch_cleanup");
  SYMBOL(deprep, "rl_deprep_term_function");
  SYMBOL(line, "rl_line_buffer"); SYMBOL(point, "rl_point"); SYMBOL(end, "rl_end");
  SYMBOL(editing_mode, "rl_editing_mode"); SYMBOL(input, "rl_instream");
  SYMBOL(promptvars, "promptvars");
  SYMBOL(executing_builtin, "executing_builtin"); SYMBOL(running_trap, "running_trap");
  SYMBOL(dispatching, "rl_dispatching");
  SYMBOL(begin_undo, "rl_begin_undo_group"); SYMBOL(end_undo, "rl_end_undo_group");
  SYMBOL(delete_text, "rl_delete_text"); SYMBOL(insert_text, "rl_insert_text"); SYMBOL(redisplay, "rl_redisplay");
  SYMBOL(history_list, "history_list"); SYMBOL(current_history, "current_history");
  SYMBOL(history_length, "history_length"); SYMBOL(history_enabled, "enable_history_list");
  SYMBOL(where_history, "where_history"); SYMBOL(history_set_pos, "history_set_pos");
  SYMBOL(delete_history_range, "bash_delete_history_range");
#undef SYMBOL
  /* A separately loaded module copy must not reuse an earlier source revision. */
  uint64_t seed;
  if (getrandom(&seed, sizeof(seed), GRND_NONBLOCK) != sizeof(seed)) return 0;
  history_revision = seed & (UINT64_MAX >> 1);
  if (decimal(api.variable("__COSMOSH_PROMPT_GENERATION")) != 1) history_untrusted = 1;
  owner = getpid(); armed = 0;
  previous_hook = *api.hook;
  previous_startup_hook = *api.startup_hook;
  previous_deprep = *api.deprep;
  *api.hook = on_idle;
  *api.startup_hook = on_startup;
  *api.deprep = on_deprep;
  loaded = 1;
  return 1;
}

/** Restore only an owned hook; the build's NODELETE flag protects callbacks chained by other modules. */
void cosmosh_editor_builtin_unload(char *name) {
  (void)name;
  armed = 0; reset_exchange();
  loaded = 0;
  if ((api.hook && *api.hook != on_idle) || (api.startup_hook && *api.startup_hook != on_startup) ||
      (api.deprep && *api.deprep != on_deprep)) retired = 1;
  if (api.hook && *api.hook == on_idle) *api.hook = previous_hook;
  if (api.startup_hook && *api.startup_hook == on_startup) *api.startup_hook = previous_startup_hook;
  if (api.deprep && *api.deprep == on_deprep) *api.deprep = previous_deprep;
}

static char *const documentation[] = { "Configure the Cosmosh nonblocking primary-prompt adapter.", NULL };
struct builtin cosmosh_editor_struct = {
  "cosmosh_editor", cosmosh_editor, 1, documentation, "cosmosh_editor arm|disarm|status", NULL
};
