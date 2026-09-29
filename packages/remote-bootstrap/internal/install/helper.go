package install

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/nativeassets"
)

// RemoteShellProtocolVersion identifies the OSC event contract emitted by installed helpers.
const RemoteShellProtocolVersion = 3

var fullRemoteShellCapabilities = []string{
	"cwd",
	"command-start",
	"command-end",
	"foreground-command",
	"prompt-ready",
}

var zshRemoteShellCapabilities = append(append([]string(nil), fullRemoteShellCapabilities...), "cwd-invalidated", "line-state", "editor-state", "input-snapshot", "input-apply", "history-read")
var bashRemoteShellCapabilities = append(append([]string(nil), fullRemoteShellCapabilities...), "editor-state", "input-snapshot", "input-apply", "history-read")
var fishRemoteShellCapabilities = append(append([]string(nil), fullRemoteShellCapabilities...), "cwd-invalidated", "editor-state", "input-snapshot", "input-apply", "history-read", "native-completion")

var degradedRemoteShellCapabilities = []string{
	"cwd",
	"prompt-ready",
}

// HelperCapabilities returns only the event capabilities installed reliably for a shell.
func HelperCapabilities(shell string) []string {
	switch shell {
	case "bash":
		return append([]string(nil), bashRemoteShellCapabilities...)
	case "sh", "ash":
		return append([]string(nil), degradedRemoteShellCapabilities...)
	case "zsh":
		return append([]string(nil), zshRemoteShellCapabilities...)
	case "fish":
		return append([]string(nil), fishRemoteShellCapabilities...)
	default:
		return append([]string(nil), fullRemoteShellCapabilities...)
	}
}

// BuildHelper creates the versioned shell integration owned by the Go bootstrap.
func BuildHelper(shell string, version string, binaryPath string) (string, error) {
	if err := validateShell(shell); err != nil {
		return "", err
	}
	if version == "" {
		return "", fmt.Errorf("version is required")
	}
	if (!filepath.IsAbs(binaryPath) && !strings.HasPrefix(binaryPath, "/")) || strings.ContainsRune(binaryPath, 0) {
		return "", fmt.Errorf("absolute bootstrap path is required")
	}

	if shell == "fish" {
		return buildFishHelper(version, binaryPath), nil
	}

	return buildPosixHelper(shell, version, binaryPath), nil
}

// nativePackaged renders an explicit capability gate without probing arbitrary filesystem modules.
func nativePackaged(shell string) int {
	if nativeassets.Available(shell) {
		return 1
	}
	return 0
}

func buildPosixHelper(shell string, version string, binaryPath string) string {
	capabilities := capabilitiesJSON(HelperCapabilities(shell))
	header := fmt.Sprintf(`# Cosmosh Remote Enhancements shell integration.
case "$-" in *i*) ;; *) return 0 ;; esac
# Identity belongs to this Shell process; repeated sourcing preserves it, child Shells get a new identity.
if [ "${__COSMOSH_SHELL_OWNER_PID:-}" != "$$" ]; then
  unset __COSMOSH_SHELL_INSTANCE_ID __COSMOSH_SHELL_OWNER_PID __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED
  IFS= read -r __COSMOSH_SHELL_INSTANCE_ID < /proc/sys/kernel/random/uuid || return 0
  __COSMOSH_SHELL_OWNER_PID=$$
  __COSMOSH_PROMPT_GENERATION=0
fi
if [ -n "${BASH_VERSION:-}" ]; then
  export -n __COSMOSH_SHELL_INSTANCE_ID __COSMOSH_SHELL_OWNER_PID
elif [ -n "${ZSH_VERSION:-}" ]; then
  typeset +x __COSMOSH_SHELL_INSTANCE_ID __COSMOSH_SHELL_OWNER_PID
fi
export COSMOSH_BOOTSTRAP_READY=1
__COSMOSH_REMOTE_SHELL=%s
__COSMOSH_HELPER_VERSION=%s
__COSMOSH_PROTOCOL_VERSION=%d
__COSMOSH_CAPABILITIES_JSON=%s
__COSMOSH_EDITOR_BINARY=%s
__COSMOSH_EDITOR_MODULE=%s
__COSMOSH_NATIVE_PACKAGED=%d
`, quotePOSIX(shell), quotePOSIX(version), RemoteShellProtocolVersion, quotePOSIX(capabilities), quotePOSIX(binaryPath), quotePOSIX(nativeassets.Path(binaryPath, shell)), nativePackaged(shell))

	common := `
__cosmosh_base64_value() {
  printf '%s' "$1" | base64 | tr -d '\r\n'
}

__cosmosh_now_ms() {
  __cosmosh_now_value="$(date +%s%3N 2>/dev/null)"
  case "$__cosmosh_now_value" in
    ""|*[!0-9]*)
      __cosmosh_now_value="$(date +%s 2>/dev/null || printf '0')000"
      ;;
  esac
  printf '%s' "$__cosmosh_now_value"
}

__cosmosh_command_name_from_line() {
  __cosmosh_line="$1"
  __cosmosh_guard=0
  while [ "$__cosmosh_guard" -lt 8 ]; do
    __cosmosh_guard=$((__cosmosh_guard + 1))
    __cosmosh_line="$(printf '%s' "$__cosmosh_line" | sed 's/^[[:space:];|&(){}]*//')" || return 1
    __cosmosh_word="$(printf '%s' "$__cosmosh_line" | sed 's/[[:space:];|&(){}].*$//')" || return 1
    __cosmosh_word="$(printf '%s' "$__cosmosh_word" | sed "s/^[\"']//; s/[\"']$//")" || return 1
    case "$__cosmosh_word" in
      "")
        return 1
        ;;
      command|builtin|exec|env|noglob|time|*=*)
        __cosmosh_line="$(printf '%s' "$__cosmosh_line" | sed 's/^[^[:space:];|&(){}]*[[:space:]]*//')" || return 1
        continue
        ;;
    esac

    __cosmosh_name="${__cosmosh_word##*/}"
    case "$__cosmosh_name" in
      ""|__cosmosh_*|PROMPT_COMMAND|trap)
        return 1
        ;;
    esac

    printf '%s' "$__cosmosh_name"
    return 0
  done

  return 1
}

__cosmosh_emit_remote_shell_event() {
  if [ ! -t 1 ] && [ "${__COSMOSH_CAPTURED_PROMPT_EVENT:-0}" != "1" ]; then
    return 0
  fi
  command -v base64 >/dev/null 2>&1 || return 0

  __cosmosh_event="${1:-}"
  __cosmosh_status="${2:-}"
  __cosmosh_command="${3:-}"
  __cosmosh_command_id="${4:-}"
  __cosmosh_duration="${5:-}"
  __cosmosh_prompt_generation="${6:-}"
  __cosmosh_line_length="${7:-}"
  __cosmosh_cursor_index="${8:-}"
  __cosmosh_timestamp="$(__cosmosh_now_ms)" || return 0
  __cosmosh_json="{\"event\":\"$__cosmosh_event\",\"shell\":\"$__COSMOSH_REMOTE_SHELL\",\"shellInstanceId\":\"$__COSMOSH_SHELL_INSTANCE_ID\",\"helperVersion\":\"$__COSMOSH_HELPER_VERSION\",\"protocolVersion\":$__COSMOSH_PROTOCOL_VERSION,\"capabilities\":$__COSMOSH_CAPABILITIES_JSON,\"timestamp\":$__cosmosh_timestamp"

  case "$__cosmosh_event" in
    cwd)
      __cosmosh_cwd_base64="$(__cosmosh_base64_value "$PWD" 2>/dev/null)" || return 0
      # Encode pwd's output before substitution strips newlines. Backend removes only pwd's final LF.
      __cosmosh_physical_base64="$(command env pwd -P 2>/dev/null | base64 | tr -d '\r\n')" || return 0
      case "${HOME:-}" in
        /*) __cosmosh_home_base64="$(__cosmosh_base64_value "$HOME" 2>/dev/null)" || return 0 ;;
        *) __cosmosh_home_base64= ;;
      esac
      __cosmosh_json="$__cosmosh_json,\"cwdBase64\":\"$__cosmosh_cwd_base64\",\"physicalCwdOutputBase64\":\"$__cosmosh_physical_base64\",\"homeBase64\":\"$__cosmosh_home_base64\""
      if [ -n "$__cosmosh_prompt_generation" ]; then
        __cosmosh_json="$__cosmosh_json,\"promptGeneration\":$__cosmosh_prompt_generation"
      fi
      ;;
    command-start|foreground-command)
      __cosmosh_command_base64="$(__cosmosh_base64_value "$__cosmosh_command" 2>/dev/null)" || return 0
      __cosmosh_json="$__cosmosh_json,\"commandBase64\":\"$__cosmosh_command_base64\",\"commandId\":\"$__cosmosh_command_id\""
      ;;
    command-end)
      __cosmosh_command_base64="$(__cosmosh_base64_value "$__cosmosh_command" 2>/dev/null)" || return 0
      __cosmosh_json="$__cosmosh_json,\"commandBase64\":\"$__cosmosh_command_base64\",\"commandId\":\"$__cosmosh_command_id\",\"exitCode\":$__cosmosh_status,\"durationMs\":$__cosmosh_duration"
      ;;
    prompt-ready)
      if [ -n "$__cosmosh_prompt_generation" ]; then
        __cosmosh_json="$__cosmosh_json,\"promptGeneration\":$__cosmosh_prompt_generation"
      fi
      ;;
    line-state)
      __cosmosh_json="$__cosmosh_json,\"promptGeneration\":$__cosmosh_prompt_generation,\"lineLength\":$__cosmosh_line_length,\"cursorIndex\":$__cosmosh_cursor_index"
      ;;
    cwd-invalidated)
      __cosmosh_json="$__cosmosh_json,\"promptGeneration\":$__COSMOSH_PROMPT_GENERATION"
      ;;
    editor-state)
      __cosmosh_json="$__cosmosh_json,\"promptGeneration\":$__COSMOSH_PROMPT_GENERATION,\"pid\":$__COSMOSH_SHELL_OWNER_PID,\"startTime\":\"$__COSMOSH_EDITOR_START\",\"available\":$__COSMOSH_EDITOR_AVAILABLE,\"triggerNonce\":\"$__COSMOSH_EDITOR_NONCE\""
      if [ "$__COSMOSH_REMOTE_SHELL" = zsh ] && [ -n "${__COSMOSH_EDITOR_NOTIFY_INODE:-}" ]; then
        __cosmosh_json="$__cosmosh_json,\"notification\":{\"fd\":$__COSMOSH_EDITOR_NOTIFY_FD,\"inode\":\"$__COSMOSH_EDITOR_NOTIFY_INODE\"}"
      fi
      if [ "$__COSMOSH_REMOTE_SHELL" = bash ]; then
        __cosmosh_json="$__cosmosh_json,\"notification\":{\"callback\":\"readline\"}"
      fi
      ;;
  esac

  __cosmosh_json="$__cosmosh_json}"
  __cosmosh_payload="$(printf '%s' "$__cosmosh_json" | base64 | tr -d '\r\n')" || return 0
  printf '\033]777;cosmosh;%s\007' "$__cosmosh_payload"
}

__cosmosh_emit_command_start() {
  __cosmosh_command="$(__cosmosh_command_name_from_line "$1" 2>/dev/null)" || return 0
  [ -n "$__cosmosh_command" ] || return 0
  __COSMOSH_COMMAND_SEQUENCE=$((${__COSMOSH_COMMAND_SEQUENCE:-0} + 1))
  __COSMOSH_ACTIVE_COMMAND_START_MS="$(__cosmosh_now_ms)"
  __COSMOSH_ACTIVE_COMMAND_ID="${__COSMOSH_ACTIVE_COMMAND_START_MS}-${__COSMOSH_COMMAND_SEQUENCE}"
  __COSMOSH_ACTIVE_COMMAND_NAME="$__cosmosh_command"
  __cosmosh_emit_remote_shell_event command-start "" "$__COSMOSH_ACTIVE_COMMAND_NAME" "$__COSMOSH_ACTIVE_COMMAND_ID"
  __cosmosh_emit_remote_shell_event foreground-command "" "$__COSMOSH_ACTIVE_COMMAND_NAME" "$__COSMOSH_ACTIVE_COMMAND_ID"
}

__cosmosh_finish_active_command() {
  [ -n "${__COSMOSH_ACTIVE_COMMAND_ID:-}" ] || return 0
  __cosmosh_finished_at="$(__cosmosh_now_ms)"
  __cosmosh_duration=$((__cosmosh_finished_at - __COSMOSH_ACTIVE_COMMAND_START_MS))
  if [ "$__cosmosh_duration" -lt 0 ]; then
    __cosmosh_duration=0
  fi
  __cosmosh_emit_remote_shell_event command-end "$1" "$__COSMOSH_ACTIVE_COMMAND_NAME" "$__COSMOSH_ACTIVE_COMMAND_ID" "$__cosmosh_duration"
  __COSMOSH_ACTIVE_COMMAND_ID=
  __COSMOSH_ACTIVE_COMMAND_NAME=
  __COSMOSH_ACTIVE_COMMAND_START_MS=
}

__cosmosh_prompt_ready() {
  __cosmosh_status="$1"
  __cosmosh_finish_active_command "$__cosmosh_status"
  __COSMOSH_PROMPT_GENERATION=$((${__COSMOSH_PROMPT_GENERATION:-0} + 1))
  __cosmosh_emit_remote_shell_event cwd "" "" "" "" "$__COSMOSH_PROMPT_GENERATION"
  __cosmosh_emit_remote_shell_event prompt-ready "" "" "" "" "$__COSMOSH_PROMPT_GENERATION"
}

__cosmosh_prompt_ready_for_ps1() {
  __COSMOSH_CAPTURED_PROMPT_EVENT=1
  __cosmosh_finish_active_command "$1"
  __cosmosh_emit_remote_shell_event cwd
  # PS1 command substitution runs in a subshell, so a generation counter can
  # never advance in the parent shell; emit without the optional field
  # instead of reporting a constant.
  __cosmosh_emit_remote_shell_event prompt-ready
}
`

	if shell == "bash" {
		// Native PROMPT_COMMAND arrays preserve the original status for every user hook.
		// Older Bash versions retain ordinary terminal behavior without installing unsafe prompt wrappers.
		return header + "\nif (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1) )); then return 0; fi\n" + common + bashEditorHooks + bashHelperHooks
	}
	if shell == "zsh" {
		return header + common + zshEditorHooks + zshHelperHooks
	}

	return header + common + degradedPosixHelperHooks
}

const bashHelperHooks = `
__cosmosh_bash_restore_debug_status() { return "$1"; }
__cosmosh_bash_run_user_debug() { eval "$__COSMOSH_BASH_PREV_DEBUG_CMD"; }

__cosmosh_bash_prompt_command() {
  __COSMOSH_BASH_PROMPT_STATUS=$?
  __COSMOSH_BASH_PREEXEC_READY=0
  __COSMOSH_BASH_PRIMARY=0
  builtin cosmosh_editor disarm >/dev/null 2>&1 || :
  return 0
}

__cosmosh_bash_arm_preexec() {
  # Report after existing prompt commands, which may themselves change directory.
  __cosmosh_prompt_ready "$__COSMOSH_BASH_PROMPT_STATUS"
  __cosmosh_bash_editor_prepare || :
  __COSMOSH_BASH_PREEXEC_READY=1
  __COSMOSH_BASH_PRIMARY=1
  return 0
}

if [ "${__COSMOSH_REMOTE_SHELL_HOOK_INSTALLED:-0}" != "1" ]; then
  __COSMOSH_BASH_PREEXEC_READY=0
  case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
    declare\ -*a*PROMPT_COMMAND=*)
      PROMPT_COMMAND=('__cosmosh_bash_prompt_command || :' "${PROMPT_COMMAND[@]}" '__cosmosh_bash_arm_preexec || :')
      ;;
    *)
      if [ -n "${PROMPT_COMMAND:-}" ]; then
        # Bash restores the previous command status before each array element, including user code.
        PROMPT_COMMAND=('__cosmosh_bash_prompt_command || :' "$PROMPT_COMMAND" '__cosmosh_bash_arm_preexec || :')
      else
        PROMPT_COMMAND=('__cosmosh_bash_prompt_command || :' '__cosmosh_bash_arm_preexec || :')
      fi
      ;;
  esac

  __COSMOSH_BASH_PREV_DEBUG_CMD="$(trap -p DEBUG | sed -n "s/^trap -- '\(.*\)' DEBUG$/\1/p")"
  __cosmosh_bash_debug_trap() {
    local __cosmosh_debug_status=$?
    # Helper internals must never appear as user commands or enter user DEBUG hooks under functrace.
    # Skip this DEBUG function itself when examining its caller chain.
    case " ${FUNCNAME[*]:1} " in *" __cosmosh_"*) return 0 ;; esac
    case "${BASH_COMMAND:-}" in __cosmosh_*) return 0 ;; esac
    local __cosmosh_debug_command="${BASH_COMMAND:-}"
    if [ "${__COSMOSH_BASH_DEBUG_ACTIVE:-0}" != "1" ] && [ "${__COSMOSH_BASH_PREEXEC_READY:-0}" = "1" ]; then
      case "$__cosmosh_debug_command" in
        ""|__cosmosh_*|PROMPT_COMMAND=*|trap\ *)
          ;;
        *)
          __COSMOSH_BASH_PREEXEC_READY=0
          __COSMOSH_BASH_PRIMARY=0
          __COSMOSH_BASH_DEBUG_ACTIVE=1
          __cosmosh_emit_command_start "$__cosmosh_debug_command"
          __COSMOSH_BASH_DEBUG_ACTIVE=0
          ;;
      esac
    fi
    if [ -n "${__COSMOSH_BASH_PREV_DEBUG_CMD:-}" ]; then
      __COSMOSH_BASH_DEBUG_ACTIVE=1
      # The conditional safely restores $? for user code without making Cosmosh fail under errexit.
      # A separate function keeps a user's explicit return from bypassing our cleanup.
      if __cosmosh_bash_restore_debug_status "$__cosmosh_debug_status"; then
        __cosmosh_bash_run_user_debug
      else
        __cosmosh_bash_run_user_debug
      fi
      local __cosmosh_user_debug_status=$?
      __COSMOSH_BASH_DEBUG_ACTIVE=0
      return "$__cosmosh_user_debug_status"
    fi
    # Bash restores the interrupted command status; a failing DEBUG callback itself can trigger errexit.
    return 0
  }

  if trap '__cosmosh_bash_debug_trap' DEBUG; then
    __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED=1
    __cosmosh_emit_remote_shell_event integration-ready
  fi
fi
`

const zshHelperHooks = `
if [ "${__COSMOSH_REMOTE_SHELL_HOOK_INSTALLED:-0}" != "1" ]; then
  __cosmosh_zsh_precmd() {
    builtin typeset __cosmosh_precmd_status=$?
    builtin emulate -L zsh -o noxtrace -o localtraps
    builtin trap '' DEBUG
    # User DEBUG output must not enter metadata command substitutions or duration arithmetic.
    # LOCAL_TRAPS restores the user's handler after this callback completes.
    __cosmosh_prompt_ready "$__cosmosh_precmd_status"
    __COSMOSH_ZSH_REPORTED_PWD="$PWD"
    __COSMOSH_ZSH_REPORTED_HOME="${HOME-}"
    __cosmosh_zsh_editor_prepare || :
  }
  __cosmosh_zsh_preexec() {
    builtin emulate -L zsh -o noxtrace -o localtraps
    builtin trap '' DEBUG
    __cosmosh_emit_command_start "$1"
  }
  __cosmosh_zsh_chpwd() {
    builtin emulate -L zsh -o noxtrace -o localtraps
    builtin trap '' DEBUG
    # Invalidate immediately, including asynchronous traps while ZLE is idle.
    # Publishing a new directory still requires a separate idle editor observation.
    __COSMOSH_ZSH_REPORTED_PWD="$PWD"
    __COSMOSH_ZSH_REPORTED_HOME="${HOME-}"
    __cosmosh_emit_remote_shell_event cwd-invalidated
    return 0
  }
  __cosmosh_zsh_line_pre_redraw() {
    builtin emulate -L zsh -o noxtrace -o localtraps
    builtin trap '' DEBUG
    if [ "${__COSMOSH_ZSH_REPORTED_PWD-}" != "$PWD" ] ||
       [ "${__COSMOSH_ZSH_REPORTED_HOME-}" != "${HOME-}" ]; then
      __cosmosh_zsh_chpwd
    fi
    if [ "${__COSMOSH_LAST_LINE_LENGTH:-}" = "${#BUFFER}" ] && [ "${__COSMOSH_LAST_CURSOR_INDEX:-}" = "$CURSOR" ]; then
      return 0
    fi
    __COSMOSH_LAST_LINE_LENGTH="${#BUFFER}"
    __COSMOSH_LAST_CURSOR_INDEX="$CURSOR"
    __cosmosh_emit_remote_shell_event line-state "" "" "" "" "${__COSMOSH_PROMPT_GENERATION:-0}" "${#BUFFER}" "$CURSOR"
  }

  __cosmosh_zsh_hook_ok=1
  __cosmosh_zsh_zle_hook_installed=0
  if autoload -Uz +X add-zsh-hook 2>/dev/null; then
    add-zsh-hook precmd __cosmosh_zsh_precmd || __cosmosh_zsh_hook_ok=0
    add-zsh-hook preexec __cosmosh_zsh_preexec || __cosmosh_zsh_hook_ok=0
    add-zsh-hook chpwd __cosmosh_zsh_chpwd || __cosmosh_zsh_hook_ok=0
  else
    precmd_functions=(${precmd_functions[@]} __cosmosh_zsh_precmd)
    preexec_functions=(${preexec_functions[@]} __cosmosh_zsh_preexec)
    chpwd_functions=(${chpwd_functions[@]} __cosmosh_zsh_chpwd)
  fi

  # +X loads the widget helper's definition immediately: plain autoload
  # succeeds even when no definition file exists (zsh < 5.3) and would defer
  # the failure to call time, printing a visible error on every startup.
  # Minimal installations may not load ZLE before the first prompt. The stock hook
  # initializer requires that module even though our editor callback runs later.
  if builtin zmodload zsh/zle 2>/dev/null && zmodload zsh/datetime 2>/dev/null &&
     autoload -Uz +X add-zle-hook-widget 2>/dev/null; then
    __cosmosh_now_ms() {
      printf '%.0f' "$((EPOCHREALTIME * 1000))"
    }
    if add-zle-hook-widget line-pre-redraw __cosmosh_zsh_line_pre_redraw 2>/dev/null; then
      __cosmosh_zsh_zle_hook_installed=1
    else
      __cosmosh_zsh_hook_ok=0
    fi
  else
    __cosmosh_zsh_hook_ok=0
  fi

  if [ "$__cosmosh_zsh_hook_ok" = "1" ]; then
    __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED=1
    __cosmosh_emit_remote_shell_event integration-ready
  else
    # Without integration-ready the runtime stays disabled, so the prompt
    # and ZLE hooks would only run for events nothing accepts.
    if [ "$__cosmosh_zsh_zle_hook_installed" = "1" ]; then
      add-zle-hook-widget -d line-pre-redraw __cosmosh_zsh_line_pre_redraw 2>/dev/null
    fi
    precmd_functions=(${precmd_functions[@]:#__cosmosh_zsh_precmd})
    preexec_functions=(${preexec_functions[@]:#__cosmosh_zsh_preexec})
    chpwd_functions=(${chpwd_functions[@]:#__cosmosh_zsh_chpwd})
  fi
fi
`

const degradedPosixHelperHooks = `
if [ "${__COSMOSH_REMOTE_SHELL_HOOK_INSTALLED:-0}" != "1" ] && [ -n "${PS1:-}" ]; then
  __COSMOSH_ORIGINAL_PS1="$PS1"
  PS1='$(__cosmosh_prompt_ready_for_ps1 "$?")'"$__COSMOSH_ORIGINAL_PS1"
  __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED=1
  __cosmosh_emit_remote_shell_event integration-ready
fi
`

func buildFishHelper(version, binaryPath string) string {
	capabilities := capabilitiesJSON(HelperCapabilities("fish"))
	header := fmt.Sprintf(`# Cosmosh Remote Enhancements shell integration.
status is-interactive; or return
if not set -q __COSMOSH_SHELL_OWNER_PID; or test "$__COSMOSH_SHELL_OWNER_PID" != "$fish_pid"
  set -gu __COSMOSH_SHELL_INSTANCE_ID (cat /proc/sys/kernel/random/uuid)
  if not string match -rq '^[a-f0-9-]{36}$' -- "$__COSMOSH_SHELL_INSTANCE_ID"
    return
  end
  set -gu __COSMOSH_SHELL_OWNER_PID $fish_pid
  set -gu __COSMOSH_PROMPT_GENERATION 0
  set -eg __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED
end
set -gx COSMOSH_BOOTSTRAP_READY 1
set -gu __COSMOSH_REMOTE_SHELL fish
set -gu __COSMOSH_HELPER_VERSION %s
set -gu __COSMOSH_PROTOCOL_VERSION %d
set -gu __COSMOSH_CAPABILITIES_JSON %s
set -gu __COSMOSH_EDITOR_BINARY %s
`, quoteFish(version), RemoteShellProtocolVersion, quoteFish(capabilities), quoteFish(binaryPath))

	return header + fishEditorHooks + fishHelperBody
}

const fishHelperBody = `
function __cosmosh_base64_value
  builtin printf '%s' "$argv[1]" | command base64 | command tr -d '\r\n'
end

function __cosmosh_now_ms
  builtin set -l value (command date +%s%3N 2>/dev/null)
  if not builtin string match -rq '^[0-9]+$' -- "$value"
    builtin set value (command date +%s 2>/dev/null)
    if builtin test -z "$value"
      builtin set value 0
    end
    builtin set value "$value"000
  end
  builtin printf '%s' "$value"
end

function __cosmosh_command_name_from_line
  set -l line (string trim -- "$argv[1]")
  set -l guard 0
  while test $guard -lt 8
    set guard (math $guard + 1)
    set line (string replace -r '^[[:space:];|&(){}]*' '' -- "$line")
    set -l word (string replace -r '[[:space:];|&(){}].*$' '' -- "$line")
    switch $word
      case ''
        return 1
      case command builtin exec env noglob time '*=*'
        set line (string replace -r '^[^[:space:];|&(){}]*[[:space:]]*' '' -- "$line")
        continue
    end

    set -l name (basename -- "$word" 2>/dev/null)
    switch $name
      case '' '__cosmosh_*' PROMPT_COMMAND trap
        return 1
    end

    printf '%s' "$name"
    return 0
  end

  return 1
end

function __cosmosh_emit_remote_shell_event
  # Prompt functions run inside Fish's output capture; send their metadata to the PTY.
  builtin set -l prompt_report $argv[9]
  if builtin test "$prompt_report" != prompt; and not builtin test -t 1
    builtin return 0
  end
  if not command -q base64
    builtin return 0
  end

  builtin set -l event $argv[1]
  builtin set -l exit_status $argv[2]
  builtin set -l command_name $argv[3]
  builtin set -l command_id $argv[4]
  builtin set -l duration $argv[5]
  builtin set -l prompt_generation $argv[6]
  builtin set -l line_length $argv[7]
  builtin set -l cursor_index $argv[8]
  builtin set -l timestamp (__cosmosh_now_ms)
  builtin set -l json "{\"event\":\"$event\",\"shell\":\"$__COSMOSH_REMOTE_SHELL\",\"shellInstanceId\":\"$__COSMOSH_SHELL_INSTANCE_ID\",\"helperVersion\":\"$__COSMOSH_HELPER_VERSION\",\"protocolVersion\":$__COSMOSH_PROTOCOL_VERSION,\"capabilities\":$__COSMOSH_CAPABILITIES_JSON,\"timestamp\":$timestamp"

  switch $event
    case cwd
      set -l cwd_base64 (__cosmosh_base64_value "$PWD")
      # Base64 prevents command substitution from splitting or stripping path newlines.
      set -l physical_base64 (command env pwd -P 2>/dev/null | base64 | tr -d '\r\n')
      set -l home_base64 ""
      if string match -rq '^/' -- "$HOME"
        set home_base64 (__cosmosh_base64_value "$HOME")
      end
      set json "$json,\"cwdBase64\":\"$cwd_base64\",\"physicalCwdOutputBase64\":\"$physical_base64\",\"homeBase64\":\"$home_base64\",\"promptGeneration\":$prompt_generation"
    case command-start foreground-command
      set -l command_base64 (__cosmosh_base64_value "$command_name")
      set json "$json,\"commandBase64\":\"$command_base64\",\"commandId\":\"$command_id\""
    case command-end
      set -l command_base64 (__cosmosh_base64_value "$command_name")
      set json "$json,\"commandBase64\":\"$command_base64\",\"commandId\":\"$command_id\",\"exitCode\":$exit_status,\"durationMs\":$duration"
    case prompt-ready cwd-invalidated
      set json "$json,\"promptGeneration\":$prompt_generation"
    case editor-state
      builtin set json "$json,\"promptGeneration\":$__COSMOSH_PROMPT_GENERATION,\"pid\":$fish_pid,\"startTime\":\"$__COSMOSH_EDITOR_START\",\"available\":$__COSMOSH_EDITOR_AVAILABLE,\"triggerNonce\":\"$__COSMOSH_SHELL_INSTANCE_ID\""
      if builtin test "$__COSMOSH_EDITOR_AVAILABLE" = true
        builtin set json "$json,\"notification\":{\"signal\":\"URG\"}"
      end
  end

  builtin set json "$json}"
  builtin set -l payload (builtin printf '%s' "$json" | command base64 | command tr -d '\r\n')
  if builtin test "$prompt_report" = prompt
    builtin printf '\e]777;cosmosh;%s\a' "$payload" >/dev/tty
  else
    builtin printf '\e]777;cosmosh;%s\a' "$payload"
  end
end

function __cosmosh_emit_command_start
  set -l command_name (__cosmosh_command_name_from_line "$argv[1]")
  if test -z "$command_name"
    return 0
  end

  if not set -q __COSMOSH_COMMAND_SEQUENCE
    set -g __COSMOSH_COMMAND_SEQUENCE 0
  end
  set -g __COSMOSH_COMMAND_SEQUENCE (math $__COSMOSH_COMMAND_SEQUENCE + 1)
  set -g __COSMOSH_ACTIVE_COMMAND_START_MS (__cosmosh_now_ms)
  set -g __COSMOSH_ACTIVE_COMMAND_ID "$__COSMOSH_ACTIVE_COMMAND_START_MS-$__COSMOSH_COMMAND_SEQUENCE"
  set -g __COSMOSH_ACTIVE_COMMAND_NAME "$command_name"
  __cosmosh_emit_remote_shell_event command-start "" "$command_name" "$__COSMOSH_ACTIVE_COMMAND_ID"
  __cosmosh_emit_remote_shell_event foreground-command "" "$command_name" "$__COSMOSH_ACTIVE_COMMAND_ID"
end

if not set -q __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED
  function __cosmosh_on_preexec --on-event fish_preexec
    set -g __COSMOSH_FISH_EDITING 0
    set -e __COSMOSH_DIRECTORY_REPORTED
    __cosmosh_emit_command_start "$argv[1]"
  end

  function __cosmosh_report_prompt
    if not set -q __COSMOSH_PROMPT_GENERATION
      set -g __COSMOSH_PROMPT_GENERATION 0
    end
    set -g __COSMOSH_PROMPT_GENERATION (math $__COSMOSH_PROMPT_GENERATION + 1)
    __cosmosh_emit_remote_shell_event cwd "" "" "" "" "$__COSMOSH_PROMPT_GENERATION" "" "" prompt
    __cosmosh_emit_remote_shell_event prompt-ready "" "" "" "" "$__COSMOSH_PROMPT_GENERATION" "" "" prompt
    set -g __COSMOSH_FISH_EDITING 1
    __cosmosh_fish_editor_prepare
    set -g __COSMOSH_REPORTED_PWD "$PWD"
    set -g __COSMOSH_REPORTED_HOME "$HOME"
    set -g __COSMOSH_DIRECTORY_REPORTED 1
  end

  # A title function or later prompt hook may still change the directory after reporting.
  # Such changes only invalidate this generation; they never announce a new usable prompt.
  function __cosmosh_invalidate_directory --on-variable PWD --on-variable HOME
    set -q __COSMOSH_DIRECTORY_REPORTED; or return
    if test "$PWD" = "$__COSMOSH_REPORTED_PWD"; and test "$HOME" = "$__COSMOSH_REPORTED_HOME"
      return
    end
    set -e __COSMOSH_DIRECTORY_REPORTED
    __cosmosh_emit_remote_shell_event cwd-invalidated "" "" "" "" "$__COSMOSH_PROMPT_GENERATION" "" "" prompt
  end

  function __cosmosh_on_prompt --on-event fish_prompt
    set -e __COSMOSH_DIRECTORY_REPORTED
    # Leave user prompt functions intact. Later directory changes invalidate this report.
    __cosmosh_report_prompt
  end

  function __cosmosh_on_postexec --on-event fish_postexec
    set -l command_status $status
    if not set -q __COSMOSH_ACTIVE_COMMAND_ID
      return 0
    end
    set -l finished_at (__cosmosh_now_ms)
    set -l duration (math "max(0, $finished_at - $__COSMOSH_ACTIVE_COMMAND_START_MS)")
    __cosmosh_emit_remote_shell_event command-end "$command_status" "$__COSMOSH_ACTIVE_COMMAND_NAME" "$__COSMOSH_ACTIVE_COMMAND_ID" "$duration"
    set -e __COSMOSH_ACTIVE_COMMAND_ID
    set -e __COSMOSH_ACTIVE_COMMAND_NAME
    set -e __COSMOSH_ACTIVE_COMMAND_START_MS
  end

  set -gu __COSMOSH_REMOTE_SHELL_HOOK_INSTALLED 1
  __cosmosh_emit_remote_shell_event integration-ready
end
`

func capabilitiesJSON(capabilities []string) string {
	quoted := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		quoted = append(quoted, fmt.Sprintf("%q", capability))
	}

	return "[" + strings.Join(quoted, ",") + "]"
}

func quotePOSIX(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func quoteFish(value string) string {
	var builder strings.Builder
	builder.WriteByte('\'')
	for _, char := range value {
		if char == '\\' || char == '\'' {
			builder.WriteByte('\\')
		}
		builder.WriteRune(char)
	}
	builder.WriteByte('\'')
	return builder.String()
}
