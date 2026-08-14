import hashlib
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


def _warn(message: str) -> None:
    print(f"[plugin_manager] WARNING: {message}")


def _safe_entry_path(plugin_dir: Path, entry_script: str) -> Optional[str]:
    if not entry_script or not re.match(r"^[A-Za-z0-9_./-]+$", entry_script):
        return None
    candidate = (plugin_dir / entry_script).resolve()
    root = plugin_dir.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate.as_posix().replace(root.as_posix(), "").lstrip("/")


def scan_plugins(plugins_dir: str) -> List[Dict[str, Any]]:
    plugins: List[Dict[str, Any]] = []
    root = Path(plugins_dir)
    if not root.is_dir():
        _warn(f"plugins directory not found: {plugins_dir}")
        return plugins
    for manifest_path in root.rglob("manifest.json"):
        plugin_dir = manifest_path.parent
        try:
            with manifest_path.open("r", encoding="utf-8") as handle:
                manifest = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            _warn(f"skipping {manifest_path}: {error}")
            continue
        required = ("id", "name", "version", "author", "entry_script")
        if not all(key in manifest and manifest[key] for key in required):
            _warn(f"skipping {manifest_path}: missing required keys {required}")
            continue
        entry = _safe_entry_path(plugin_dir, str(manifest["entry_script"]))
        if entry is None:
            _warn(f"skipping {manifest_path}: unsafe or missing entry_script")
            continue
        digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        plugins.append({
            "id": str(manifest["id"]),
            "name": str(manifest["name"]),
            "version": str(manifest["version"]),
            "author": str(manifest["author"]),
            "entry_script": entry,
            "manifest_sha256": digest,
            "dir": plugin_dir.as_posix(),
        })
    return plugins


class APIInterceptLayer:
    def __init__(self) -> None:
        self._hooks: Dict[str, Dict[str, Callable]] = {
            "input": {},
            "frame": {},
        }

    def register_hook(self, id: str, callback: Callable, kind: str = "input") -> bool:
        if kind not in self._hooks or id in self._hooks[kind]:
            return False
        self._hooks[kind][id] = callback
        return True

    def unregister_hook(self, id: str, kind: str = "input") -> bool:
        if kind not in self._hooks or id not in self._hooks[kind]:
            return False
        del self._hooks[kind][id]
        return True

    @staticmethod
    def _readonly_view(data: bytes) -> bytes:
        if isinstance(data, bytearray):
            data = bytes(data)
        return bytes(memoryview(data).toreadonly())

    def on_input_received(self, raw_input_bytes: bytes) -> bytes:
        view = self._readonly_view(raw_input_bytes)
        for callback in tuple(self._hooks["input"].values()):
            callback(view)
        return view

    def before_frame_encoded(self, frame_buffer: bytes) -> bytes:
        view = self._readonly_view(frame_buffer)
        for callback in tuple(self._hooks["frame"].values()):
            callback(view)
        return view


def safe_extract_zip(zip_path: str, extract_root: str) -> List[str]:
    extracted: List[str] = []
    root = Path(extract_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            target = (root / member.filename).resolve()
            try:
                target.relative_to(root)
            except ValueError:
                _warn(f"rejecting zip-slip member: {member.filename}")
                raise
            extracted.append(target.as_posix())
        archive.extractall(root)
    return extracted


def _self_test() -> bool:
    tempdir = tempfile.mkdtemp(prefix="plugin_mgr_test_")
    plugins_dir = Path(tempdir) / "plugins"
    valid_dir = plugins_dir / "alpha"
    invalid_dir = plugins_dir / "beta"
    valid_dir.mkdir(parents=True)
    invalid_dir.mkdir(parents=True)
    (valid_dir / "entry.py").write_text("print('ok')\n")
    (valid_dir / "manifest.json").write_text(json.dumps({
        "id": "alpha",
        "name": "Alpha",
        "version": "1.0.0",
        "author": "tester",
        "entry_script": "entry.py",
    }))
    (invalid_dir / "manifest.json").write_text(json.dumps({"id": "beta"}))

    scanned = scan_plugins(str(plugins_dir))
    if len(scanned) != 1 or scanned[0]["id"] != "alpha":
        print("FAIL: scan_plugins validation")
        return False

    evil_zip = Path(tempdir) / "evil.zip"
    with zipfile.ZipFile(evil_zip, "w") as archive:
        archive.writestr("../evil.py", "print('pwned')\n")
    refused = False
    try:
        safe_extract_zip(str(evil_zip), str(Path(tempdir) / "extract"))
    except Exception:
        refused = True
    if not refused:
        print("FAIL: safe_extract_zip zip-slip guard")
        return False

    print("PASS: scan_plugins")
    print("PASS: safe_extract_zip")
    return True


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "scan" and len(sys.argv) == 3:
            res = scan_plugins(sys.argv[2])
            print(json.dumps(res))
        elif cmd == "extract" and len(sys.argv) == 4:
            safe_extract_zip(sys.argv[2], sys.argv[3])
            print(json.dumps({"success": True}))
        sys.exit(0)
    else:
        if _self_test():
            print("ALL SELF-TESTS PASSED")
        else:
            print("SELF-TESTS FAILED")
