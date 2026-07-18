"""JSON bridge for a separately installed Microsoft UFO checkout (MIT)."""

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import uuid


def main() -> None:
    request = json.loads(sys.stdin.readline())
    task = str(request.get("task", "")).strip()
    if not task:
        raise ValueError("task is required")
    if len(task) > 12_000:
        raise ValueError("task exceeds 12,000 characters")

    ufo_dir = Path(os.environ.get("SUPERAI_UFO_DIR", "")).expanduser().resolve()
    if not ufo_dir.is_dir() or not (ufo_dir / "ufo" / "ufo.py").is_file():
        raise RuntimeError("SUPERAI_UFO_DIR must point to a reviewed Microsoft UFO checkout")
    python = os.environ.get("SUPERAI_UFO_PYTHON", sys.executable)
    task_name = f"axiomux-{uuid.uuid4().hex[:12]}"
    timeout = min(3600, max(60, int(request.get("timeout_seconds", 900))))
    process = subprocess.Popen(
        [python, "-m", "ufo", "--task", task_name, "--request", task, "--log-level", "WARNING"],
        cwd=ufo_dir,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
        env=dict(os.environ),
    )
    captured: dict[str, str] = {}
    stdout_thread = threading.Thread(target=drain_tail, args=(process.stdout, 200_000, captured, "stdout"), daemon=True)
    stderr_thread = threading.Thread(target=drain_tail, args=(process.stderr, 50_000, captured, "stderr"), daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    try:
        exit_code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=30)
        raise TimeoutError(f"UFO task exceeded {timeout} seconds")
    finally:
        stdout_thread.join(timeout=30)
        stderr_thread.join(timeout=30)
    print(json.dumps({
        "success": exit_code == 0,
        "task_id": task_name,
        "exit_code": exit_code,
        "output": captured.get("stdout", ""),
        "errors": captured.get("stderr", ""),
    }, ensure_ascii=False))


def drain_tail(stream: object, limit: int, output: dict[str, str], key: str) -> None:
    tail = bytearray()
    if stream is None:
        output[key] = ""
        return
    while True:
        chunk = stream.read(8192)
        if not chunk:
            break
        tail.extend(chunk)
        if len(tail) > limit:
            del tail[: len(tail) - limit]
    output[key] = bytes(tail).decode("utf-8", errors="replace")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise
