package install

// bashEditorHooks arms a native Readline idle callback. It never installs or injects a terminal key.
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

__cosmosh_bash_editor_profile_supported() {
  # Unknown script bindings and macros can open their own reader without executing a command line.
  [[ -o emacs ]] || return 1
  [ -z "$(builtin bind -m emacs-standard -s 2>/dev/null)" ] || return 1
  [ -z "$(builtin bind -m emacs-standard -X 2>/dev/null)" ] || return 1
  local __cosmosh_mapping __cosmosh_bindings __cosmosh_key __cosmosh_function
  __cosmosh_bindings="$(builtin bind -m emacs-standard -p 2>/dev/null)"
  while IFS= builtin read -r __cosmosh_mapping; do
    case "$__cosmosh_mapping" in
      ''|'#'*|'"\C-'*|'"\e'*|*': self-insert') ;;
      *) return 1 ;;
    esac
  done <<< "$__cosmosh_bindings"
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
  __COSMOSH_EDITOR_AVAILABLE=false
  if ! builtin shopt -q promptvars; then
    case "${PS2-}" in "$__COSMOSH_PS2_MARKER"*) PS2="${PS2#"$__COSMOSH_PS2_MARKER"}" ;; esac
    __COSMOSH_EDITOR_REVOKED=1
  fi
  if [ "$__COSMOSH_EDITOR_PS2_INSTALLED" = 0 ]; then
    PS2="$__COSMOSH_PS2_MARKER${PS2-> }"
    __COSMOSH_EDITOR_PS2_INSTALLED=1
  else
    case "${PS2-}" in "$__COSMOSH_PS2_MARKER"*) ;; *) __COSMOSH_EDITOR_REVOKED=1 ;; esac
  fi
  if [ "$__COSMOSH_EDITOR_REVOKED" = 1 ] || [ -z "$__COSMOSH_EDITOR_START" ] ||
    [ "$__COSMOSH_NATIVE_PACKAGED" != 1 ] || [ "$(command locale charmap 2>/dev/null)" != UTF-8 ] ||
    ! __cosmosh_bash_editor_profile_supported; then
    __cosmosh_emit_remote_shell_event editor-state
    return 0
  fi
  if ! builtin cosmosh_editor status >/dev/null 2>&1; then
    if ! builtin enable -f "$__COSMOSH_EDITOR_MODULE" cosmosh_editor 2>/dev/null; then
      __cosmosh_emit_remote_shell_event editor-state
      return 0
    fi
  fi
  IFS= builtin read -r __COSMOSH_EDITOR_NONCE < /proc/sys/kernel/random/uuid || return 0
  if builtin cosmosh_editor arm >/dev/null 2>&1; then __COSMOSH_EDITOR_AVAILABLE=true; fi
  __cosmosh_emit_remote_shell_event editor-state
  return 0
}
`
