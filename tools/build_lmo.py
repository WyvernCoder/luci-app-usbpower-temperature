#!/usr/bin/env python3
"""Compile the Simplified Chinese .po catalog into a LuCI .lmo file.

LuCI loads all *.zh-cn.lmo files from /usr/lib/lua/luci/i18n when the
configured language is Chinese. The .lmo format is described in the LuCI
documentation: a payload of 4-byte aligned strings followed by a sorted index
of (key hash, value hash, offset, length) entries and the index offset.

Usage:
    python3 tools/build_lmo.py            # regenerate the committed .lmo
    python3 tools/build_lmo.py --check    # verify the committed file
"""

from __future__ import annotations

import argparse
import re
import struct
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PO_PATH = REPO / "po/zh_Hans/luci-app-usbpower-temperature.po"
LMO_PATH = REPO / "root/usr/lib/lua/luci/i18n/luci-app-usbpower-temperature.zh-cn.lmo"
DEFAULT_PLURAL = "nplurals=1; plural=0;"


def sfh(text: str) -> int:
    """LuCI's SuperFastHash over the UTF-8 representation of text."""
    data = text.encode("utf-8")
    if not data:
        return 0

    value = len(data) & 0xFFFFFFFF
    remainder = len(data) & 3
    blocks = len(data) >> 2
    offset = 0

    for _ in range(blocks):
        value = (value + (data[offset] | (data[offset + 1] << 8))) & 0xFFFFFFFF
        tmp = (((data[offset + 2] | (data[offset + 3] << 8)) << 11) ^ value) & 0xFFFFFFFF
        value = ((value << 16) ^ tmp) & 0xFFFFFFFF
        value = (value + (value >> 11)) & 0xFFFFFFFF
        offset += 4

    if remainder == 3:
        value = (value + (data[offset] | (data[offset + 1] << 8))) & 0xFFFFFFFF
        value ^= (value << 16) & 0xFFFFFFFF
        value ^= data[offset + 2] << 18
        value &= 0xFFFFFFFF
        value = (value + (value >> 11)) & 0xFFFFFFFF
    elif remainder == 2:
        value = (value + (data[offset] | (data[offset + 1] << 8))) & 0xFFFFFFFF
        value ^= (value << 11) & 0xFFFFFFFF
        value = (value + (value >> 17)) & 0xFFFFFFFF
    elif remainder == 1:
        value = (value + data[offset]) & 0xFFFFFFFF
        value ^= (value << 10) & 0xFFFFFFFF
        value = (value + (value >> 1)) & 0xFFFFFFFF

    value ^= (value << 3) & 0xFFFFFFFF
    value &= 0xFFFFFFFF
    value = (value + (value >> 5)) & 0xFFFFFFFF
    value ^= (value << 4) & 0xFFFFFFFF
    value &= 0xFFFFFFFF
    value = (value + (value >> 17)) & 0xFFFFFFFF
    value ^= (value << 25) & 0xFFFFFFFF
    value &= 0xFFFFFFFF
    value = (value + (value >> 6)) & 0xFFFFFFFF
    return value


def unquote(token: str) -> str:
    token = token.strip()
    if len(token) < 2 or token[0] != '"' or token[-1] != '"':
        raise ValueError(f"invalid PO string: {token!r}")

    body = token[1:-1]
    result: list[str] = []
    escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}
    i = 0
    while i < len(body):
        char = body[i]
        if char == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            result.append(escapes.get(nxt, nxt))
            i += 2
        else:
            result.append(char)
            i += 1
    return "".join(result)


def parse_po(path: Path) -> tuple[str, list[tuple[str, str]]]:
    """Return (plural expression, [(msgid, msgstr), ...])."""
    plural = DEFAULT_PLURAL
    entries: list[tuple[str, str]] = []
    msgid: str | None = None
    msgstr: str | None = None
    target: list[str] | None = None

    def flush() -> None:
        nonlocal plural, msgid, msgstr
        if msgid is None:
            return
        value = msgstr or ""
        if msgid == "":
            match = re.search(r"Plural-Forms:\s*([^\\\n]+)", value)
            if match:
                plural = match.group(1).strip()
        elif value:
            entries.append((msgid, value))
        msgid = None
        msgstr = None

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            flush()
            continue
        if line.startswith("#"):
            continue
        if line.startswith("msgid "):
            flush()
            msgid = unquote(line[6:])
            target = None
        elif line.startswith("msgstr "):
            msgstr = unquote(line[7:])
            target = None
        elif line.startswith('"'):
            if msgid is None:
                raise ValueError("continuation line before msgid")
            if msgstr is None:
                msgid += unquote(line)
                target = None
            else:
                msgstr += unquote(line)
        else:
            raise ValueError(f"unsupported PO line: {line!r}")

    flush()
    if not entries:
        raise ValueError(f"no translations found in {path}")
    return plural, entries


def build_lmo(plural: str, entries: list[tuple[str, str]]) -> bytes:
    payload = bytearray()

    def add(value: str) -> tuple[int, int]:
        offset = len(payload)
        raw = value.encode("utf-8")
        payload.extend(raw)
        while len(payload) % 4:
            payload.append(0)
        return offset, len(raw)

    header_offset, header_length = add(plural)
    index: list[tuple[int, int, int, int]] = [(0, 1, header_offset, header_length)]
    seen: dict[int, str] = {}

    for msgid, msgstr in entries:
        key = sfh(msgid)
        if key in seen:
            raise ValueError(f"hash collision: {msgid!r} and {seen[key]!r}")
        seen[key] = msgid
        offset, length = add(msgstr)
        index.append((key, 1, offset, length))

    index.sort(key=lambda entry: entry[0])
    index_offset = len(payload)
    out = bytearray(payload)
    for entry in index:
        out.extend(struct.pack(">IIII", *entry))
    out.extend(struct.pack(">I", index_offset))
    return bytes(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=LMO_PATH)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    plural, entries = parse_po(PO_PATH)
    generated = build_lmo(plural, entries)

    if args.check:
        if not args.output.is_file():
            raise SystemExit(f"missing catalog: {args.output}")
        if args.output.read_bytes() != generated:
            raise SystemExit(
                f"catalog is stale: {args.output}; run python3 tools/build_lmo.py"
            )
        print(f"catalog is up to date: {args.output}")
        return

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(generated)
    print(f"wrote {args.output} ({len(entries)} translations, {len(generated)} bytes)")


if __name__ == "__main__":
    main()
