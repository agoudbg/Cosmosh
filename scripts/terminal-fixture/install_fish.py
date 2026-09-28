"""Install a pinned Fish 4 runtime alongside the distribution's Fish 3 fixture."""

import hashlib
import io
import platform
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "4.0.1"
ARTIFACTS = {
    "x86_64": "7512045b051768fe34ff3ceba5f0cfb9370763c68a769eccacd3b0623e12235a",
    "aarch64": "615ad9beebd87c65129130b06bc5858c8bce486e3cb1c5b3b13641560fdca749",
}


def install() -> None:
    """Verify the official static artifact and install only inside the fixture image."""
    architecture = platform.machine()
    expected = ARTIFACTS.get(architecture)
    if expected is None:
        raise RuntimeError(f"Unsupported Fish fixture architecture: {architecture}")
    url = (
        "https://github.com/fish-shell/fish-shell/releases/download/"
        f"{VERSION}/fish-static-{architecture}-{VERSION}.tar.xz"
    )
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = response.read(32 * 1024 * 1024 + 1)
    if len(archive) > 32 * 1024 * 1024:
        raise RuntimeError("Fish fixture artifact exceeds its download limit")
    if hashlib.sha256(archive).hexdigest() != expected:
        raise RuntimeError("Fish fixture artifact SHA-256 does not match the pin")

    destination = Path(f"/opt/cosmosh-fixture/fish-{VERSION}/runtime")
    with tempfile.TemporaryDirectory(prefix="cosmosh-fish-fixture-") as staging:
        binary = Path(staging) / "fish"
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:xz") as bundle:
            member = bundle.getmember("fish")
            if not member.isfile() or not 0 < member.size <= 64 * 1024 * 1024:
                raise RuntimeError("Invalid executable in the Fish fixture archive")
            stream = bundle.extractfile(member)
            if stream is None:
                raise RuntimeError("Fish fixture executable is missing")
            with stream:
                binary.write_bytes(stream.read())
        binary.chmod(0o755)
        subprocess.run(
            [str(binary), f"--install={destination}"],
            input=b"yes\n",
            check=True,
            timeout=60,
        )
    version = subprocess.check_output(
        [str(destination / "bin/fish"), "--version"], timeout=10, text=True
    )
    if version.strip() != f"fish, version {VERSION}":
        raise RuntimeError("Installed Fish fixture reports an unexpected version")


if __name__ == "__main__":
    install()
