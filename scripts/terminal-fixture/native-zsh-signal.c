/* Test-only syscall-boundary injector. The production module has no test branch. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <unistd.h>

/** Preserve the real kernel lock, then deliver one signal to the original fixture Shell. */
int flock(int fd, int operation) {
  static int (*original)(int, int);
  static int fired;
  if (!original) original = dlsym(RTLD_NEXT, "flock");
  if (!original) { errno = ENOSYS; return -1; }
  int result = original(fd, operation);
  const char *scenario = getenv("COSMOSH_NATIVE_ZSH_SIGNAL");
  const char *target = getenv("COSMOSH_NATIVE_ZSH_PID");
  if (!result && (operation & LOCK_EX) && !fired && scenario && *scenario && target && atol(target) == getpid()) {
    fired = 1;
    if (*scenario == 'w') {
      struct winsize size = { .ws_row = 37, .ws_col = 107 };
      int terminal = open("/dev/tty", O_RDWR | O_NOCTTY | O_NONBLOCK);
      if (terminal < 0 || ioctl(terminal, TIOCSWINSZ, &size)) _exit(122);
      close(terminal);
      if (kill(getpid(), SIGWINCH)) _exit(123);
    } else if (*scenario == 'i' && kill(getpid(), SIGINT)) {
      _exit(124);
    }
  }
  return result;
}
