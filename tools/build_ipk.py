#!/usr/bin/env python3
"""Build an OpenWrt .ipk for luci-app-usbpower-temperature.

The package contains only shell scripts, JSON and JavaScript, so it is built
as architecture "all" without requiring the OpenWrt SDK. The resulting file
is a gzip compressed tar archive containing debian-binary, data.tar.gz and
control.tar.gz, the package layout accepted by the opkg versions deployed on
OpenWrt 23.x and later.

Usage: python3 tools/build_ipk.py
"""

from __future__ import annotations

import gzip
import io
import os
import subprocess
import sys
import tarfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "root"
PACKAGING = REPO / "packaging"
DIST = REPO / "dist"

PKG_NAME = "luci-app-usbpower-temperature"
PKG_VERSION = "1.3.2"
PKG_RELEASE = "1"
PKG_ARCH = "all"
PKG_MAINTAINER = "luci-app-usbpower-temperature contributors"
PKG_LICENSE = "MIT"
PKG_DESCRIPTION = (
    "Description: USB port thermal control for LuCI\n"
    " Controls a switched USB port based on SoC temperature using gpio,\n"
    " uhubctl, regulator or custom command backends."
)
CONFFILES = ["/etc/config/usbpower_temperature"]
SOURCE_DATE_EPOCH = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))

EXECUTABLE_PATHS = ("etc/init.d/", "usr/sbin/")


def collect_data_files() -> list[tuple[str, int]]:
    if not ROOT.is_dir():
        raise SystemExit(f"missing directory: {ROOT}")

    files: list[tuple[str, int]] = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT).as_posix()
        mode = 0o755 if rel.startswith(EXECUTABLE_PATHS) else 0o644
        files.append((rel, mode))

    if not files:
        raise SystemExit(f"no files found under {ROOT}")
    return files


def installed_size(files: list[tuple[str, int]]) -> int:
    total = sum((ROOT / rel).stat().st_size for rel, _ in files)
    return max(1, (total + 1023) // 1024)


def control_text(files: list[tuple[str, int]]) -> str:
    return (
        f"Package: {PKG_NAME}\n"
        f"Version: {PKG_VERSION}-{PKG_RELEASE}\n"
        "Depends: luci-base\n"
        f"Architecture: {PKG_ARCH}\n"
        f"Installed-Size: {installed_size(files)}\n"
        f"Maintainer: {PKG_MAINTAINER}\n"
        "Section: luci\n"
        "Priority: optional\n"
        f"License: {PKG_LICENSE}\n"
        f"Source: package/{PKG_NAME}\n"
        f"SourceName: {PKG_NAME}\n"
        f"{PKG_DESCRIPTION}\n"
    )


def add_file(tar: tarfile.TarFile, name: str, data: bytes, mode: int) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = SOURCE_DATE_EPOCH
    tar.addfile(info, io.BytesIO(data))


def add_dir(tar: tarfile.TarFile, name: str) -> None:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = SOURCE_DATE_EPOCH
    tar.addfile(info)


def make_tar_gz(entries: list[tuple[str, bytes, int]]) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, data, mode in entries:
            if data is None:
                add_dir(tar, name)
            else:
                add_file(tar, name, data, mode)

    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def control_tar_gz(files: list[tuple[str, int]]) -> bytes:
    entries: list[tuple[str, bytes, int]] = [
        ("./control", control_text(files).encode(), 0o644),
        ("./conffiles", ("\n".join(CONFFILES) + "\n").encode(), 0o644),
    ]

    for script in ("postinst", "prerm", "postrm"):
        path = PACKAGING / script
        if not path.is_file():
            raise SystemExit(f"missing packaging script: {path}")
        entries.append((f"./{script}", path.read_bytes(), 0o755))

    return make_tar_gz(entries)


def data_tar_gz(files: list[tuple[str, int]]) -> bytes:
    entries: list[tuple[str, bytes | None, int]] = []
    dirs: set[str] = set()

    for rel, _ in files:
        parent = Path(rel).parent
        while str(parent) != ".":
            dirs.add("./" + parent.as_posix())
            parent = parent.parent

    for name in sorted(dirs):
        entries.append((name, None, 0o755))

    for rel, mode in files:
        entries.append(("./" + rel, (ROOT / rel).read_bytes(), mode))

    return make_tar_gz(entries)


def build() -> Path:
    if not (REPO / "Makefile").is_file() or not (REPO / "LICENSE").is_file():
        raise SystemExit("run this script from a complete repository checkout")

    check = subprocess.run(
        [sys.executable, str(REPO / "tools/build_lmo.py"), "--check"],
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        raise SystemExit(
            (check.stderr or check.stdout).strip()
            or "translation catalog is stale; run python3 tools/build_lmo.py"
        )

    files = collect_data_files()
    control = control_tar_gz(files)
    data = data_tar_gz(files)

    DIST.mkdir(exist_ok=True)
    output = DIST / f"{PKG_NAME}_{PKG_VERSION}-{PKG_RELEASE}_{PKG_ARCH}.ipk"
    outer = make_tar_gz([
        ("./debian-binary", b"2.0\n", 0o644),
        ("./data.tar.gz", data, 0o644),
        ("./control.tar.gz", control, 0o644)
    ])
    output.write_bytes(outer)

    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        names = tar.getnames()
    missing = [rel for rel, _ in files if "./" + rel not in names]
    if missing:
        raise SystemExit(f"data archive is incomplete: {missing}")

    return output


def main() -> None:
    start = time.time()
    output = build()
    size = output.stat().st_size
    print(f"built {output}")
    print(f"size: {size} bytes, elapsed: {time.time() - start:.2f}s")


if __name__ == "__main__":
    main()
