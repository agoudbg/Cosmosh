"""Exercise the packaged module in real ZLE readers; run only inside the fixture."""

import base64
import errno
import fcntl
import json
import os
import pty
import select
import shlex
import signal
import stat
import struct
import subprocess
import tempfile
import termios
import time
import uuid
from pathlib import Path


def read_ready(fd, timeout):
    """Read actual PTY output, treating premature reader exit as a test failure."""
    if not select.select([fd], [], [], timeout)[0]:
        return b""
    data = os.read(fd, 65536)
    if not data:
        raise RuntimeError("The fixture Zsh reader closed unexpectedly")
    return data


def wait_for(fd, marker, timeout=5):
    """Wait for a fixed fixture marker with bounded capture and a real deadline."""
    output = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        output.extend(read_ready(fd, 0.05))
        if marker in output:
            return
        if len(output) > 2 * 1024 * 1024:
            raise RuntimeError("The fixture reader exceeded its output limit")
    raise RuntimeError(f"Missing fixture marker {marker!r}: {bytes(output[-2048:])!r}")


def drain(fd):
    """Consume finite repaint output without waiting indefinitely for a quiet PTY."""
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if not read_ready(fd, 0.08):
            return
    raise RuntimeError("The fixture reader did not finish repainting")


def write_all(fd, data):
    """Preserve all fixture input even if the real PTY accepts a partial write."""
    while data:
        count = os.write(fd, data)
        if count <= 0:
            raise RuntimeError("The fixture PTY did not accept input")
        data = data[count:]


class NativeZshProbe:
    """Own one disposable reader, its authorization record and fixed test data."""

    def __init__(self, root, lock_directory, executable, scenario):
        self.root = root
        self.scenario = scenario
        self.descriptors = root / f"{scenario}.descriptors"
        self.notification_output = root / f"{scenario}.notification-output"
        self.read_descriptor = None
        self.pipe_inode = None
        self.config = root / f"{scenario}.zsh"
        self.result = root / f"{scenario}.result"
        self.prompt_log = root / f"{scenario}.prompt"
        self.epoch = str(uuid.uuid4())
        self.state = lock_directory / f"{self.epoch}.state"
        self.child = None
        self.terminal = None
        self.executable = executable

    def start(self):
        """Start a configuration-free real Zsh and register a fixture-owned FD callback."""
        self.state.touch(mode=0o600, exist_ok=False)
        child, terminal = pty.fork()
        if child == 0:
            os.environ.update(
                TERM="xterm-256color", LC_ALL="C.UTF-8", ZDOTDIR=str(self.root)
            )
            if self.scenario != "normal":
                os.environ.update(
                    LD_PRELOAD=str(self.root / "signal.so"),
                    COSMOSH_NATIVE_ZSH_SIGNAL=self.scenario,
                    COSMOSH_NATIVE_ZSH_PID=str(os.getpid()),
                )
            try:
                os.execl(self.executable, "zsh", "-d", "-f", "-i")
            except OSError:
                # A failed child exec must not run the parent's resource cleanup.
                os._exit(126)
        self.child, self.terminal = child, terminal
        setup = (
            "PS1='NATIVE>'; bindkey -e; zmodload zsh/zle; zmodload zsh/system; "
            f"__fixture_load() {{ local -a module_path=({shlex.quote(str(self.root))}); builtin zmodload cosmosh_zsh; }}; "
            "__fixture_load || exit 91; builtin cosmosh_editor_apply status || exit 92; "
            "if builtin zmodload -u zsh/zle 2>/dev/null; then exit 93; fi; "
            "builtin zmodload -u cosmosh_zsh || exit 94; "
            "(( ! $+builtins[cosmosh_editor_apply] )) || exit 95; "
            "__fixture_load || exit 96; builtin cosmosh_editor_apply status || exit 97; "
            "typeset -g __COSMOSH_EDITOR_NOTIFY_FD= __COSMOSH_EDITOR_NOTIFY_KEEP_FD=; "
            "__fixture_bad_notify() { local -r __COSMOSH_EDITOR_NOTIFY_FD=; "
            "if builtin cosmosh_editor_apply notification; then return 1; fi; }; "
            "__fixture_bad_notify || exit 98; "
            "if (builtin cosmosh_editor_apply notification); then exit 99; fi; "
            f"builtin cosmosh_editor_apply notification >{self.notification_output} || exit 100; "
            "if builtin cosmosh_editor_apply notification; then exit 101; fi; "
            f"builtin printf '%s %s' $__COSMOSH_EDITOR_NOTIFY_FD $__COSMOSH_EDITOR_NOTIFY_KEEP_FD >{self.descriptors}; "
            "builtin zmodload -u cosmosh_zsh || exit 102; __fixture_load || exit 103; "
            "typeset -g __COSMOSH_EDITOR_AVAILABLE=true __COSMOSH_PROMPT_GENERATION=1; "
            "typeset -g __COSMOSH_SHELL_OWNER_PID=$$; "
            f"__fixture_prompt() {{ command python3 {self.root / 'lock_probe.py'} {self.state} {self.prompt_log}; }}; "
            + (
                "TRAPWINCH() { __fixture_prompt; }; "
                if self.scenario == "winch-custom"
                else ""
            )
            + "setopt prompt_subst; PS1='$(__fixture_prompt)NATIVE>'; "
            f"__fixture_widget() {{ builtin emulate -L zsh -o noxtrace; source {self.config}; "
            "local result=0; if [[ $__fixture_action = apply ]]; then builtin cosmosh_editor_apply; result=$?; fi; "
            f'builtin printf \'%s\\0%s\\0%s\\0%s\\0\' "$__cosmosh_request_id" "$result" "$BUFFER" "$CURSOR" >{self.result}; }}; '
            "zle -N __fixture_widget; "
            "__fixture_notify() { local byte; builtin sysread -i $1 -s 1 byte; zle __fixture_widget; }; "
            "zle -F $__COSMOSH_EDITOR_NOTIFY_FD __fixture_notify; "
            "builtin printf '\\n__NATIVE_READY__\\n'\r"
        )
        write_all(terminal, setup.encode())
        wait_for(terminal, b"__NATIVE_READY__\r\n")
        drain(terminal)
        assert self.notification_output.read_bytes() == b""
        read_descriptor, keep_descriptor = map(
            int, self.descriptors.read_text().split()
        )
        assert (
            read_descriptor >= 10
            and keep_descriptor >= 10
            and read_descriptor != keep_descriptor
        )
        read_stat = os.stat(f"/proc/{child}/fd/{read_descriptor}")
        keep_stat = os.stat(f"/proc/{child}/fd/{keep_descriptor}")
        assert stat.S_ISFIFO(read_stat.st_mode) and stat.S_ISFIFO(keep_stat.st_mode)
        assert read_stat.st_ino == keep_stat.st_ino
        assert read_stat.st_uid == keep_stat.st_uid == os.getuid()
        for descriptor, access in (
            (read_descriptor, os.O_RDONLY),
            (keep_descriptor, os.O_WRONLY),
        ):
            info = Path(f"/proc/{child}/fdinfo/{descriptor}").read_text().splitlines()
            flags = int(
                next(line.split()[1] for line in info if line.startswith("flags:")), 8
            )
            assert flags & os.O_NONBLOCK and flags & os.O_CLOEXEC
            assert flags & os.O_ACCMODE == access
        self.read_descriptor, self.pipe_inode = read_descriptor, read_stat.st_ino

    def request(
        self,
        expected,
        point,
        replacement,
        next_point,
        *,
        action="apply",
        authorize=True,
        expired=False,
        sequence=0,
        shadow=False,
        request=None,
        extra="",
    ):
        """Call the real module with private parameters and an actual kernel-locked record."""
        request = request or str(uuid.uuid4())
        values = {
            "__fixture_action": action,
            "__cosmosh_line": expected,
            "__cosmosh_point": str(point),
            "__cosmosh_replacement": replacement,
            "__cosmosh_replacement_point": str(next_point),
            "__cosmosh_prompt_generation": "1",
            "__cosmosh_input_epoch": self.epoch,
            "__cosmosh_input_sequence": str(sequence),
            "__cosmosh_request_id": request,
        }
        self.config.write_text(
            "\n".join(
                f"local {name}={shlex.quote(value)}" for name, value in values.items()
            )
            + (
                "\nunset __cosmosh_replacement; local -a __cosmosh_replacement=(never)"
                if shadow
                else ""
            )
            + "\n"
            + extra,
            encoding="utf-8",
        )
        if authorize:
            record = bytearray(128)
            record[:8] = b"CSORDER1"
            record[8:44] = self.epoch.encode()
            for offset, value in (
                (48, self.child),
                (56, 0),
                (64, 0),
                (72, 0),
                (120, time.monotonic_ns() + (-1 if expired else 1_500_000_000)),
            ):
                struct.pack_into(">Q", record, offset, value)
            record[80:116] = request.encode()
            record[116] = 1
            self.state.write_bytes(record)
        self.result.unlink(missing_ok=True)
        # O_NONBLOCK also bounds failure when a reader has exited before notification.
        notification = os.open(
            f"/proc/{self.child}/fd/{self.read_descriptor}", os.O_WRONLY | os.O_NONBLOCK
        )
        try:
            assert os.fstat(notification).st_ino == self.pipe_inode
            assert os.write(notification, b"1") == 1
        finally:
            os.close(notification)
        deadline = time.monotonic() + 5
        output = bytearray()
        while time.monotonic() < deadline:
            if (
                self.scenario == "int"
                and action == "apply"
                and self.state.read_bytes()[116] == 2
            ):
                check = os.open(self.state, os.O_RDONLY)
                try:
                    try:
                        fcntl.flock(check, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        mask = next(
                            line
                            for line in Path(f"/proc/{self.child}/status")
                            .read_text()
                            .splitlines()
                            if line.startswith("SigBlk:")
                        )
                        if int(mask.split()[1], 16) == 0:
                            # This proves only that the critical section finished.
                            # A new observation below must prove actual interruption.
                            return None
                    except BlockingIOError:
                        pass
                finally:
                    os.close(check)
            if self.result.exists():
                data = self.result.read_bytes()
                if data.count(b"\0") == 4:
                    response_id, result, text, cursor, _ = data.split(b"\0")
                    if response_id.decode() == request:
                        drain(self.terminal)
                        return int(result), text.decode(), int(cursor)
            output.extend(read_ready(self.terminal, 0.01))
            del output[:-2048]
        raise RuntimeError(
            f"No native result: {self.scenario}/{action}: {bytes(output)!r}"
        )

    def verify_normal(self):
        """Verify real undo and refusals while retaining a usable original editor."""
        write_all(self.terminal, b"\x1f")
        drain(self.terminal)
        assert self.request("", 0, "", 0, action="observe") == (0, "echo 中文🐟", 7)
        for options in ({}, {"expired": True}, {"sequence": 1}, {"shadow": True}):
            expected = "echo 中文🐟" if options else "echo wrong"
            assert self.request(expected, 7, "never", 0, **options)[0] == 1
        assert (
            self.request("echo 中文🐟", 7, "never", 0, extra="unsetopt multibyte\n")[0]
            == 1
        )
        chosen = str(uuid.uuid4())
        assert self.request("echo 中文🐟", 7, "echo final", 10, request=chosen) == (
            0,
            "echo final",
            10,
        )
        assert (
            self.request(
                "echo final", 10, "echo twice", 10, request=chosen, authorize=False
            )[0]
            == 1
        )
        assert (
            self.request(
                "echo final",
                10,
                "never",
                0,
                extra="builtin bindkey -v; builtin zle -K main\n",
            )[0]
            == 1
        )
        assert self.request(
            "echo final",
            10,
            "echo final",
            10,
            extra="builtin bindkey -e; builtin zle -K main\n",
        ) == (0, "echo final", 10)
        write_all(self.terminal, b"\x12")
        drain(self.terminal)
        assert self.request("", 0, "never", 0)[0] == 1
        write_all(self.terminal, b"\x07")
        drain(self.terminal)
        write_all(self.terminal, b"\x03")
        wait_for(self.terminal, b"NATIVE>")
        write_all(self.terminal, b"echo '\r")
        drain(self.terminal)
        assert self.request("", 0, "never", 0)[0] == 1
        write_all(self.terminal, b"\x03")
        wait_for(self.terminal, b"NATIVE>")
        write_all(
            self.terminal, b"__fixture_value=fixed-private; vared __fixture_value\r"
        )
        drain(self.terminal)
        assert self.request("fixed-private", 13, "never", 0)[0] == 1

    def verify(self):
        """Exercise the native critical section and prove signal callbacks run after unlock."""
        self.start()
        write_all(self.terminal, "echo 中文🐟".encode())
        drain(self.terminal)
        write_all(self.terminal, b"\x02")
        drain(self.terminal)
        self.prompt_log.write_text("", encoding="utf-8")
        result = self.request("echo 中文🐟", 7, "echo changed🐟", 8)
        if self.scenario == "int":
            # Unlocking alone cannot prove SIGINT ran. Read the actual next ZLE
            # reader without changing its buffer or sending a cancel key. Without
            # the injected signal this still contains "echo changed🐟" and fails.
            assert result is None, result
            # Wake the interrupted reader with native clear-screen, which leaves
            # BUFFER unchanged. A cancel or kill-line key would invalidate this proof.
            write_all(self.terminal, b"\x0c")
            drain(self.terminal)
            interrupted_reader = self.request("", 0, "", 0, action="observe")
            assert interrupted_reader == (0, "", 0), interrupted_reader
        else:
            assert result == (0, "echo changed🐟", 8), result
        check = os.open(self.state, os.O_RDONLY)
        try:
            fcntl.flock(check, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(check)
        if self.scenario == "normal":
            self.verify_normal()
        observations = [
            json.loads(line) for line in self.prompt_log.read_text().splitlines()
        ]
        if self.scenario.startswith("winch"):
            assert observations, "The injected resize did not trigger a prompt callback"
            dimensions = fcntl.ioctl(self.terminal, termios.TIOCGWINSZ, bytes(8))
            assert struct.unpack("HHHH", dimensions)[:2] == (37, 107)
        assert all(not item["held"] for item in observations), observations
        drain(self.terminal)
        write_all(self.terminal, b"\x03")
        wait_for(self.terminal, b"NATIVE>")
        write_all(self.terminal, b"builtin printf '\\n__NATIVE_INPUT_OK__\\n'\r")
        wait_for(self.terminal, b"__NATIVE_INPUT_OK__\r\n")
        write_all(
            self.terminal,
            (
                b"builtin zle -F $__COSMOSH_EDITOR_NOTIFY_FD; "
                b"exec {__COSMOSH_EDITOR_NOTIFY_FD}<&-; exec {__COSMOSH_EDITOR_NOTIFY_KEEP_FD}>&-; "
                b"builtin printf '\\n__NATIVE_PIPE_CLOSED__\\n'\r"
            ),
        )
        wait_for(self.terminal, b"__NATIVE_PIPE_CLOSED__\r\n")
        for entry in Path(f"/proc/{self.child}/fd").iterdir():
            try:
                assert entry.stat().st_ino != self.pipe_inode
            except FileNotFoundError:
                # A prompt command's transient pipe can close during the inventory.
                pass
        return {
            "name": self.scenario,
            "passed": True,
            "promptChecks": len(observations),
            "notificationClosed": True,
        }

    def close(self):
        """Terminate and reap only this fixture reader, then remove its private state file."""
        if self.child is not None:
            try:
                os.killpg(self.child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.close(self.terminal)
            finally:
                os.waitpid(self.child, 0)
            self.child = None
        self.state.unlink(missing_ok=True)


def deadline_expired(_signal, _frame):
    """Unwind through reader cleanup if a blocking OS operation exceeds the whole-run budget."""
    raise TimeoutError("Native Zsh fixture exceeded its 45-second deadline")


def main(payload):
    """Run all scenarios inside the disposable container with no host Python requirement."""
    version = subprocess.check_output(
        [payload["executable"], "--version"], text=True, timeout=5
    ).strip()
    lock_directory = Path(f"/tmp/cosmosh-input-{os.getuid()}")
    try:
        lock_directory.mkdir(mode=0o700)
        created_directory = True
    except FileExistsError:
        created_directory = False
    previous_alarm = signal.signal(signal.SIGALRM, deadline_expired)
    signal.alarm(45)
    reports = []
    try:
        with tempfile.TemporaryDirectory(prefix="cosmosh-native-zsh-") as directory:
            root = Path(directory)
            (root / "cosmosh_zsh.so").write_bytes(
                base64.b64decode(payload["module"], validate=True)
            )
            (root / "signal.so").write_bytes(
                base64.b64decode(payload["shim"], validate=True)
            )
            # This separate process checks the real kernel lock from prompt substitution
            # and a user's WINCH handler. It never substitutes for ZLE or the module.
            (root / "lock_probe.py").write_text(
                "import fcntl,json,os,sys\n"
                "fd=os.open(sys.argv[1],os.O_RDONLY)\n"
                "try:\n"
                " try:\n"
                "  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\n"
                "  held=False\n"
                " except BlockingIOError: held=True\n"
                " with open(sys.argv[2],'a') as out: out.write(json.dumps({'held':held})+'\\n')\n"
                "finally: os.close(fd)\n",
                encoding="utf-8",
            )
            for scenario in ("normal", "winch", "winch-custom", "int"):
                probe = NativeZshProbe(
                    root, lock_directory, payload["executable"], scenario
                )
                try:
                    report = probe.verify()
                finally:
                    probe.close()
                assert not probe.state.exists()
                report["cleaned"] = True
                reports.append(report)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_alarm)
        # Other live tests can own records in this shared private directory.
        if created_directory:
            try:
                lock_directory.rmdir()
            except OSError as error:
                if error.errno != errno.ENOTEMPTY:
                    raise
    print(json.dumps({"version": version, "scenarios": reports}), flush=True)
