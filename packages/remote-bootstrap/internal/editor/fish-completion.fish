# Fixed query program: user input arrives as data on fd 3, never as command text.
# Explicit proc-fd opens let Fish read an inherited pipe; nchars prevents reading past its NUL field.
builtin read --nchars 8193 --null --delimiter '' --local query < /proc/$fish_pid/fd/3; or builtin exit 1
builtin read --nchars 8193 --null --delimiter '' --local logical < /proc/$fish_pid/fd/3; or builtin exit 1
builtin read --nchars 8193 --null --delimiter '' --local physical < /proc/$fish_pid/fd/3; or builtin exit 1
builtin cd -- "$logical"; or builtin exit 1
builtin test (builtin pwd --physical) = "$physical"; or builtin exit 1
builtin printf 'cosmosh-fish-completion-v1\0' >&4
builtin complete --do-complete --escape -- "$query" | begin
    builtin set -l read_status 0
    while builtin true
        builtin read --local --line row
        builtin set read_status $status
        builtin test "$read_status" = 0; or builtin break
        builtin set -l parts (builtin string split --max 1 \t -- "$row")
        builtin set -l token "$parts[1]"
        builtin set -l detail ''
        if builtin test (builtin count $parts) = 2
            builtin set detail "$parts[2]"
        end
        # Collect retains all data newlines plus unescape's single output newline.
        builtin set -l decoded (builtin string unescape --style=script -- "$token" | builtin string collect --no-trim-newlines --allow-empty)
        builtin set -l encoded_token (builtin string escape --style=url -- "$token")
        builtin set -l encoded_value (builtin string escape --style=url -- "$decoded")
        builtin set -l encoded_detail (builtin string escape --style=url -- "$detail")
        builtin printf 'entry\0%s\0%s\0%s\0' "$encoded_token" "$encoded_value" "$encoded_detail" >&4; or builtin exit 1
    end
    builtin test "$read_status" = 1
end
builtin set -l completion_status $pipestatus
if builtin test "$completion_status[1]" = 0; and builtin test "$completion_status[2]" = 0
    builtin printf '%s\0%s\0' end 0 >&4
else
    builtin printf '%s\0%s\0' end 1 >&4
end
