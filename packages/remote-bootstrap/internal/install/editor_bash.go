package install

// bashEditorHooks uses Readline's native bind-x editor. No command buffer is reconstructed from PTY input.
const bashEditorHooks = `
if [ "${__COSMOSH_EDITOR_OWNER_PID:-}" != "$$" ]; then
  __COSMOSH_EDITOR_OWNER_PID=$$
  __COSMOSH_EDITOR_START="$("$__COSMOSH_EDITOR_BINARY" editor-identity "$$" 2>/dev/null)" || __COSMOSH_EDITOR_START=
  __COSMOSH_EDITOR_NONCE=
  __COSMOSH_EDITOR_AVAILABLE=false
  __COSMOSH_EDITOR_REVOKED=0
  __COSMOSH_EDITOR_PS2_INSTALLED=0
  __COSMOSH_EMPTY=
  __COSMOSH_PS2_MARKER='${__COSMOSH_EMPTY:$((__COSMOSH_BASH_PRIMARY=0)):0}'
fi

__cosmosh_bash_editor_binding_owned() {
  local __cosmosh_bindings
  __cosmosh_bindings="$(builtin bind -m "$1" -X 2>/dev/null)"
  case $'\n'"$__cosmosh_bindings"$'\n' in
    *$'\n'"\"\\e[997;$2~\": \"$3\""$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

__cosmosh_bash_editor_noop() { :; }

__cosmosh_bash_editor_profile_supported() {
  # Only a closed set of native Emacs editing keys is safe to probe automatically.
  # Macros and arbitrary bind-x/completion functions can start a reader without Enter.
  [[ -o emacs ]] || return 1
  [ -z "$(builtin bind -m emacs-standard -s 2>/dev/null)" ] || return 1
  local __cosmosh_mapping __cosmosh_bindings __cosmosh_key __cosmosh_function
  while IFS= builtin read -r __cosmosh_mapping; do
    [ -n "$__cosmosh_mapping" ] || continue
    case "$__cosmosh_mapping" in
      "\"\\e[997;${__COSMOSH_EDITOR_NONCE:-}~\": \"__cosmosh_bash_editor_entry emacs ${__COSMOSH_EDITOR_GENERATION:-0}\""|\
      "\"\\e[997;${__COSMOSH_EDITOR_PREVIOUS_NONCE:-}~\": \"__cosmosh_bash_editor_noop\"") ;;
      *) return 1 ;;
    esac
  done < <(builtin bind -m emacs-standard -X 2>/dev/null)
  __cosmosh_bindings="$(builtin bind -m emacs-standard -p 2>/dev/null)"
  while IFS= builtin read -r __cosmosh_mapping; do
    case "$__cosmosh_mapping" in
      ''|'#'*|'"\C-'*|'"\e'*|*': self-insert') ;;
      *) return 1 ;;
    esac
  done <<< "$__cosmosh_bindings"
  # These are the exact keys Backend can forward while retaining this editor epoch.
  while builtin read -r __cosmosh_key __cosmosh_function; do
    case $'\n'"$__cosmosh_bindings"$'\n' in
      *$'\n'"\"$__cosmosh_key\": $__cosmosh_function"$'\n'*) ;;
      *) return 1 ;;
    esac
  done <<'COSMOSH_NATIVE_KEYS'
\C-a beginning-of-line
\C-b backward-char
\C-d delete-char
\C-e end-of-line
\C-f forward-char
\C-h backward-delete-char
\C-j accept-line
\C-k kill-line
\C-l clear-screen
\C-m accept-line
\C-n next-history
\C-p previous-history
\C-u unix-line-discard
\C-w unix-word-rubout
\C-? backward-delete-char
\e[A previous-history
\e[B next-history
\e[C forward-char
\e[D backward-char
COSMOSH_NATIVE_KEYS
}

__cosmosh_bash_editor_prepare() {
  local __cosmosh_map __cosmosh_mode __cosmosh_old_nonce="${__COSMOSH_EDITOR_NONCE:-}"
  __COSMOSH_EDITOR_AVAILABLE=false
  if ! builtin shopt -q promptvars; then
    case "${PS2-}" in "$__COSMOSH_PS2_MARKER"*) PS2="${PS2#"$__COSMOSH_PS2_MARKER"}" ;; esac
    __COSMOSH_EDITOR_REVOKED=1
    __cosmosh_emit_remote_shell_event editor-state
    return
  fi
  if [ "$__COSMOSH_EDITOR_PS2_INSTALLED" = 0 ]; then
    PS2="$__COSMOSH_PS2_MARKER${PS2-> }"
    __COSMOSH_EDITOR_PS2_INSTALLED=1
  else
    case "${PS2-}" in "$__COSMOSH_PS2_MARKER"*) ;; *) __COSMOSH_EDITOR_REVOKED=1 ;; esac
  fi
  if [ -n "$__cosmosh_old_nonce" ]; then
    for __cosmosh_map in emacs-standard vi-insert vi-command; do
      case "$__cosmosh_map" in emacs-standard) __cosmosh_mode=emacs ;; vi-insert) __cosmosh_mode=vi-insert ;; *) __cosmosh_mode=unsupported ;; esac
      if ! __cosmosh_bash_editor_binding_owned "$__cosmosh_map" "$__cosmosh_old_nonce" "__cosmosh_bash_editor_entry $__cosmosh_mode ${__COSMOSH_EDITOR_GENERATION:-0}"; then
        __COSMOSH_EDITOR_REVOKED=1
      fi
    done
  fi
  if [ "$__COSMOSH_EDITOR_REVOKED" = 1 ] || [ -z "$__COSMOSH_EDITOR_START" ] ||
    [ "$(command locale charmap 2>/dev/null)" != UTF-8 ] || ! __cosmosh_bash_editor_profile_supported; then
    __cosmosh_emit_remote_shell_event editor-state
    return
  fi
  # Keep the previous epoch's key as a no-op. A delayed key cannot attach to the next request.
  for __cosmosh_map in emacs-standard vi-insert vi-command; do
    if [ -n "${__COSMOSH_EDITOR_PREVIOUS_NONCE:-}" ] &&
      __cosmosh_bash_editor_binding_owned "$__cosmosh_map" "$__COSMOSH_EDITOR_PREVIOUS_NONCE" __cosmosh_bash_editor_noop; then
      builtin bind -m "$__cosmosh_map" -r "\\e[997;$__COSMOSH_EDITOR_PREVIOUS_NONCE~" 2>/dev/null
    fi
    if [ -n "$__cosmosh_old_nonce" ]; then
      builtin bind -m "$__cosmosh_map" -x "\"\\e[997;$__cosmosh_old_nonce~\":__cosmosh_bash_editor_noop" 2>/dev/null
    fi
  done
  IFS= builtin read -r __COSMOSH_EDITOR_NONCE < /proc/sys/kernel/random/uuid || return
  __COSMOSH_EDITOR_PREVIOUS_NONCE="$__cosmosh_old_nonce"
  __COSMOSH_EDITOR_GENERATION="$__COSMOSH_PROMPT_GENERATION"
  for __cosmosh_map in emacs-standard vi-insert vi-command; do
    case "$__cosmosh_map" in emacs-standard) __cosmosh_mode=emacs ;; vi-insert) __cosmosh_mode=vi-insert ;; *) __cosmosh_mode=unsupported ;; esac
    if ! builtin bind -m "$__cosmosh_map" -x "\"\\e[997;$__COSMOSH_EDITOR_NONCE~\":__cosmosh_bash_editor_entry $__cosmosh_mode $__COSMOSH_EDITOR_GENERATION" 2>/dev/null ||
      ! __cosmosh_bash_editor_binding_owned "$__cosmosh_map" "$__COSMOSH_EDITOR_NONCE" "__cosmosh_bash_editor_entry $__cosmosh_mode $__COSMOSH_EDITOR_GENERATION"; then
      __COSMOSH_EDITOR_REVOKED=1
      __cosmosh_emit_remote_shell_event editor-state
      return
    fi
  done
  __COSMOSH_EDITOR_AVAILABLE=true
  __cosmosh_emit_remote_shell_event editor-state
}

__cosmosh_bash_editor_entry() {
  local __cosmosh_saved_flags="$-"
  # Disable tracing before touching any editor text; DEBUG chaining excludes this function.
  builtin set +x +T
  __cosmosh_bash_editor_run "$1" "$2" || :
  case "$__cosmosh_saved_flags" in *T*) builtin set -T ;; esac
  case "$__cosmosh_saved_flags" in *x*) builtin set -x ;; esac
  # Readline restores the previous command status; this optional widget must itself succeed.
  return 0
}

__cosmosh_bash_editor_run() {
  [ "${__COSMOSH_BASH_PRIMARY:-0}" = 1 ] && [ "${__COSMOSH_BASH_PREEXEC_READY:-0}" = 1 ] &&
    [ "$__COSMOSH_EDITOR_AVAILABLE" = true ] && [ "$2" = "$__COSMOSH_PROMPT_GENERATION" ] &&
    [ "${READLINE_LINE+x}" = x ] && [ "${READLINE_POINT+x}" = x ] && builtin shopt -q promptvars || return
  case "${PS2-}" in "$__COSMOSH_PS2_MARKER"*) ;; *) return ;; esac
  case "$1" in emacs|vi-insert) ;; *) return ;; esac
  [ "$(command locale charmap 2>/dev/null)" = UTF-8 ] || return
  __cosmosh_bash_editor_profile_supported || return
  local -a __cosmosh_request __cosmosh_response
  local __cosmosh_input=0 __cosmosh_line= __cosmosh_point= __cosmosh_pwd= __cosmosh_home=
  builtin mapfile -t __cosmosh_request < <("$__COSMOSH_EDITOR_BINARY" editor-widget mode "$__COSMOSH_SHELL_INSTANCE_ID" bash "$__COSMOSH_SHELL_OWNER_PID" "$__COSMOSH_EDITOR_START" "$2" "$1" 2>/dev/null)
  [ "${#__cosmosh_request[@]}" = 3 ] || return
  case "${__cosmosh_request[1]}" in
    context) ;;
    snapshot|apply) __cosmosh_input=1; __cosmosh_line="$READLINE_LINE"; __cosmosh_point="$READLINE_POINT" ;;
    *) return ;;
  esac
  if [ "${__cosmosh_request[2]}" = 1 ]; then __cosmosh_pwd="$PWD"; __cosmosh_home="${HOME-}"; fi
  builtin mapfile -t __cosmosh_response < <(
    builtin printf '%s\0' "$__cosmosh_line" "$__cosmosh_point" "$__cosmosh_pwd" "$__cosmosh_home" |
      "$__COSMOSH_EDITOR_BINARY" editor-widget capture "$__COSMOSH_SHELL_INSTANCE_ID" bash "$__COSMOSH_SHELL_OWNER_PID" "$__COSMOSH_EDITOR_START" "$2" "$1" "${__cosmosh_request[0]}" "$__cosmosh_input" "${__cosmosh_request[2]}" 2>/dev/null
  )
  if [ "${#__cosmosh_response[@]}" = 3 ] && [ "${__cosmosh_response[0]}" = apply ]; then
    # Assignment is data-only and stays within this one Readline widget, preserving its undo boundary.
    __cosmosh_line="$(builtin printf '%s' "${__cosmosh_response[1]}" | command base64 -d 2>/dev/null)" || return
    case "${__cosmosh_response[2]}" in ''|*[!0-9]*) return ;; esac
    READLINE_LINE="$__cosmosh_line"
    READLINE_POINT="${__cosmosh_response[2]}"
    builtin printf '%s\0' "$READLINE_LINE" "$READLINE_POINT" "$__cosmosh_pwd" "$__cosmosh_home" |
      "$__COSMOSH_EDITOR_BINARY" editor-widget confirm "$__COSMOSH_SHELL_INSTANCE_ID" bash "$__COSMOSH_SHELL_OWNER_PID" "$__COSMOSH_EDITOR_START" "$2" "$1" "${__cosmosh_request[0]}" 1 "${__cosmosh_request[2]}" >/dev/null 2>&1
  fi
}
`
