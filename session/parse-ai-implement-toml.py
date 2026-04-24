#!/usr/bin/env python3
from __future__ import annotations

import shlex
import sys
from pathlib import Path
from typing import NoReturn

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    try:
        import tomli as tomllib  # type: ignore
    except ModuleNotFoundError:
        print(
            "ERROR: detect-project: tomllib (Python 3.11+) or the tomli package is required",
            file=sys.stderr,
        )
        raise SystemExit(1)


FIELDS = {
    "SETUP_CMD": ("setup_cmd", str, ""),
    "DEV_CMD": ("dev_cmd", str, ""),
    "DEV_PORT": ("dev_port", int, ""),
    "READY_CHECK": ("ready_check", str, ""),
    "VERIFY_CMD": ("verify_cmd", str, ""),
    "TEARDOWN_CMD": ("teardown_cmd", str, ""),
    "CLAUDE_MODEL": ("claude_model", str, ""),
    "CLAUDE_MAX_TURNS": ("claude_max_turns", int, ""),
}


def fail(message: str) -> NoReturn:
    print(f"ERROR: detect-project: {message}", file=sys.stderr)
    raise SystemExit(1)


def article_for(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


def expect_root_scalar(data: dict, key: str, expected_type: type, default: str) -> str:
    value = data.get(key)
    if value is None:
        return default
    if type(value) is not expected_type:        
        type_name = expected_type.__name__
        raise TypeError(f"key '{key}' must be {article_for(type_name)} {type_name}")
    return str(value)


def expect_string_list(data: dict, section: str, key: str) -> str:
    section_value = data.get(section)
    if section_value is None:
        return ""
    if not isinstance(section_value, dict):
        raise TypeError(f"section '{section}' must be a table")

    value = section_value.get(key)
    if value is None:
        return ""
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise TypeError(
            f"key '{section}.{key}' must be an array of non-empty strings"
        )
    return " ".join(value)


def main() -> int:
    if len(sys.argv) != 2:
        fail("expected exactly one TOML file path")

    toml_path = Path(sys.argv[1])
    try:
        with toml_path.open("rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as exc:
        fail(f"invalid TOML in {toml_path}: {exc}")
    except OSError as exc:
        fail(f"failed to read {toml_path}: {exc}")

    if not isinstance(data, dict):
        fail("parsed TOML root must be a table")

    exports: dict[str, str] = {}
    try:
        for env_key, (toml_key, expected_type, default) in FIELDS.items():
            exports[env_key] = expect_root_scalar(data, toml_key, expected_type, default)
        exports["REQUIRED_SECRETS"] = expect_string_list(data, "secrets", "required")
        exports["OPTIONAL_SECRETS"] = expect_string_list(data, "secrets", "optional")
    except TypeError as exc:
        fail(str(exc))

    for key, value in exports.items():
        print(f"{key}={shlex.quote(value)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
