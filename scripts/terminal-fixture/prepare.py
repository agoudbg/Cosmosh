"""Prepare disposable accounts and file names for real SSH terminal tests."""

import os
import pwd
from pathlib import Path


def prepare_account(shell: str) -> None:
    """Populate an isolated account without reading the host user's files."""
    account = pwd.getpwnam(f"cosmosh-{shell}")
    account_home = Path(account.pw_dir)
    if shell == "zsh":
        (account_home / ".zshrc").write_text(
            "# Isolated terminal test account.\n", encoding="utf-8"
        )
    ssh_dir = account_home / ".ssh"
    ssh_dir.mkdir(mode=0o700, exist_ok=True)
    authorized_keys = ssh_dir / "authorized_keys"
    authorized_keys.write_bytes(Path("/run/fixture-authorized-keys").read_bytes())
    authorized_keys.chmod(0o600)
    fixture_dir = account_home / "fixtures"
    fixture_dir.mkdir(exist_ok=True)
    for name in [
        "My File.txt",
        "中文文件.txt",
        "emoji-😀.txt",
        "quote'file.txt",
        "-leading.txt",
    ]:
        (fixture_dir / name).write_text("terminal fixture\n", encoding="utf-8")
    (fixture_dir / "directory with spaces").mkdir(exist_ok=True)
    directory_link = fixture_dir / "linked directory"
    if not directory_link.is_symlink():
        directory_link.symlink_to("directory with spaces", target_is_directory=True)
    elif directory_link.readlink() != Path("directory with spaces"):
        raise ValueError("Terminal fixture directory link has an unexpected target")
    large_dir = fixture_dir / "large"
    large_dir.mkdir(exist_ok=True)
    for index in range(1000):
        (large_dir / f"entry-{index:04}.txt").touch()
    (large_dir / "zz-target.txt").write_text("last entry\n", encoding="utf-8")
    for root, directories, files in os.walk(account_home):
        os.chown(root, account.pw_uid, account.pw_gid)
        for name in directories + files:
            os.chown(
                Path(root) / name, account.pw_uid, account.pw_gid, follow_symlinks=False
            )


for fixture_shell in ("bash", "zsh", "fish"):
    prepare_account(fixture_shell)
