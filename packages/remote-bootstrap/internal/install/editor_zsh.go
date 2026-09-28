package install

// zshEditorHooks uses ZLE's descriptor callback without replacing any user key or widget.
// A callback-local DEBUG trap exposes read-only ZLE parameters without changing native editing state.
const zshEditorHooks = `
__cosmosh_zsh_editor_owned() {
  builtin emulate -L zsh
  [[ "$__COSMOSH_EDITOR_OWNER_PID" = "$$" ]] || return 1
  local -A __cosmosh_stat
  builtin zstat -H __cosmosh_stat -- /proc/$$/fd/$__COSMOSH_EDITOR_NOTIFY_FD 2>/dev/null || return 1
  [[ "$__cosmosh_stat[inode]" = "$__COSMOSH_EDITOR_NOTIFY_INODE" &&
     "$__cosmosh_stat[uid]" = "$EUID" && "$(( __cosmosh_stat[mode] & 0xf000 ))" = 4096 ]] || return 1
  [[ "$(builtin zle -F -L "$__COSMOSH_EDITOR_NOTIFY_FD" 2>/dev/null)" =
     "zle -F $__COSMOSH_EDITOR_NOTIFY_FD __cosmosh_zsh_editor_notify" ]]
}

__cosmosh_zsh_editor_prepare() {
  builtin emulate -L zsh
  __COSMOSH_EDITOR_AVAILABLE=false
  if [[ "${__COSMOSH_EDITOR_OWNER_PID:-}" != "$$" ]]; then
    __COSMOSH_EDITOR_OWNER_PID=$$
    __COSMOSH_EDITOR_NONCE="$__COSMOSH_SHELL_INSTANCE_ID"
    __COSMOSH_EDITOR_START="$("$__COSMOSH_EDITOR_BINARY" editor-identity "$$" 2>/dev/null)" || __COSMOSH_EDITOR_START=
    __COSMOSH_EDITOR_NOTIFY_INODE=
    # The Shell owns both ends. CLOEXEC prevents children from extending the pipe lifetime.
    # No filesystem FIFO, persistent process, or command text is needed.
    if [[ -n "$__COSMOSH_EDITOR_START" ]] &&
       builtin zmodload zsh/system && builtin zmodload zsh/stat && builtin zmodload zsh/parameter; then
      local __cosmosh_temporary_fd
      exec {__cosmosh_temporary_fd}< <(builtin true)
      if builtin sysopen -r -u __COSMOSH_EDITOR_NOTIFY_FD -o cloexec,nonblock /proc/$$/fd/$__cosmosh_temporary_fd &&
         builtin sysopen -w -u __COSMOSH_EDITOR_NOTIFY_KEEP_FD -o cloexec,nonblock /proc/$$/fd/$__cosmosh_temporary_fd; then
        local -A __cosmosh_stat
        if builtin zstat -H __cosmosh_stat -- /proc/$$/fd/$__COSMOSH_EDITOR_NOTIFY_FD; then
          __COSMOSH_EDITOR_NOTIFY_INODE="$__cosmosh_stat[inode]"
          builtin zle -F "$__COSMOSH_EDITOR_NOTIFY_FD" __cosmosh_zsh_editor_notify
        fi
      fi
      exec {__cosmosh_temporary_fd}<&-
    fi
  fi
  if [[ -n "$__COSMOSH_EDITOR_NOTIFY_INODE" ]] && __cosmosh_zsh_editor_owned &&
     [[ "$(command locale charmap 2>/dev/null)" = UTF-8 ]]; then
    __COSMOSH_EDITOR_AVAILABLE=true
  fi
  __cosmosh_emit_remote_shell_event editor-state
  return 0
}

__cosmosh_zsh_editor_unwatch() {
  # A revoked descriptor may already belong to user code. Remove only our registration, never close it.
  if [[ "$__COSMOSH_EDITOR_OWNER_PID" = "$$" && "$1" = <-> &&
        "$(builtin zle -F -L "$1" 2>/dev/null)" = "zle -F $1 __cosmosh_zsh_editor_notify" ]]; then
    builtin zle -F "$1" 2>/dev/null || :
  fi
  if [[ "$__COSMOSH_EDITOR_AVAILABLE" = true ]]; then
    __COSMOSH_EDITOR_AVAILABLE=false
    __cosmosh_emit_remote_shell_event editor-state
  fi
  return 0
}

__cosmosh_zsh_editor_notify() {
  builtin emulate -L zsh -o noxtrace -o localtraps
  builtin trap '' DEBUG
  # Validate before any read: a closed descriptor may have been reused for a user file or pipe.
  if [[ "$#" != 1 || "$1" != "$__COSMOSH_EDITOR_NOTIFY_FD" ]] || ! __cosmosh_zsh_editor_owned; then
    __cosmosh_zsh_editor_unwatch "$1"
    return 0
  fi
  local __cosmosh_signal
  # Drain a bounded notification burst; it never contains input. A canceled request leaves only a harmless byte.
  local __cosmosh_read_status=0
  builtin sysread -i "$1" -s 4096 -t 0 __cosmosh_signal 2>/dev/null || __cosmosh_read_status=$?
  if [[ "$__cosmosh_read_status" != 0 ]]; then
    # A transient empty poll is harmless; EOF/permanent errors must not keep a busy callback registered.
    if [[ "$__cosmosh_read_status" != 4 ]] &&
       ! [[ "$__cosmosh_read_status" = 2 && "$errnos[$ERRNO]" = (EAGAIN|EWOULDBLOCK) ]]; then
      __cosmosh_zsh_editor_unwatch "$1"
    fi
    return 0
  fi
  # Zsh supplies read-only editor parameters to traps. Invoking a user widget just to read them
  # changes lastcmd and breaks native kill/yank chaining, even with zle's nolast option.
  # Disable this one-shot trap in its own scope before calling the observer. LOCAL_TRAPS restores
  # the user's DEBUG handler when the notification callback returns.
  builtin trap 'builtin trap "" DEBUG; __cosmosh_zsh_editor_observe' DEBUG
  builtin :
  builtin trap '' DEBUG
  return 0
}

__cosmosh_zsh_editor_supported() {
  [[ "$CONTEXT" = start && -z "$PREBUFFER" && "$KEYMAP" = (main|emacs) &&
     "$ZLE_RECURSIVE" = 0 && "$REGION_ACTIVE" = 0 &&
     "$PENDING" = 0 && "$KEYS_QUEUED_COUNT" = 0 &&
     -z "$KEYS" && "$ZLE_STATE" = *insert* ]] || return 1
  local __cosmosh_function
  for __cosmosh_function in "${funcstack[@]}"; do
    [[ "$__cosmosh_function" = __cosmosh_zsh_editor_* ]] || return 1
  done
  [[ "$KEYMAP" != main || "$(builtin bindkey -lL main)" = 'bindkey -A emacs main' ]] || return 1
  # WIDGET is empty before the very first key; WIDGETSTYLE/FUNC can crash Zsh 5.9 in that state.
  if [[ -z "$WIDGET" ]]; then __cosmosh_zsh_editor_owned; return; fi
  # Builtins which wait for further input keep their identity during descriptor callbacks.
  # A plugin's completed user widget is usable only after its function has returned.
  case "$widgets[$WIDGET]" in
    user:*) ;;
    builtin)
      case "$WIDGET" in
        self-insert|self-insert-unmeta|backward-char|forward-char|beginning-of-line|end-of-line|\
        backward-delete-char|delete-char|kill-line|backward-kill-line|backward-kill-word|\
        up-line-or-history|down-line-or-history|up-history|down-history|\
        history-beginning-search-backward|history-beginning-search-forward|undo|redo|\
        clear-screen|redisplay|undefined-key|accept-line|send-break) ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  __cosmosh_zsh_editor_owned
}

__cosmosh_zsh_editor_reject() {
  "$__COSMOSH_EDITOR_BINARY" editor-widget reject "$__COSMOSH_SHELL_INSTANCE_ID" zsh \
    "$__COSMOSH_SHELL_OWNER_PID" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" unsupported "$@" >/dev/null 2>&1
}

__cosmosh_zsh_editor_observe() {
  builtin emulate -L zsh -o noxtrace -o localtraps
  builtin trap '' DEBUG
  if ! __cosmosh_zsh_editor_supported; then __cosmosh_zsh_editor_reject; return 0; fi
  local -a __cosmosh_request __cosmosh_response
  local __cosmosh_input=0 __cosmosh_line= __cosmosh_point= __cosmosh_pwd= __cosmosh_home=
  __cosmosh_request=("${(@f)$("$__COSMOSH_EDITOR_BINARY" editor-widget mode "$__COSMOSH_SHELL_INSTANCE_ID" zsh "$__COSMOSH_SHELL_OWNER_PID" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs 2>/dev/null)}")
  [[ "$#__cosmosh_request" = 3 ]] || return 0
  # Input received while the permission handshake ran must be consumed by the real editor first.
  if ! __cosmosh_zsh_editor_supported; then __cosmosh_zsh_editor_reject "$__cosmosh_request[1]"; return 0; fi
  case "$__cosmosh_request[2]" in
    context) ;;
    snapshot|apply) __cosmosh_input=1; __cosmosh_line="$BUFFER"; __cosmosh_point="$CURSOR" ;;
    *) return 0 ;;
  esac
  if [[ "$__cosmosh_request[3]" = 1 ]]; then __cosmosh_pwd="$PWD"; __cosmosh_home="${HOME-}"; fi
  __cosmosh_response=("${(@f)$(builtin printf '%s\0' "$__cosmosh_line" "$__cosmosh_point" "$__cosmosh_pwd" "$__cosmosh_home" |
    "$__COSMOSH_EDITOR_BINARY" editor-widget capture "$__COSMOSH_SHELL_INSTANCE_ID" zsh "$__COSMOSH_SHELL_OWNER_PID" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$__cosmosh_request[1]" "$__cosmosh_input" "$__cosmosh_request[3]" 2>/dev/null)}")
  if [[ "$#__cosmosh_response" = 3 && "$__cosmosh_response[1]" = apply ]]; then
    # The current callback owns the editor, but terminal bytes may have arrived during authorization.
    if ! __cosmosh_zsh_editor_supported || [[ "$BUFFER" != "$__cosmosh_line" || "$CURSOR" != "$__cosmosh_point" ]]; then
      __cosmosh_zsh_editor_reject "$__cosmosh_request[1]"; return 0
    fi
    local __cosmosh_replacement
    __cosmosh_replacement="$(builtin printf '%s' "$__cosmosh_response[2]" | command base64 -d 2>/dev/null)" || return 0
    [[ "$__cosmosh_response[3]" = <-> ]] || return 0
    # Only an explicitly authorized edit enters a writable widget and creates an editing boundary.
    # Register only for this request: startup plugins may wrap existing widgets, including private names.
    local __cosmosh_applied=0 __cosmosh_apply_widget="__cosmosh_apply_$__cosmosh_request[1]"
    if [[ -n "${widgets[$__cosmosh_apply_widget]-}" ]] ||
       ! builtin zle -N "$__cosmosh_apply_widget" __cosmosh_zsh_editor_apply; then
      __cosmosh_zsh_editor_reject "$__cosmosh_request[1]"; return 0
    fi
    {
      builtin zle "$__cosmosh_apply_widget" -f nolast -- 2>/dev/null || :
    } always {
      if [[ "$widgets[$__cosmosh_apply_widget]" = user:__cosmosh_zsh_editor_apply ]]; then
        builtin zle -D "$__cosmosh_apply_widget"
      fi
    }
    # ZLE can normalize a combining-character cursor after the writable widget returns.
    # Confirm that final state, never the intermediate assignment inside the widget.
    if [[ "$__cosmosh_applied" = 1 ]]; then
      builtin printf '%s\0' "$BUFFER" "$CURSOR" "$__cosmosh_pwd" "$__cosmosh_home" |
        "$__COSMOSH_EDITOR_BINARY" editor-widget confirm "$__COSMOSH_SHELL_INSTANCE_ID" zsh "$__COSMOSH_SHELL_OWNER_PID" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$__cosmosh_request[1]" 1 "$__cosmosh_request[3]" >/dev/null 2>&1
    fi
  fi
  return 0
}

__cosmosh_zsh_editor_apply() {
  builtin emulate -L zsh -o noxtrace -o localtraps
  builtin trap '' DEBUG
  if ! __cosmosh_zsh_editor_supported || [[ "$BUFFER" != "$__cosmosh_line" || "$CURSOR" != "$__cosmosh_point" ]]; then
    __cosmosh_zsh_editor_reject "$__cosmosh_request[1]"; return 0
  fi
  BUFFER="$__cosmosh_replacement"
  CURSOR="$__cosmosh_response[3]"
  __cosmosh_applied=1
  builtin zle -R
  return 0
}
`
