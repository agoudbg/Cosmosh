#!/bin/sh
set -eu

test -f /source/cosmosh_bash.c
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"

for arch in amd64 arm64; do
  case "$arch" in
    amd64) compiler=gcc; machine='Advanced Micro Devices X86-64' ;;
    arm64) compiler=aarch64-linux-gnu-gcc; machine='AArch64' ;;
  esac
  target="/out/cosmosh-bash-linux-$arch.so"
  temporary="$(mktemp "/out/.cosmosh-bash-$arch-XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  trap 'exit 1' HUP INT TERM
  "$compiler" -std=c11 -O2 -fPIC -shared \
    -Wall -Wextra -Werror -Wl,-z,defs -Wl,-z,now -Wl,-z,relro \
    -Wl,-z,nodelete -Wl,-z,noexecstack \
    -o "$temporary" /source/cosmosh_bash.c -ldl
  readelf -h "$temporary" | grep -F "Machine:" | grep -Fq "$machine"
  nm -D --defined-only "$temporary" | grep -Eq ' [BD] cosmosh_editor_struct$'
  version_info="$(readelf --version-info "$temporary")"
  versions="$(printf '%s\n' "$version_info" | grep -Eo 'GLIBC_[0-9]+\.[0-9]+' | sort -Vu)"
  test -n "$versions"
  for version in $versions; do
    newest="$(printf '%s\n%s\n' "$version" GLIBC_2.31 | sort -Vu | tail -n 1)"
    if test "$newest" != GLIBC_2.31; then
      echo "Bash native module requires glibc newer than 2.31: $version" >&2
      exit 1
    fi
  done
  chmod 644 "$temporary"
  mv -f "$temporary" "$target"
  trap - EXIT HUP INT TERM
done
