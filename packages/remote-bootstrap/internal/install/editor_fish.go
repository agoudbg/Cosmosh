package install

// fishEditorHooks uses the live commandline API from Fish 4.0.1+, with no injected terminal key.
// Permission is granted over the request socket before reading input; events suppress fish_trace.
const fishEditorHooks = `
function __cosmosh_fish_editor_owned
  builtin test "$__COSMOSH_EDITOR_OWNER_PID" = "$fish_pid"; or builtin return 1
  builtin set -l handlers (builtin functions --handlers --handlers-type signal | builtin string match -r '^SIGURG .*')
  builtin test (builtin count $handlers) = 1; and builtin test "$handlers[1]" = 'SIGURG __cosmosh_fish_editor_notify'; or builtin return 1
  builtin test (builtin functions __cosmosh_fish_editor_notify | builtin string collect) = "$__COSMOSH_FISH_NOTIFY_DEFINITION"
end

function __cosmosh_fish_editor_prepare
  # Observe privacy policy even while the editor is unavailable (for example native grey text).
  # Removing a hook can itself leave its just-rejected command temporarily visible in history.
  __cosmosh_fish_history_observe_policy (builtin functions --names --all)
  builtin set -g __COSMOSH_EDITOR_AVAILABLE false
  builtin set -g __COSMOSH_FISH_PROFILE_SUPPORTED 0
  builtin set -g __COSMOSH_FISH_TITLE_PENDING 1
  if not builtin set -q __COSMOSH_EDITOR_OWNER_PID; or builtin test "$__COSMOSH_EDITOR_OWNER_PID" != "$fish_pid"
    builtin set -gu __COSMOSH_EDITOR_OWNER_PID $fish_pid
    builtin set -gu __COSMOSH_EDITOR_START (command "$__COSMOSH_EDITOR_BINARY" editor-identity "$fish_pid" 2>/dev/null)
    builtin status is-interactive-read 2>/dev/null
    builtin set -l supported $status
    if builtin test $supported -le 1; and builtin string match -rq '^4\.' -- "$version"; and \
        not builtin functions --handlers --handlers-type signal | builtin string match -rq '^SIGURG '
      __cosmosh_fish_editor_install_title; or begin
        __cosmosh_emit_remote_shell_event editor-state "" "" "" "" "" "" "" prompt
        builtin return 0
      end
      function __cosmosh_fish_editor_notify --on-signal URG
        # Check the inherited parser state before any command substitution of our own.
        if builtin status is-command-substitution
          __cosmosh_fish_editor_reject
          builtin return 0
        end
        __cosmosh_fish_editor_observe
        builtin return 0
      end
      builtin set -gu __COSMOSH_FISH_NOTIFY_DEFINITION (builtin functions __cosmosh_fish_editor_notify | builtin string collect)
    end
  end
  if builtin test -n "$__COSMOSH_EDITOR_START"; and __cosmosh_fish_editor_owned; and \
      builtin test (builtin functions fish_title | builtin string collect) = "$__COSMOSH_FISH_TITLE_DEFINITION"; and \
      builtin test (command locale charmap 2>/dev/null) = UTF-8; and builtin test "$fish_autosuggestion_enabled" = 0
    builtin set -g __COSMOSH_EDITOR_AVAILABLE true
  end
  # Eligible readers publish only after title/configuration inspection has completed.
  if builtin test "$__COSMOSH_EDITOR_AVAILABLE" != true
    __cosmosh_emit_remote_shell_event editor-state "" "" "" "" "" "" "" prompt
  end
end

function __cosmosh_fish_editor_install_title
  # Copy the actual title only at the first native prompt, after user startup configuration.
  # Never overwrite an existing private name or reclaim a title replaced later by user code.
  not builtin functions --names --all | builtin string match -q __cosmosh_fish_original_title; or builtin return 1
  builtin functions --query fish_title; or builtin return 1
  # Redefining a function would remove its event subscriptions, which functions --copy does not copy.
  not builtin functions --handlers | builtin string match -rq '[[:space:]]fish_title$'; or builtin return 1
  builtin functions --copy fish_title __cosmosh_fish_original_title; or builtin return 1
  function fish_title
    # Calling the original first preserves both incoming status and pipestatus.
    __cosmosh_fish_original_title $argv
    builtin set -l title_status $status
    # Prompt/title code can install a history policy after prepare, even while precise editing
    # is disabled. Observe it before the availability gate so later removal cannot reveal a private entry.
    __cosmosh_fish_history_observe_policy (builtin functions --names --all)
    builtin set -g __COSMOSH_FISH_PROFILE_SUPPORTED 0
    builtin set -l pending "$__COSMOSH_FISH_TITLE_PENDING"
    builtin set -g __COSMOSH_FISH_TITLE_PENDING 0
    # Only the first title following the prompt event can authorize this generation. Repaints or
    # user-invoked titles can revoke it, but cannot re-enable an uncertain native key sequence.
    if builtin test "$pending" = 1; and builtin test (builtin count $argv) = 0; and builtin test "$__COSMOSH_FISH_EDITING" = 1; and \
        builtin test "$__COSMOSH_EDITOR_AVAILABLE" = true; and builtin status is-command-substitution
      builtin status is-interactive-read 2>/dev/null
      builtin set -l read_status $status
      # Native title evaluation has only this function frame and its caller's command substitution.
      # Inspect the structure, not translated diagnostic words. Nested user/event calls add frames.
      builtin set -l trace
      builtin status stack-trace | builtin read --null --local trace
      builtin set -l frames (builtin string split \n -- "$trace" | builtin string match -r '.+')
      if builtin test "$read_status" = 1; and not builtin status is-breakpoint; and \
          builtin test (builtin count $frames) = 2; and builtin string match -q "*'fish_title'*" -- "$frames[1]"
        if __cosmosh_fish_editor_configuration_supported; and __cosmosh_fish_editor_profile_supported
          builtin set -g __COSMOSH_FISH_HANDLER_PROFILE (builtin functions --handlers | builtin string collect)
          builtin set -g __COSMOSH_FISH_PROFILE_SUPPORTED 1
        end
      end
    end
    if builtin test "$__COSMOSH_FISH_PROFILE_SUPPORTED" != 1
      builtin set -g __COSMOSH_EDITOR_AVAILABLE false
    end
    # Publish after the final decision. The emitter cannot invoke user function overrides and
    # writes its OSC only after encoding has finished; the sole remaining action is returning.
    __cosmosh_emit_remote_shell_event editor-state "" "" "" "" "" "" "" prompt
    builtin return $title_status
  end
  builtin set -gu __COSMOSH_FISH_TITLE_DEFINITION (builtin functions fish_title | builtin string collect)
  builtin return 0
end

function __cosmosh_fish_editor_invalidate_profile --on-variable fish_key_bindings --on-variable fish_bind_mode --on-variable fish_function_path --on-variable fish_autosuggestion_enabled
  # Variable hooks may run while the matcher holds its lock. They only revoke the cached decision.
  builtin set -g __COSMOSH_FISH_PROFILE_SUPPORTED 0
end

function __cosmosh_fish_editor_configuration_supported
  # Functional abbreviations and user event handlers can change mappings after the title checkpoint.
  # Listing names does not autoload; never query an unregistered user hook just to inspect it.
  builtin set -l names (builtin functions --names --all)
  __cosmosh_fish_history_observe_policy $names
  for forbidden in fish_user_key_bindings fish_should_add_to_history commandline count set return test string printf functions echo contains status breakpoint
    not builtin contains -- "$forbidden" $names; or builtin return 1
  end
  for abbreviation in (builtin abbr --show)
    builtin set -l tokens
    builtin printf '%s\n' "$abbreviation" | builtin read --tokenize --array tokens; or builtin return 1
    not builtin contains -- --function $tokens; and not builtin contains -- -f $tokens; or builtin return 1
  end
  builtin set -l checked
  for handler in (builtin functions --handlers)
    builtin set -l fields (builtin string split --no-empty ' ' -- (builtin string trim -- "$handler"))
    builtin test (builtin count $fields) = 0; and continue
    builtin test "$fields[1]" = Event; and continue
    builtin test (builtin count $fields) = 2; or builtin return 1
    builtin set -l name "$fields[2]"
    builtin contains -- "$name" $checked; and continue
    switch "$name"
      case __cosmosh_on_preexec __cosmosh_on_postexec __cosmosh_on_prompt __cosmosh_invalidate_directory __cosmosh_fish_editor_notify __cosmosh_fish_editor_invalidate_profile
        continue
    end
    # Reject unknown handlers before any definition query. A registered autoloaded function can
    # reload its source, so exclude all external candidates for these installed handler names.
    switch "$name"
      case fish_sigtrap_handler __fish_winch_handler __fish_update_cwd_osc __fish_git_prompt_reset_char __fish_git_prompt_reset_color __fish_git_prompt_reset __fish_reload_key_bindings __fish_reconstruct_path
      case '*'
        builtin return 1
    end
    __cosmosh_fish_editor_stock_definition "$name"; or builtin return 1
    builtin set -a checked "$name"
  end
  for action in up-or-search down-or-search __init_uvar
    __cosmosh_fish_editor_stock_definition "$action"; or builtin return 1
  end
  builtin return 0
end

function __cosmosh_fish_editor_stock_definition
  __cosmosh_fish_editor_stock_source "$argv[1]"; or builtin return 1
  builtin set -l origin (builtin functions --details "$argv[1]")
  if builtin test "$origin" != stdin
    builtin string match -q "$__fish_data_dir/*" -- "$origin"
    builtin return $status
  end
  # Fish's interactive initializer loses source metadata for these four definitions. Pins cover
  # the complete definitions observed in the official 4.0.1 runtime; unknown variants stay paused.
  builtin set -l expected
  switch "$argv[1]"
    case __fish_winch_handler
      builtin set expected 268fd973b39770be0586619de388427d3dc42c7e99d9c532aabea245f2a47500
    case __fish_update_cwd_osc
      builtin set expected b5965095ffee7d781807cae28fe4dc80185384d9db4d2ad73c5c8ffe33e3b502
    case __fish_reload_key_bindings
      builtin set expected fa6df88bc7a35d76de41c90b9d71c3865e7d9c2694aac1175f8f3e530a7bbfba
    case __init_uvar
      builtin set expected 86ef242f5bb70723bcd9c60d5c3674ad656ab80a9eb8b79533193e43f159958c
    case '*'
      builtin return 1
  end
  builtin set -l digest (builtin functions "$argv[1]" | command sha256sum | builtin string split ' ')[1]
  builtin test "$digest" = "$expected"
end

function __cosmosh_fish_editor_stock_source
  for directory in $fish_function_path
    builtin test "$directory" = "$__fish_data_dir/functions"; and continue
    not builtin test -e "$directory/$argv[1].fish"; or builtin return 1
  end
  builtin return 0
end

function __cosmosh_fish_editor_key_supported
  # Keep this list aligned with Backend's allowed complete transport key sequences.
  switch "$argv[1]"
    case '' space minus comma enter backspace delete home end up down left right tab shift-tab ctrl-i ctrl-r
      builtin return 0
    case ctrl-a ctrl-b ctrl-c ctrl-d ctrl-e ctrl-f ctrl-g ctrl-h ctrl-j ctrl-k ctrl-l ctrl-m ctrl-n ctrl-p ctrl-s ctrl-t ctrl-u ctrl-w ctrl-y ctrl-z ctrl-/ ctrl-_
      builtin return 0
    case '*'
      builtin string match -rq '^[^\x00-\x1f\x7f-\x9f]$' -- "$argv[1]"
  end
end

function __cosmosh_fish_editor_profile_supported
  # Only call this after a verified native title invocation, never from a signal or variable hook.
  # Fish holds its mapping mutex while waiting for a custom key prefix; bind would deadlock there.
  for mapping in (builtin bind --preset -M default) (builtin bind --user -M default)
    builtin set -l tokens
    builtin printf '%s\n' "$mapping" | builtin read --tokenize --array tokens; or builtin return 1
    builtin test "$tokens[1]" = bind; or builtin return 1
    builtin set -e tokens[1]
    if builtin test "$tokens[1]" = --preset
      builtin set -e tokens[1]
    end
    if builtin test "$tokens[1]" = -M
      builtin test "$tokens[2]" = default; or builtin return 1
      builtin set -e tokens[1..2]
    end
    builtin set -l terminfo 0
    if builtin test "$tokens[1]" = -k
      builtin set terminfo 1
      builtin set -e tokens[1]
    end
    builtin test (builtin count $tokens) -ge 2; or builtin return 1
    # Mode-changing/unknown options are not a key name. Fish may wait for an action argument
    # before announcing the changed bind mode, so its variable hook is not an adequate guard.
    not builtin string match -rq '^-' -- "$tokens[1]"; or builtin return 1
    builtin set -l key "$tokens[1]"
    builtin set -e tokens[1]
    builtin set -l first (builtin string split -m 1 , -- "$key")[1]
    if builtin test "$terminfo" = 1
      switch "$key"
        case up down left right home end dc btab
        case '*'
          continue
      end
    else if builtin string match -rq '^\e' -- "$key"
      builtin set -l recognized 0
      for complete in \e\[A \e\[B \e\[C \e\[D \e\[H \e\[F \e\[Z \e\[1~ \e\[3~ \e\[4~ \e\[7~ \e\[8~
        if builtin test (builtin string sub -l (builtin string length -- "$key") -- "$complete") = "$key"; or \
            builtin test (builtin string sub -l (builtin string length -- "$complete") -- "$key") = "$complete"
          # Either prefix direction can consume a complete transport key or wait for more input.
          builtin test "$key" = "$complete"; or builtin return 1
          builtin set recognized 1
          break
        end
      end
      builtin test "$recognized" = 1; or continue
    else
      __cosmosh_fish_editor_key_supported "$first"; or continue
      builtin test "$first" = "$key"; or builtin return 1
    end
    for action in $tokens
      switch "$action"
        case self-insert expand-abbr beginning-of-line end-of-line backward-char forward-char backward-delete-char delete-char delete-or-exit
        case backward-kill-line backward-kill-path-component backward-kill-word kill-line clear-screen clear-commandline cancel-commandline cancel
        case execute exit pager-toggle-search history-search-backward history-search-forward up-line down-line
        case transpose-chars yank undo redo
        case complete complete-and-search history-pager
        case up-or-search down-or-search
          # Their installed definitions and dependencies were checked before taking the mapping snapshot.
        case '*'
          builtin return 1
      end
    end
  end
  builtin return 0
end

function __cosmosh_fish_editor_supported
  builtin test "$__COSMOSH_FISH_EDITING" = 1; and builtin test "$__COSMOSH_EDITOR_AVAILABLE" = true; or builtin return 1
  # Native autosuggestions can autoload arbitrary completion scripts while typing, after the
  # mapping checkpoint. Require an explicit user opt-out; never change the user's setting.
  builtin test "$fish_autosuggestion_enabled" = 0; or builtin return 1
  builtin test "$__COSMOSH_FISH_PROFILE_SUPPORTED" = 1; or builtin return 1
  builtin test (builtin functions --handlers | builtin string collect) = "$__COSMOSH_FISH_HANDLER_PROFILE"; or builtin return 1
  builtin status is-interactive-read 2>/dev/null
  builtin test $status = 1; or builtin return 1
  not builtin status is-breakpoint; or builtin return 1
  if builtin set -q fish_bind_mode; and builtin test "$fish_bind_mode" != default
    builtin return 1
  end
  not builtin commandline --search-mode; or builtin return 1
  not builtin commandline --paging-mode; or builtin return 1
  # A zero-width selection is still an active selection.
  not builtin commandline --selection-start >/dev/null 2>&1; or builtin return 1
  __cosmosh_fish_editor_owned
end

function __cosmosh_fish_editor_reject
  command "$__COSMOSH_EDITOR_BINARY" editor-widget reject "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" unsupported $argv >/dev/null 2>&1
end

function __cosmosh_fish_editor_observe
  __cosmosh_fish_editor_supported; or begin
    __cosmosh_fish_editor_reject
    builtin return 0
  end
  builtin set -l request (command "$__COSMOSH_EDITOR_BINARY" editor-widget mode "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs 2>/dev/null)
  if builtin test (builtin count $request) != 6
    builtin test (builtin count $request) = 8; and builtin test "$request[2]" = history-delete; or builtin return 0
  end
  __cosmosh_fish_editor_supported; or begin
    __cosmosh_fish_editor_reject "$request[1]"
    builtin return 0
  end
  builtin set -l include_input 0
  builtin set -l capture_phase capture
  builtin set -l line ''
  builtin set -l point ''
  builtin set -l directory ''
  builtin set -l user_home ''
  switch "$request[2]"
    case history-delete
      __cosmosh_fish_history_delete "$request[1]" "$request[7]" "$request[8]" "$request[4]" "$request[5]" "$request[6]"
      builtin return 0
    case history
      __cosmosh_fish_history_read "$request[1]"
      builtin return 0
    case context
    case snapshot apply native-completion
      builtin set include_input 1
      if builtin test "$request[2]" = native-completion
        builtin set capture_phase completion
      end
      # Keep commandline's one output newline. The Go boundary removes exactly that byte.
      builtin set line (builtin commandline --current-buffer | builtin string collect --no-trim-newlines --allow-empty)
      builtin set point (builtin commandline --cursor)
    case '*'
      builtin return 0
  end
  if builtin test "$request[3]" = 1
    builtin set directory "$PWD"
    builtin set user_home "$HOME"
  end
  builtin set -l response (builtin printf '%s\0' "$line" "$point" "$directory" "$user_home" |
    command "$__COSMOSH_EDITOR_BINARY" editor-widget "$capture_phase" "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$request[1]" "$include_input" "$request[3]" 2>/dev/null)
  if builtin test (builtin count $response) = 3; and builtin test "$response[1]" = apply
    __cosmosh_fish_editor_supported; or begin
      __cosmosh_fish_editor_reject "$request[1]"
      builtin return 0
    end
    builtin test (builtin commandline --current-buffer | builtin string collect --no-trim-newlines --allow-empty) = "$line"; and \
      builtin test (builtin commandline --cursor) = "$point"; or begin
      __cosmosh_fish_editor_reject "$request[1]"
      builtin return 0
    end
    builtin set -l replacement ''
    if builtin test "$response[2]" != -
      builtin set replacement (builtin printf '%s' "$response[2]" | command base64 -d | builtin string collect --allow-empty)
      builtin test $status = 0; or builtin return 0
    end
    builtin string match -rq '^[0-9]+$' -- "$response[3]"; or builtin return 0
    # Group both assignments: Fish otherwise records a second undo step for the cursor change.
    builtin commandline --function begin-undo-group
    __cosmosh_fish_editor_apply "$request[1]" "$request[4]" "$request[5]" "$request[6]" "$line" "$point" "$replacement" "$response[3]"
    builtin set -l applied $status
    builtin commandline --function end-undo-group
    if builtin test "$applied" != 0
      __cosmosh_fish_editor_reject "$request[1]"
      builtin return 0
    end
    builtin set -l confirmed (builtin printf '%s\0' (builtin commandline --current-buffer | builtin string collect --no-trim-newlines --allow-empty) (builtin commandline --cursor) "$directory" "$user_home" |
      command "$__COSMOSH_EDITOR_BINARY" editor-widget confirm "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$request[1]" 1 "$request[3]" 2>/dev/null)
  end
  builtin return 0
end

function __cosmosh_fish_editor_apply --argument-names request_id epoch sequence state_path original_line original_point replacement replacement_point
  # Defer event handlers until the function returns, after its scoped descriptor has closed.
  # The full binding/profile check and all decoding have already finished outside this scope.
  builtin block --local
  builtin set -l applied 0
  begin
    if command "$__COSMOSH_EDITOR_BINARY" editor-input-lock "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$epoch" "$sequence" "$request_id"; and \
        builtin test "$__COSMOSH_FISH_EDITING" = 1; and builtin test "$fish_bind_mode" = default; and \
        not builtin commandline --search-mode; and not builtin commandline --paging-mode; and \
        not builtin commandline --selection-start >/dev/null 2>&1; and \
        builtin test (builtin commandline --current-buffer | builtin string collect --no-trim-newlines --allow-empty) = "$original_line"; and \
        builtin test (builtin commandline --cursor) = "$original_point"
      builtin commandline --replace -- "$replacement"
      builtin commandline --cursor "$replacement_point"
      builtin set applied 1
    end
  end 9<"$state_path" 2>/dev/null
  builtin test "$applied" = 1
end

function __cosmosh_fish_history_scope
  # Keep reads and deletes under the same original-Shell privacy and namespace decision.
  builtin set -l namespace fish
  if builtin set -q fish_history
    if builtin test (builtin count $fish_history) = 0
      builtin set namespace ''
    else if builtin test (builtin count $fish_history) = 1
      builtin set namespace "$fish_history[1]"
    else
      builtin return 1
    end
  end
  if builtin test -n "$fish_private_mode"; or builtin test -z "$namespace"
    builtin printf 'private\n'
    builtin return 0
  end
  # Invalid names fall back inside Fish. Decline them instead of misidentifying the source.
  builtin string match -rq '^[A-Za-z0-9_]+$' -- "$namespace"; or builtin return 1
  __cosmosh_fish_history_observe_policy (builtin functions --names --all)
  if builtin test "$__COSMOSH_FISH_HISTORY_POLICY_UNTRUSTED" = 1
    builtin return 1
  end
  builtin printf 'ok\n%s\n' "$namespace"
end

function __cosmosh_fish_history_stream
  # Native search exposes ephemeral entries. Remove default leading-space records before
  # any helper transfer, and distinguish a complete empty search from a truncated read.
  builtin set -l query --null --max 200
  if builtin test (builtin count $argv) = 2
    builtin set query --null --exact --case-sensitive --max 1 -- "$argv[2]"
  end
  begin
    builtin printf 'ok\0%s\0' "$argv[1]"
    builtin history search $query | begin
      builtin set -l read_status 0
      while true
        builtin read --null --delimiter '' --local record
        builtin set read_status $status
        builtin test "$read_status" = 0; or break
        if not builtin string match -rq '^ ' -- "$record"
          builtin printf '%s\0' "$record"; or break
        end
      end
      # Normal EOF is 1. User fish_read_limit failures must not masquerade as an empty history.
      builtin test "$read_status" = 1
    end
    builtin set -l query_status $pipestatus
    if builtin test "$query_status[1]" = 0; and builtin test "$query_status[2]" = 0
      builtin printf '0\0'
    else
      builtin printf '1\0'
    end
  end 2>/dev/null
end

function __cosmosh_fish_history_read
  builtin set -l scope (__cosmosh_fish_history_scope)
  if builtin test "$scope[1]" = private
    builtin printf 'private\0\0' | command "$__COSMOSH_EDITOR_BINARY" editor-widget history "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$argv[1]" >/dev/null 2>&1
  else if builtin test (builtin count $scope) = 2; and builtin test "$scope[1]" = ok
    __cosmosh_fish_history_stream "$scope[2]" | command "$__COSMOSH_EDITOR_BINARY" editor-widget history "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$argv[1]" >/dev/null 2>&1
  else
    __cosmosh_fish_editor_reject "$argv[1]"
  end
  builtin return 0
end

function __cosmosh_fish_history_delete
  builtin set -l request_id "$argv[1]"
  builtin set -l namespace (builtin printf '%s' "$argv[2]" | command base64 -d | builtin string collect --no-trim-newlines --allow-empty)
  builtin set -l record (builtin printf '%s' "$argv[3]" | command base64 -d | builtin string collect --no-trim-newlines --allow-empty)
  builtin set -l scope (__cosmosh_fish_history_scope)
  if builtin test (builtin count $scope) != 2; or builtin test "$scope[1]" != ok; or \
      builtin test (builtin count $namespace) != 1; or builtin test "$scope[2]" != "$namespace"; or \
      builtin test (builtin count $record) != 1; or builtin test -z "$record"
    __cosmosh_fish_editor_reject "$request_id"
    builtin return 0
  end
  # An exact native search, not a capped recent list, proves the requested text is present.
  builtin set -l response (__cosmosh_fish_history_stream "$namespace" "$record" |
    command "$__COSMOSH_EDITOR_BINARY" editor-widget history "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$request_id" 2>/dev/null)
  builtin test (builtin count $response) = 1; and builtin test "$response[1]" = apply; or builtin return 0
  builtin set scope (__cosmosh_fish_history_scope)
  if not __cosmosh_fish_editor_supported; or builtin test (builtin count $scope) != 2; or \
      builtin test "$scope[1]" != ok; or builtin test "$scope[2]" != "$namespace"
    __cosmosh_fish_editor_reject "$request_id"
    builtin return 0
  end
  # Fish records exact-text tombstones for this namespace. Saving removes old file-backed
  # records from subsequent native searches; the builtin does not promise durable storage.
  # Claim while input is ordered, then release before native history can touch its backing file.
  builtin set -l granted 0
  begin
    if command "$__COSMOSH_EDITOR_BINARY" editor-input-lock "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$argv[4]" "$argv[5]" "$request_id"
      builtin set granted 1
    end
  end 9<"$argv[6]" 2>/dev/null
  if builtin test "$granted" != 1
    __cosmosh_fish_editor_reject "$request_id"
    builtin return 0
  end
  builtin history delete --exact --case-sensitive -- "$record" 2>/dev/null; or builtin return 0
  builtin history save 2>/dev/null; or builtin return 0
  __cosmosh_fish_history_stream "$namespace" "$record" |
    command "$__COSMOSH_EDITOR_BINARY" editor-widget history-confirm "$__COSMOSH_SHELL_INSTANCE_ID" fish "$fish_pid" "$__COSMOSH_EDITOR_START" "$__COSMOSH_PROMPT_GENERATION" emacs "$request_id" >/dev/null 2>&1
  builtin return 0
end

function __cosmosh_fish_history_observe_policy
  # Names include autoload candidates without executing them. The original Shell lifetime owns
  # this privacy decision; a later prompt or erased function cannot prove older entries safe.
  if builtin contains -- fish_should_add_to_history $argv
    builtin set -gu __COSMOSH_FISH_HISTORY_POLICY_UNTRUSTED 1
  end
  builtin return 0
end
`
