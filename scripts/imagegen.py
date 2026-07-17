#!/usr/bin/env python3
"""Small synchronous client for the HappyCode image API."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import secrets
import socket
import sys
import time
from typing import Any
import urllib.error
import urllib.request


VERSION = "3.6.0"
SKILL_DIR = Path(__file__).resolve().parents[1]
CONFIG_PATH = SKILL_DIR / "config.json"
DEFAULT_BASE_URL = "https://us.happycode.vip/v1"
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_OUTPUT_DIR = "output"
DEFAULT_TIMEOUT = 600
DEFAULT_QUALITY = "auto"
DEFAULT_SIZE = "auto"
DEFAULT_BACKGROUND = "auto"
API_KEY_PLACEHOLDER = "replace-with-your-api-key"


class ImagegenError(RuntimeError):
    pass


def configuration_guidance(error: ImagegenError) -> tuple[Path, str] | None:
    message = str(error)
    if not (
        message.startswith("Missing configuration:")
        or message.startswith("api_key is required in ")
    ):
        return None
    command = (
        f'notepad "{CONFIG_PATH}"'
        if os.name == "nt"
        else f'nano "{CONFIG_PATH}"'
    )
    return CONFIG_PATH, command


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ImagegenError(f"Missing configuration: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ImagegenError(f"Invalid configuration: {path}: {exc}") from exc

    if not isinstance(data, dict):
        raise ImagegenError(f"Configuration must be a JSON object: {path}")

    api_key = data.get("api_key")
    if (
        not isinstance(api_key, str)
        or not api_key.strip()
        or api_key.strip() == API_KEY_PLACEHOLDER
    ):
        raise ImagegenError(f"api_key is required in {path}")

    proxy = data.get("proxy")
    if proxy is not None and not isinstance(proxy, str):
        raise ImagegenError(f"proxy must be a string in {path}")

    base_url = data.get("base_url")
    if base_url is not None and not isinstance(base_url, str):
        raise ImagegenError(f"base_url must be a string in {path}")
    base_url = (base_url or DEFAULT_BASE_URL).strip()

    model = data.get("model")
    if model is not None and not isinstance(model, str):
        raise ImagegenError(f"model must be a string in {path}")
    model = (model or DEFAULT_MODEL).strip()

    return {
        "api_key": api_key.strip(),
        "base_url": base_url.rstrip("/"),
        "model": model,
        "proxy": proxy.strip() if proxy and proxy.strip() else None,
        "timeout": DEFAULT_TIMEOUT,
    }


def build_opener(proxy: str | None) -> urllib.request.OpenerDirector:
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))


def request_json(
    config: dict[str, Any],
    endpoint: str,
    body: bytes,
    content_type: str,
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{config['base_url']}/{endpoint.lstrip('/')}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {config['api_key']}",
            "Content-Type": content_type,
            "Accept": "application/json",
            "User-Agent": f"happycode-imagegen/{VERSION}",
        },
    )
    try:
        with build_opener(config["proxy"]).open(
            request, timeout=config["timeout"]
        ) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        message = (
            exc.read(8192)
            .decode("utf-8", errors="replace")
            .replace(config["api_key"], "***")
            .strip()
            or str(exc.reason)
        )
        raise ImagegenError(f"API HTTP {exc.code}: {message}") from exc
    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        raise ImagegenError(
            f"API request failed; completion state is unknown: {exc}"
        ) from exc

    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ImagegenError("API returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise ImagegenError("API returned invalid JSON")

    error = result.get("error")
    if isinstance(error, dict):
        error = error.get("message")
    if isinstance(error, str) and error.strip():
        message = error.replace(config["api_key"], "***").strip()
        raise ImagegenError(f"API error: {message}")
    return result


def image_parameters(args: argparse.Namespace, model: str) -> dict[str, Any]:
    if not args.prompt.strip():
        raise ImagegenError("Prompt cannot be empty")
    return {
        "model": model,
        "prompt": args.prompt,
        "quality": DEFAULT_QUALITY,
        "size": DEFAULT_SIZE,
        "background": DEFAULT_BACKGROUND,
    }


def multipart_request_body(
    parameters: dict[str, Any], images: list[Path], mask: Path | None
) -> tuple[bytes, str]:
    boundary = f"----happycode-{secrets.token_hex(16)}"
    chunks: list[bytes] = []

    for name, value in parameters.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("ascii"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(
                    "ascii"
                ),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )

    files = [("image[]", path) for path in images]
    if mask:
        files.append(("mask", mask))
    for name, path in files:
        if not path.is_file():
            raise ImagegenError(f"Input image not found: {path}")
        filename = path.name.replace('"', "_")
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("ascii"),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{filename}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {content_type}\r\n\r\n".encode("ascii"),
                path.read_bytes(),
                b"\r\n",
            ]
        )

    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def download_image(url: str, config: dict[str, Any]) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": f"happycode-imagegen/{VERSION}"}
    )
    try:
        with build_opener(config["proxy"]).open(
            request, timeout=config["timeout"]
        ) as response:
            return response.read()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        raise ImagegenError(f"Could not download generated image: {exc}") from exc


def decode_image(item: dict[str, Any], config: dict[str, Any]) -> bytes:
    encoded = item.get("b64_json")
    if isinstance(encoded, str) and encoded:
        if encoded.startswith("data:"):
            encoded = encoded.split(",", 1)[-1]
        try:
            return base64.b64decode(encoded, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise ImagegenError("API returned invalid base64 image data") from exc
    url = item.get("url")
    if isinstance(url, str) and url:
        return download_image(url, config)
    raise ImagegenError("API response contains no image data")


def prepare_output(value: str | None) -> tuple[Path, bool]:
    if value is None:
        path = (Path.cwd() / DEFAULT_OUTPUT_DIR).resolve()
        is_file = False
    else:
        path = Path(value).expanduser().resolve()
        is_file = bool(path.suffix) and not path.is_dir()

    directory = path.parent if is_file else path
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ImagegenError(f"Cannot create output directory {directory}: {exc}") from exc
    return path, is_file


def unused_path(path: Path) -> Path:
    if not path.exists():
        return path
    for number in range(2, 10_000):
        candidate = path.with_name(f"{path.stem}-{number}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise ImagegenError(f"Cannot find an unused name near {path}")


def save_images(
    response: dict[str, Any],
    config: dict[str, Any],
    output: tuple[Path, bool],
) -> list[Path]:
    items = response.get("data")
    if not isinstance(items, list) or not items:
        raise ImagegenError("API response contains no images")

    output_path, is_file = output
    stem = f"image-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"
    saved: list[Path] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ImagegenError("API returned an invalid image item")
        data = decode_image(item, config)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ImagegenError("API returned a non-PNG image")
        if is_file:
            base = output_path.with_suffix(".png")
            target = (
                base
                if len(items) == 1
                else base.with_name(f"{base.stem}-{index}{base.suffix}")
            )
        else:
            name = stem if len(items) == 1 else f"{stem}-{index}"
            target = output_path / f"{name}.png"
        target = unused_path(target)
        try:
            target.write_bytes(data)
        except OSError as exc:
            raise ImagegenError(f"Could not save image {target}: {exc}") from exc
        saved.append(target)
    return saved


def run(args: argparse.Namespace) -> list[Path]:
    config = load_config()
    output = prepare_output(args.out)
    parameters = image_parameters(args, config["model"])

    if not args.image:
        if args.mask:
            raise ImagegenError("--mask requires at least one --image")
        response = request_json(
            config,
            "images/generations",
            json.dumps(parameters, ensure_ascii=False).encode("utf-8"),
            "application/json",
        )
    else:
        images = [Path(value).expanduser().resolve() for value in args.image]
        mask = Path(args.mask).expanduser().resolve() if args.mask else None
        body, content_type = multipart_request_body(parameters, images, mask)
        response = request_json(
            config, "images/edits", body, content_type
        )
    return save_images(response, config, output)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="happycode-imagegen",
        description="Generate or edit PNG images through the HappyCode API.",
    )
    parser.add_argument(
        "--version", action="version", version=f"happycode-imagegen {VERSION}"
    )
    parser.add_argument("-p", "--prompt", required=True, help="Image request")
    parser.add_argument(
        "-i",
        "--image",
        action="append",
        help="Input image for editing; repeat for multiple images",
    )
    parser.add_argument("--mask", help="Optional edit mask; requires --image")
    parser.add_argument(
        "--out",
        help="Output directory, or a file path when it has an extension",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        for path in run(args):
            print(f"SAVED: {path}")
        return 0
    except ImagegenError as exc:
        guidance = configuration_guidance(exc)
        if guidance:
            path, command = guidance
            print(f"ERROR: CONFIG_REQUIRED: {path}", file=sys.stderr)
            print(f"CONFIG_EDIT_COMMAND: {command}", file=sys.stderr)
            return 78
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ERROR: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
