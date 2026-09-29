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
#include <sys/stat.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <wchar.h>

typedef struct { void *next; char *name; int flags; } hashnode;
typedef struct parameter parameter;
typedef struct { char *(*get)(parameter *); void (*set)(parameter *, char *); void (*unset)(parameter *, int); } scalar_methods;
typedef struct { long (*get)(parameter *); void (*set)(parameter *, long); void (*unset)(parameter *, int); } integer_methods;
struct parameter {
  hashnode node;
  union { void *data; char *text; long integer; double floating; } value;
  union { const scalar_methods *scalar; const integer_methods *integer; } methods;
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

enum { MAX_INPUT = 8192, INTEGER = 1 << 1, READONLY = 1 << 10, SPECIAL = 1 << 20, UNSET = 1 << 24 };
static struct {
  void **parameters;
  parameter *(*find)(void *, const char *);
  char *(*get_string)(char *);
  const scalar_methods *plain_scalar;
  const integer_methods *plain_integer;
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
} api;
static pid_t owner;
static int loaded;

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
static int eligible(uint64_t generation) {
  struct termios attributes;
  int pending = -1;
  uint64_t current_generation, original_pid;
  const char *available = plain_text("__COSMOSH_EDITOR_AVAILABLE");
  return loaded && owner == getpid() && !*api.subshell && *api.function_context == 4 &&
    *api.active && *api.context == 0 && !*api.recursive && !*api.region && *api.insert &&
    api.options[api.multibyte_option] && !*api.queued && *api.length >= 0 && *api.length <= MAX_INPUT && !*api.metafied_line &&
    *api.keymap && (!strcmp(*api.keymap, "main") || !strcmp(*api.keymap, "emacs")) &&
    *api.current_keymap && *api.current_keymap == api.open_keymap("emacs") && !*api.local_keymap &&
    (!*api.keys || !**api.keys) && *api.terminal >= 0 && tcgetpgrp(*api.terminal) == getpgrp() &&
    !tcgetattr(*api.terminal, &attributes) && !(attributes.c_lflag & ICANON) &&
    !ioctl(*api.terminal, FIONREAD, &pending) && pending == 0 &&
    available && !strcmp(available, "true") &&
    parameter_number("__COSMOSH_PROMPT_GENERATION", &current_generation) && current_generation == generation &&
    parameter_number("__COSMOSH_SHELL_OWNER_PID", &original_pid) && original_pid == (uint64_t)getpid();
}

/** Compare and fill once while signals and newly forwarded input cannot interleave. */
static int apply(char *name, char **arguments, void *options, int function) {
  (void)name; (void)options; (void)function;
  if (arguments[0]) {
    if (arguments[1]) return 1;
    if (!strcmp(arguments[0], "notification")) return notification();
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
      !editor_parameters(&buffer, &cursor) || !eligible(generation)) goto done;
  replacement = strdup(next);
  if (!replacement) goto done;
  fd = order_lock(epoch, sequence);
  if (fd < 0 || !eligible(generation) || find_parameter("BUFFER") != buffer || find_parameter("CURSOR") != cursor ||
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
#undef SYMBOL
  const char *version = api.get_string("ZSH_VERSION");
  Dl_info origin;
  if (!version || (strcmp(version, "5.8") && strcmp(version, "5.8.1") && strcmp(version, "5.9")) ||
      !dlsym(RTLD_DEFAULT, "alignmultiwordright") || !dladdr(api.length, &origin)) return 1;
  api.zle_image = origin.dli_fbase;
  api.multibyte_option = api.option_number("multibyte");
  if (api.multibyte_option <= 0) return 1;
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
int finish_(void *module) { (void)module; return 0; }
