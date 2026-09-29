/* SPDX-License-Identifier: GPL-3.0-only
 * Local ZLE mutation and notification-pipe creation. No signal handler, evaluation or network I/O.
 * The narrow module/parameter declarations follow Zsh 5.8/5.9 Src/zsh.h. Every runtime symbol
 * is resolved before registration; all private request parameters must have standard storage.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <langinfo.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <wchar.h>

typedef struct { void *next; char *name; int flags; } hashnode;
typedef struct parameter parameter;
typedef struct { char *(*get)(parameter *); void (*set)(parameter *, char *); void (*unset)(parameter *, int); } scalar_methods;
typedef struct { long (*get)(parameter *); void (*set)(parameter *, long); void (*unset)(parameter *, int); } integer_methods;
typedef struct { char **(*get)(parameter *); void (*set)(parameter *, char **); void (*unset)(parameter *, int); } array_methods;
struct parameter {
  hashnode node;
  union { void *data; char *text; long integer; double floating; } value;
  union { const scalar_methods *scalar; const integer_methods *integer; const array_methods *array; } methods;
  int base, width;
  char *environment, *environment_name;
  parameter *old;
  int level;
};
typedef struct {
  hashnode node;
  int (*handler)(char *, char **, void *, int);
  int minimum, maximum, function;
  char *options, *defaults;
} builtin;
typedef struct {
  builtin *builtins; int builtin_count;
  void *conditions; int condition_count;
  void *math; int math_count;
  void *parameters; int parameter_count;
  int abstract_count;
} features;

typedef struct history_entry history_entry;
struct history_entry {
  hashnode node;
  history_entry *up, *down;
  char *edited;
  time_t start, finish;
  short *words;
  int word_count;
  long number;
};

enum { MAX_INPUT = 8192, ARRAY = 1, INTEGER = 1 << 1, READONLY = 1 << 10, SPECIAL = 1 << 20, UNSET = 1 << 24 };
enum { HISTORY_DUP = 0x08, HISTORY_TEMPORARY = 0x20, HISTORY_NO_WRITE = 0x40, MAX_HISTORY_ENTRIES = 200,
  MAX_HISTORY_BYTES = 64 * 1024, MAX_HISTORY_SCAN = 10000, MAX_HISTORY_SCAN_BYTES = 8 * 1024 * 1024 };
static struct {
  void **parameters;
  parameter *(*find)(void *, const char *);
  char *(*get_string)(char *);
  const scalar_methods *plain_scalar;
  const integer_methods *plain_integer;
  const array_methods *plain_array;
  char **(*feature_names)(void *, features *);
  int (*feature_enables)(void *, features *, int **);
  int (*set_features)(void *, features *, int *);
  void (*add_dependency)(const char *, char *);
  char *(*duplicate)(const char *);
  int (*move_descriptor)(int);
  int (*close_descriptor)(int);
  void (*register_descriptor)(int, int);
  int (*option_number)(char *);
  char *options;
  int multibyte_option;
  int *active, *context, *recursive, *region, *insert, *queued, *length, *subshell, *function_context, *terminal;
  char **keymap, **keys, **metafied_line;
  void **current_keymap, **local_keymap;
  void *(*open_keymap)(char *);
  void *zle_image;
  history_entry **history_ring, *history_current;
  long *history_count, *history_number, *history_size;
  int *history_line;
  void **history_table;
  int (*history_compare)(const char *, const char *);
  void (*history_release)(hashnode *);
} api;
static pid_t owner;
static int loaded;
static struct {
  void *table;
  char *file;
  long size, number, count;
  uint64_t revision;
  int observed, untrusted;
} history_source;

/** Validate canonical identifiers before deriving an input-free pathname. */
static int uuid(const char *value) {
  if (!value || strlen(value) != 36) return 0;
  for (size_t index = 0; index < 36; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return 0;
    } else if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

#include "../bash/input_order.h"

/** Obtain only a real parameter node; this never invokes autoload or a parameter getter. */
static parameter *find_parameter(const char *name) {
  return api.find(*api.parameters, name);
}

/** Read ordinary scalar storage, excluding tied, special or externally implemented getters. */
static const char *plain_text(const char *name) {
  parameter *value = find_parameter(name);
  if (!value || (value->node.flags & (31 | SPECIAL | UNSET)) || value->methods.scalar != api.plain_scalar) return NULL;
  return value->value.text ? value->value.text : "";
}

/** Create a nonblocking notification pair without executing a process or printing descriptor values. */
static int notification(void) {
  if (!loaded || owner != getpid() || *api.subshell) return 1;
  sigset_t blocked, previous;
  sigfillset(&blocked);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous)) return 1;
  int result = 1, descriptors[2] = {-1, -1};
  const char *read_name = "__COSMOSH_EDITOR_NOTIFY_FD";
  const char *keep_name = "__COSMOSH_EDITOR_NOTIFY_KEEP_FD";
  parameter *read_parameter = find_parameter(read_name), *keep_parameter = find_parameter(keep_name);
  const char *read_value = plain_text(read_name), *keep_value = plain_text(keep_name);
  if (!read_parameter || !keep_parameter || !read_value || *read_value || !keep_value || *keep_value ||
      (read_parameter->node.flags & READONLY) || (keep_parameter->node.flags & READONLY)) goto done;
  if (pipe2(descriptors, O_NONBLOCK | O_CLOEXEC)) goto done;
  for (int index = 0; index < 2; index++) {
    /* movefd owns its original descriptor even on failure and registers the high descriptor.
     * Match sysopen's external-FD ownership so the Shell can explicitly close a successful pair.
     * The dup used by movefd clears CLOEXEC, which must be reapplied before signals resume.
     */
    descriptors[index] = api.move_descriptor(descriptors[index]);
    if (descriptors[index] < 0 || fcntl(descriptors[index], F_SETFD, FD_CLOEXEC)) goto done;
    api.register_descriptor(descriptors[index], 2); /* Zsh FDT_EXTERNAL. */
  }
  char read_text[32], keep_text[32];
  snprintf(read_text, sizeof(read_text), "%d", descriptors[0]);
  snprintf(keep_text, sizeof(keep_text), "%d", descriptors[1]);
  api.plain_scalar->set(read_parameter, api.duplicate(read_text));
  api.plain_scalar->set(keep_parameter, api.duplicate(keep_text));
  result = 0;
done:
  if (result) for (int index = 0; index < 2; index++) {
    if (descriptors[index] >= 0) api.close_descriptor(descriptors[index]);
  }
  sigprocmask(SIG_SETMASK, &previous, NULL);
  return result;
}

/** Accept only an exact nonnegative decimal or a standard integer; arithmetic is never evaluated. */
static int parameter_number(const char *name, uint64_t *number) {
  parameter *value = find_parameter(name);
  if (!value || (value->node.flags & (SPECIAL | UNSET))) return 0;
  if ((value->node.flags & 31) == INTEGER && value->methods.integer == api.plain_integer) {
    if (value->value.integer < 0) return 0;
    *number = (uint64_t)value->value.integer;
    return *number <= 9007199254740991ULL;
  }
  const char *text = plain_text(name);
  if (!text || !*text) return 0;
  *number = 0;
  for (; *text; text++) {
    if (*text < '0' || *text > '9') return 0;
    unsigned digit = (unsigned)(*text - '0');
    if (*number > (9007199254740991ULL - digit) / 10) return 0;
    *number = *number * 10 + digit;
  }
  return 1;
}

/** Validate Zsh's metafied bytes as bounded UTF-8 without accepting NUL or executable control input. */
static int validate_text(const char *metafied, uint64_t cursor) {
  char raw[MAX_INPUT + 1];
  size_t bytes = 0, input = 0;
  if (!metafied) return 0;
  while (metafied[input]) {
    unsigned char value = (unsigned char)metafied[input++];
    if (value == 0x83) {
      if (!metafied[input]) return 0;
      value = (unsigned char)metafied[input++] ^ 32;
    }
    if (!value || bytes == MAX_INPUT) return 0;
    raw[bytes++] = (char)value;
  }
  mbstate_t state = {0};
  size_t offset = 0;
  uint64_t count = 0;
  while (offset < bytes) {
    wchar_t character;
    size_t length = mbrtowc(&character, raw + offset, bytes - offset, &state);
    if (length == (size_t)-1 || length == (size_t)-2 || length == 0 ||
        (character < 32 && character != '\t') || (character >= 127 && character <= 159)) return 0;
    offset += length; count++;
  }
  return cursor <= count;
}

/** Confirm that a method belongs to the loaded ZLE image, never to an arbitrary parameter module. */
static int zle_method(const void *address) {
  Dl_info origin;
  return address && dladdr(address, &origin) && origin.dli_fbase == api.zle_image;
}

/** Locate actual writable ZLE parameters while their widget owns the temporary parameter scope. */
static int editor_parameters(parameter **buffer, parameter **cursor) {
  *buffer = find_parameter("BUFFER"); *cursor = find_parameter("CURSOR");
  return *buffer && *cursor &&
    ((*buffer)->node.flags & (31 | SPECIAL | READONLY | UNSET)) == SPECIAL &&
    ((*cursor)->node.flags & (31 | SPECIAL | READONLY | UNSET)) == (SPECIAL | INTEGER) &&
    (*buffer)->methods.scalar && (*cursor)->methods.integer &&
    zle_method((void *)(*buffer)->methods.scalar->get) && zle_method((void *)(*buffer)->methods.scalar->set) &&
    zle_method((void *)(*cursor)->methods.integer->get) && zle_method((void *)(*cursor)->methods.integer->set);
}

/** Recheck native reader identity and both queues; no Shell function or special getter is evaluated. */
static int eligible_scope(uint64_t generation, int history) {
  struct termios attributes;
  int pending = -1;
  uint64_t current_generation, original_pid;
  const char *available = plain_text("__COSMOSH_EDITOR_AVAILABLE");
  return loaded && owner == getpid() && !*api.subshell && *api.function_context == (history ? 3 : 4) &&
    *api.active && *api.context == 0 && !*api.recursive && !*api.region && *api.insert &&
    api.options[api.multibyte_option] && !*api.queued && *api.length >= 0 && (history || *api.length <= MAX_INPUT) && !*api.metafied_line &&
    *api.keymap && (!strcmp(*api.keymap, "main") || !strcmp(*api.keymap, "emacs")) &&
    *api.current_keymap && *api.current_keymap == api.open_keymap("emacs") && !*api.local_keymap &&
    (!*api.keys || !**api.keys) && *api.terminal >= 0 && tcgetpgrp(*api.terminal) == getpgrp() &&
    !tcgetattr(*api.terminal, &attributes) && !(attributes.c_lflag & ICANON) &&
    !ioctl(*api.terminal, FIONREAD, &pending) && pending == 0 &&
    available && !strcmp(available, "true") &&
    parameter_number("__COSMOSH_PROMPT_GENERATION", &current_generation) && current_generation == generation &&
    parameter_number("__COSMOSH_SHELL_OWNER_PID", &original_pid) && original_pid == (uint64_t)getpid();
}

/** Read an optional ordinary configuration scalar without evaluating a getter or autoload. */
static const char *history_setting(const char *name) {
  parameter *value = find_parameter(name);
  if (!value || value->node.flags & UNSET) return "";
  return plain_text(name);
}

/** Observe only history metadata; rejected save policies remain rejected across module reloads. */
static int history_state(void) {
  if (!loaded || owner != getpid() || *api.subshell) return 1;
  const char *file = history_setting("HISTFILE"), *ignore = history_setting("HISTORY_IGNORE");
  const char *untrusted = plain_text("__COSMOSH_ZSH_HISTORY_POLICY_UNTRUSTED");
  parameter *latch = find_parameter("__COSMOSH_ZSH_HISTORY_POLICY_UNTRUSTED");
  if (!file || !ignore || !untrusted || !latch || (latch->node.flags & READONLY) ||
      (strcmp(untrusted, "true") && strcmp(untrusted, "false")) || strnlen(file, 8193) > 8192) return 1;
  if (*ignore || !strcmp(untrusted, "true")) history_source.untrusted = 1;
  if (history_source.untrusted) {
    api.plain_scalar->set(latch, api.duplicate("true"));
    return 1;
  }
  if (!history_source.observed || history_source.table != *api.history_table ||
      history_source.size != *api.history_size || strcmp(history_source.file, file) ||
      *api.history_number < history_source.number || *api.history_count < history_source.count) {
    char *copy = strdup(file);
    if (!copy || history_source.revision == UINT64_MAX) { free(copy); return 1; }
    free(history_source.file); history_source.file = copy;
    history_source.table = *api.history_table; history_source.size = *api.history_size;
    history_source.revision++; history_source.observed = 1;
  }
  history_source.number = *api.history_number; history_source.count = *api.history_count;
  return 0;
}

/** Preserve the caller's signal mask around a metadata-only prompt checkpoint. */
static int history_checkpoint(void) {
  sigset_t blocked, previous;
  sigfillset(&blocked);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous)) return 1;
  int result = history_state();
  sigprocmask(SIG_SETMASK, &previous, NULL);
  return result;
}

/** Validate a complete native history record without treating its multiline text as editor input. */
static int history_text(const char *metafied, size_t *bytes) {
  char raw[MAX_INPUT + 1];
  *bytes = 0;
  if (!metafied) return 0;
  while (*metafied) {
    unsigned char value = (unsigned char)*metafied++;
    if (value == 0x83) {
      if (!*metafied) return 0;
      value = (unsigned char)*metafied++ ^ 32;
    }
    if (!value || *bytes == MAX_INPUT) return 0;
    raw[(*bytes)++] = (char)value;
  }
  if (!*bytes || raw[0] == ' ') return 0;
  mbstate_t state = {0};
  size_t offset = 0;
  while (offset < *bytes) {
    wchar_t character;
    size_t length = mbrtowc(&character, raw + offset, *bytes - offset, &state);
    if (!length || length == (size_t)-1 || length == (size_t)-2) return 0;
    offset += length;
  }
  return 1;
}

/** Verify private output storage so no custom parameter method can run while signals are masked. */
static int history_outputs(parameter **status, parameter **space, parameter **entries) {
  *status = find_parameter("__cosmosh_history_status");
  *space = find_parameter("__cosmosh_history_namespace");
  *entries = find_parameter("__cosmosh_history_entries");
  return *status && *space && *entries && plain_text("__cosmosh_history_status") &&
    plain_text("__cosmosh_history_namespace") && !((*status)->node.flags & ~(1 << 19)) &&
    !((*space)->node.flags & ~(1 << 19)) &&
    ((*entries)->node.flags & ~(1 << 19)) == ARRAY &&
    (*entries)->methods.array == api.plain_array;
}

/** Prove an entire normalized-key class consists solely of removable byte-exact records. */
static int history_matches(const char *target, history_entry **matches, size_t *count, history_entry **hash_owner) {
  history_entry *head = *api.history_ring, *entry = head;
  size_t visited = 0, stored = 0, bytes = 0, target_bytes;
  *count = 0;
  *hash_owner = (history_entry *)api.find(*api.history_table, target);
  if (!history_text(target, &target_bytes) || !head || head != api.history_current || !*hash_owner ||
      *api.history_count < 0 || *api.history_count > MAX_HISTORY_SCAN) return 0;
  do {
    if (++visited > MAX_HISTORY_SCAN + 1 || !entry->up || !entry->down ||
        entry->up->down != entry || entry->down->up != entry) return 0;
    /* Never inspect curline's text: it belongs to the current editor, outside history permission. */
    if (entry != api.history_current) {
      stored++;
      if (!entry->node.name) return 0;
      size_t length = strnlen(entry->node.name, 2 * MAX_INPUT + 1);
      if (length > 2 * MAX_INPUT || (bytes += length) > MAX_HISTORY_SCAN_BYTES) return 0;
      if (!api.history_compare(target, entry->node.name)) {
        if (strcmp(target, entry->node.name) || (entry->node.flags & (HISTORY_TEMPORARY | HISTORY_NO_WRITE)) ||
            (entry != *hash_owner && !(entry->node.flags & HISTORY_DUP)) ||
            entry->edited || entry->number == *api.history_line) return 0;
        matches[(*count)++] = entry;
      }
    }
    entry = entry->up;
  } while (entry != head);
  if (stored != (size_t)*api.history_count || !*count ||
      ((*hash_owner)->node.flags & (HISTORY_DUP | HISTORY_TEMPORARY | HISTORY_NO_WRITE))) return 0;
  size_t owners = 0;
  for (size_t index = 0; index < *count; index++) if (matches[index] == *hash_owner) owners++;
  return owners == 1;
}

/** Capture permitted records or remove one exact-text class in the original reader, never a file. */
static int history_operation(const char *operation) {
  if (!loaded || owner != getpid() || strcmp(nl_langinfo(CODESET), "UTF-8")) return 1;
  sigset_t blocked, previous;
  sigfillset(&blocked);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous)) return 1;
  int result = 1, fd = -1, selected = strcmp(operation, "history") != 0;
  int remove = !strcmp(operation, "history-delete"), partial = 0;
  uint64_t generation, sequence;
  parameter *status, *space, *output;
  char **entries = NULL;
  history_entry **matches = NULL, *hash_owner = NULL;
  size_t count = 0;
  char namespace[80];
  const char *instance = plain_text("__COSMOSH_SHELL_INSTANCE_ID");
  const char *target = selected ? plain_text("__cosmosh_history_target") : NULL;
  const char *expected_space = selected ? plain_text("__cosmosh_history_expected_namespace") : NULL;
  if (!uuid(instance) || !history_outputs(&status, &space, &output) ||
      !parameter_number("__cosmosh_prompt_generation", &generation) || generation == 0 ||
      !eligible_scope(generation, 1) || *api.history_ring != api.history_current || history_state()) goto done;
  snprintf(namespace, sizeof(namespace), "%s:%llu", instance, (unsigned long long)history_source.revision);
  entries = calloc(MAX_HISTORY_ENTRIES + 1, sizeof(*entries));
  if (!entries) goto done;
  if (selected) {
    const char *epoch = plain_text("__cosmosh_input_epoch");
    const char *request = plain_text("__cosmosh_request_id");
    if (*api.history_size <= 1 || !target || !expected_space || strcmp(expected_space, namespace)) goto done;
    matches = calloc(MAX_HISTORY_SCAN, sizeof(*matches));
    if (!matches || !history_matches(target, matches, &count, &hash_owner)) goto done;
    if (remove) {
      if (!order_uuid(epoch) || !order_uuid(request) || !parameter_number("__cosmosh_input_sequence", &sequence)) goto done;
      fd = order_lock(epoch, sequence);
      if (fd < 0 || !eligible_scope(generation, 1) || history_state() ||
          !history_matches(target, matches, &count, &hash_owner) || !order_consume(fd, epoch, sequence, request)) goto done;
      /* Zsh hashes whitespace-equivalent records together. Free exact duplicate nodes first,
       * then their real hash owner; mixed-text classes were refused before consuming the grant.
       * Entries referenced by this reader's current line or edited copies are refused, retaining
       * native undo/history navigation. A fresh primary reader clears those native references.
       */
      for (size_t index = 0; index < count; index++) {
        if (matches[index] == hash_owner) continue;
        api.history_release(&matches[index]->node);
      }
      api.history_release(&hash_owner->node);
      /* curline is linked during editing but excluded from histlinect. Native deletion's
       * empty-list branch does not reconnect it; restore the exact active-empty-reader ring.
       */
      if (*api.history_count == 0) {
        api.history_current->up = api.history_current->down = api.history_current;
        *api.history_ring = api.history_current;
      }
      history_source.count = *api.history_count;
      result = api.find(*api.history_table, target) ? 2 : 0;
      close(fd); fd = -1;
      if (result) goto done;
      count = 0;
    } else {
      entries[0] = api.duplicate(target); count = 1;
    }
  } else if (*api.history_size > 1) {
    history_entry *head = *api.history_ring, *entry = head;
    size_t visited = 0, bytes = 0, scanned = 0;
    do {
      if (!entry) break;
      if (++visited > MAX_HISTORY_SCAN + 1 || !entry->up || !entry->down ||
          entry->up->down != entry || entry->down->up != entry) { partial = 1; break; }
      if (entry != api.history_current && !(entry->node.flags & (HISTORY_TEMPORARY | HISTORY_NO_WRITE)) &&
          entry->node.name && entry->node.name[0] != ' ') {
        size_t length;
        scanned += strnlen(entry->node.name, 2 * MAX_INPUT + 1);
        if (scanned > MAX_HISTORY_SCAN_BYTES) { partial = 1; break; }
        if (!history_text(entry->node.name, &length)) partial = 1;
        else if (count == MAX_HISTORY_ENTRIES || bytes + length > MAX_HISTORY_BYTES) { partial = 1; break; }
        else { entries[count++] = api.duplicate(entry->node.name); bytes += length; }
      }
      entry = entry->up;
    } while (entry != head);
  }
  api.plain_scalar->set(status, api.duplicate(*api.history_size <= 1 ? "private" : partial ? "partial" : "ok"));
  api.plain_scalar->set(space, api.duplicate(*api.history_size <= 1 ? "" : namespace));
  api.plain_array->set(output, entries); entries = NULL;
  result = 0;
done:
  if (fd >= 0) close(fd);
  if (entries) { for (size_t index = 0; entries[index]; index++) free(entries[index]); free(entries); }
  free(matches);
  sigprocmask(SIG_SETMASK, &previous, NULL);
  return result;
}

/** Compare and fill once while signals and newly forwarded input cannot interleave. */
static int apply(char *name, char **arguments, void *options, int function) {
  (void)name; (void)options; (void)function;
  if (arguments[0]) {
    if (arguments[1]) return 1;
    if (!strcmp(arguments[0], "notification")) return notification();
    if (!strcmp(arguments[0], "history-state")) return history_checkpoint();
    if (!strcmp(arguments[0], "history") || !strcmp(arguments[0], "history-match") ||
        !strcmp(arguments[0], "history-delete")) return history_operation(arguments[0]);
    return !strcmp(arguments[0], "status") && loaded && owner == getpid() ? 0 : 1;
  }
  if (!loaded || owner != getpid() || strcmp(nl_langinfo(CODESET), "UTF-8")) return 1;
  sigset_t blocked, previous;
  sigfillset(&blocked);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous)) return 1;
  int result = 1, fd = -1;
  char *replacement = NULL;
  const char *expected = plain_text("__cosmosh_line");
  const char *next = plain_text("__cosmosh_replacement");
  const char *epoch = plain_text("__cosmosh_input_epoch");
  const char *request = plain_text("__cosmosh_request_id");
  uint64_t point, next_point, generation, sequence;
  parameter *buffer, *cursor;
  if (!expected || !next || !epoch || !request || !order_uuid(epoch) || !order_uuid(request) ||
      !parameter_number("__cosmosh_point", &point) || !parameter_number("__cosmosh_replacement_point", &next_point) ||
      !parameter_number("__cosmosh_prompt_generation", &generation) || generation == 0 ||
      !parameter_number("__cosmosh_input_sequence", &sequence) ||
      !validate_text(expected, point) || !validate_text(next, next_point) ||
      !editor_parameters(&buffer, &cursor) || !eligible_scope(generation, 0)) goto done;
  replacement = strdup(next);
  if (!replacement) goto done;
  fd = order_lock(epoch, sequence);
  if (fd < 0 || !eligible_scope(generation, 0) || find_parameter("BUFFER") != buffer || find_parameter("CURSOR") != cursor ||
      cursor->methods.integer->get(cursor) != (long)point || strcmp(buffer->methods.scalar->get(buffer), expected) ||
      !order_consume(fd, epoch, sequence, request)) goto done;
  /* These are ZLE's original setters: bounded memory edits and suffix bookkeeping.
   * They have no redisplay, user hook, command evaluation or network operation.
   * The containing widget retains ZLE's native undo boundary and cursor normalization.
   */
  buffer->methods.scalar->set(buffer, replacement);
  replacement = NULL; /* ZLE owns and frees its setter argument. */
  cursor->methods.integer->set(cursor, (long)next_point);
  result = cursor->methods.integer->get(cursor) == (long)next_point &&
    !strcmp(buffer->methods.scalar->get(buffer), next) ? 0 : 2;
done:
  if (fd >= 0) close(fd);
  free(replacement);
  sigprocmask(SIG_SETMASK, &previous, NULL);
  return result;
}

static builtin builtins[] = { { { NULL, "cosmosh_editor_apply", 0 }, apply, 0, 1, 0, NULL, NULL } };
static features module_features = { builtins, 1, NULL, 0, NULL, 0, NULL, 0, 0 };

/** Resolve the supported 64-bit Zsh ABI before any feature is exposed. */
int setup_(void *module) {
  (void)module;
  if (sizeof(long) != 8 || sizeof(wchar_t) != 4) return 1;
#define SYMBOL(field, symbol) do { void *address = dlsym(RTLD_DEFAULT, symbol); if (!address) return 1; memcpy(&api.field, &address, sizeof(address)); } while (0)
  SYMBOL(parameters, "paramtab"); SYMBOL(find, "gethashnode2"); SYMBOL(get_string, "getsparam");
  SYMBOL(plain_scalar, "stdscalar_gsu"); SYMBOL(plain_integer, "stdinteger_gsu");
  SYMBOL(plain_array, "stdarray_gsu");
  SYMBOL(feature_names, "featuresarray"); SYMBOL(feature_enables, "handlefeatures"); SYMBOL(set_features, "setfeatureenables");
  SYMBOL(add_dependency, "add_dep");
  SYMBOL(duplicate, "ztrdup"); SYMBOL(move_descriptor, "movefd");
  SYMBOL(close_descriptor, "zclose"); SYMBOL(register_descriptor, "addmodulefd");
  SYMBOL(active, "zleactive"); SYMBOL(context, "zlecontext"); SYMBOL(recursive, "zle_recursive");
  SYMBOL(region, "region_active"); SYMBOL(insert, "insmode"); SYMBOL(queued, "kungetct"); SYMBOL(length, "zlell");
  SYMBOL(keymap, "curkeymapname"); SYMBOL(keys, "keybuf"); SYMBOL(metafied_line, "zlemetaline");
  SYMBOL(current_keymap, "curkeymap"); SYMBOL(local_keymap, "localkeymap"); SYMBOL(open_keymap, "openkeymap");
  SYMBOL(subshell, "subsh"); SYMBOL(function_context, "sfcontext");
  SYMBOL(terminal, "SHTTY");
  SYMBOL(option_number, "optlookup"); SYMBOL(options, "opts");
  SYMBOL(history_ring, "hist_ring"); SYMBOL(history_current, "curline");
  SYMBOL(history_count, "histlinect"); SYMBOL(history_number, "curhist"); SYMBOL(history_size, "histsiz");
  SYMBOL(history_line, "histline");
  SYMBOL(history_table, "histtab"); SYMBOL(history_compare, "histstrcmp"); SYMBOL(history_release, "freehistnode");
#undef SYMBOL
  const char *version = api.get_string("ZSH_VERSION");
  Dl_info origin;
  if (!version || (strcmp(version, "5.8") && strcmp(version, "5.8.1") && strcmp(version, "5.9")) ||
      !dlsym(RTLD_DEFAULT, "alignmultiwordright") || !dladdr(api.length, &origin)) return 1;
  api.zle_image = origin.dli_fbase;
  api.multibyte_option = api.option_number("multibyte");
  if (api.multibyte_option <= 0) return 1;
  /* A newly loaded module must never reuse an earlier namespace in this same Shell process. */
  if (getrandom(&history_source.revision, sizeof(history_source.revision), GRND_NONBLOCK) != sizeof(history_source.revision)) return 1;
  history_source.revision &= UINT64_MAX >> 1;
  api.add_dependency(((hashnode *)module)->name, "zsh/zle");
  owner = getpid();
  return 0;
}

/** Return the single builtin's feature name using Zsh's own module lifecycle. */
int features_(void *module, char ***names) { *names = api.feature_names(module, &module_features); return 0; }
/** Enable or query only this module's registered builtin. */
int enables_(void *module, int **enables) { return api.feature_enables(module, &module_features, enables); }
/** Loading installs no callbacks, handlers, private bindings or background work. */
int boot_(void *module) { (void)module; loaded = 1; return 0; }
/** Remove only this module's builtin; no caller trap or editor hook has been changed. */
int cleanup_(void *module) { int result = api.set_features(module, &module_features, NULL); if (!result) loaded = 0; return result; }
/** The Shell owns successful notification descriptors; this module retains no callback or text. */
int finish_(void *module) {
  (void)module;
  free(history_source.file); history_source.file = NULL;
  history_source.observed = history_source.untrusted = 0;
  return 0;
}
