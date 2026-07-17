#!/usr/bin/env python3
"""Run independent HappyCode image requests concurrently with Python."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import signal
import subprocess
import sys
from typing import Any


MAX_IMAGES = 5
CLIENT_PATH = Path(__file__).with_name("imagegen.py")


def usage() -> None:
    print(
        "usage: imagegen-batch --prompt PROMPT --prompt PROMPT "
        "[--prompt PROMPT ...]",
        file=sys.stderr,
    )


def parse_args(argv: list[str]) -> list[str] | None:
    prompts: list[str] = []
    index = 0
    while index < len(argv):
        option = argv[index]
        if option in ("-h", "--help"):
            usage()
            return None
        if option not in ("-p", "--prompt"):
            raise ValueError(f"unrecognized argument: {option}")
        if index + 1 >= len(argv):
            raise ValueError(f"{option} requires a value")
        prompts.append(argv[index + 1])
        index += 2

    if len(prompts) < 2:
        raise ValueError("batch generation requires at least 2 prompts")
    if len(prompts) > MAX_IMAGES:
        raise ValueError(
            f"batch generation supports at most {MAX_IMAGES} images; "
            f"received {len(prompts)}"
        )
    if any(not prompt.strip() for prompt in prompts):
        raise ValueError("Prompt cannot be empty")
    return prompts


def parse_client_result(
    index: int,
    returncode: int | None,
    stdout: str,
    stderr: str,
    forced_signal: str | None = None,
    spawn_error: str | None = None,
) -> dict[str, Any]:
    saved: list[str] = []
    messages: list[str] = []
    config_path: str | None = None
    config_edit_command: str | None = None
    for line in f"{stdout}\n{stderr}".splitlines():
        if line.startswith("SAVED:"):
            saved.append(line.removeprefix("SAVED:").strip())
        elif line.startswith("ERROR: CONFIG_REQUIRED:"):
            config_path = line.removeprefix("ERROR: CONFIG_REQUIRED:").strip()
        elif line.startswith("CONFIG_EDIT_COMMAND:"):
            config_edit_command = line.removeprefix("CONFIG_EDIT_COMMAND:").strip()
        elif line and line not in messages:
            messages.append(line)
    if spawn_error:
        message = f"Could not start image client: {spawn_error}"
        if message not in messages:
            messages.append(message)

    process_signal = forced_signal
    if returncode is not None and returncode < 0:
        try:
            process_signal = signal.Signals(-returncode).name
        except ValueError:
            process_signal = f"SIGNAL_{-returncode}"

    if returncode == 0 and saved:
        status = "saved"
    elif process_signal:
        status = "interrupted"
    elif saved:
        status = "partial"
    elif returncode == 78:
        status = "config_required"
    elif returncode == 69:
        status = "runtime_unavailable"
    elif returncode == 0:
        status = "protocol_error"
    else:
        status = "error"

    exit_code = None if returncode is not None and returncode < 0 else returncode
    return {
        "index": index,
        "status": status,
        "exit_code": exit_code,
        "signal": process_signal,
        "saved": saved,
        "config_path": config_path,
        "config_edit_command": config_edit_command,
        "messages": messages,
    }


def emit_results(
    results: list[dict[str, Any]], exit_code: int, received_signal: int | None
) -> None:
    for result in results:
        print(
            "BATCH_RESULT: " + json.dumps(result, ensure_ascii=False),
            flush=True,
        )
    succeeded_items = sum(result["status"] == "saved" for result in results)
    saved_files = sum(len(result["saved"]) for result in results)
    if received_signal is not None:
        status = "interrupted"
    elif succeeded_items == len(results):
        status = "saved"
    elif succeeded_items:
        status = "partial"
    elif all(result["status"] == "config_required" for result in results):
        status = "config_required"
    elif all(result["status"] == "runtime_unavailable" for result in results):
        status = "runtime_unavailable"
    else:
        status = "error"
    summary = {
        "status": status,
        "requested_items": len(results),
        "succeeded_items": succeeded_items,
        "failed_items": len(results) - succeeded_items,
        "saved_files": saved_files,
        "signal": signal.Signals(received_signal).name if received_signal else None,
        "exit_code": exit_code,
    }
    print("BATCH_SUMMARY: " + json.dumps(summary, ensure_ascii=False), flush=True)


def result_exit_code(
    results: list[dict[str, Any]], received_signal: int | None
) -> int:
    if received_signal is not None:
        return 128 + received_signal
    if all(result["status"] == "saved" for result in results):
        return 0
    if all(result["status"] == "config_required" for result in results):
        return 78
    if all(result["status"] == "runtime_unavailable" for result in results):
        return 69
    return 1


def run_clients(prompts: list[str]) -> int:
    processes: dict[int, subprocess.Popen[str]] = {}
    synthetic_results: dict[int, dict[str, Any]] = {}
    interrupted_indexes: set[int] = set()
    received_signal: int | None = None

    def forward_signal(signum: int, _frame: Any) -> None:
        nonlocal received_signal
        child_signal = (
            signum
            if received_signal is None
            else getattr(signal, "SIGKILL", signal.SIGTERM)
        )
        if received_signal is None:
            received_signal = signum
        for index, process in list(processes.items()):
            if process.poll() is not None:
                continue
            interrupted_indexes.add(index)
            try:
                process.send_signal(child_signal)
            except (OSError, ValueError):
                try:
                    process.terminate()
                except OSError:
                    pass

    previous_handlers = {
        signal.SIGINT: signal.signal(signal.SIGINT, forward_signal),
        signal.SIGTERM: signal.signal(signal.SIGTERM, forward_signal),
    }
    try:
        for index, prompt in enumerate(prompts, start=1):
            if received_signal is not None:
                synthetic_results[index] = parse_client_result(
                    index,
                    None,
                    "",
                    "",
                    signal.Signals(received_signal).name,
                    "not started after batch interruption",
                )
                continue
            try:
                processes[index] = subprocess.Popen(
                    [sys.executable, str(CLIENT_PATH), "--prompt", prompt],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
            except OSError as exc:
                synthetic_results[index] = parse_client_result(
                    index, 1, "", "", spawn_error=str(exc)
                )

        collected: dict[int, tuple[str, str]] = {}
        if processes:
            with ThreadPoolExecutor(max_workers=len(processes)) as executor:
                futures = {
                    index: executor.submit(process.communicate)
                    for index, process in processes.items()
                }
                for index, future in futures.items():
                    collected[index] = future.result()

        results: list[dict[str, Any]] = []
        for index in range(1, len(prompts) + 1):
            if index in synthetic_results:
                results.append(synthetic_results[index])
                continue
            process = processes[index]
            stdout, stderr = collected[index]
            forced_signal = None
            if index in interrupted_indexes and received_signal is not None:
                forced_signal = signal.Signals(received_signal).name
            results.append(
                parse_client_result(
                    index, process.returncode, stdout, stderr, forced_signal
                )
            )

        exit_code = result_exit_code(results, received_signal)
        emit_results(results, exit_code, received_signal)
        return exit_code
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def main(argv: list[str] | None = None) -> int:
    try:
        prompts = parse_args(sys.argv[1:] if argv is None else argv)
        if prompts is None:
            return 0
        return run_clients(prompts)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 64
    except KeyboardInterrupt:
        print("ERROR: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
