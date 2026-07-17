---
name: happycode-imagegen
description: Generate or edit raster images through the HappyCode OpenAI-compatible GPT Image 2 API. Use as the default image backend in this project for ordinary raster image generation, reference-image transformation, composition, inpainting, editing, and first-use configuration. Authentication is supplied through local config.json. Preserve explicit requirements, track edit lineage, prefer the synchronous Node client with a Python fallback, and never switch providers.
---

# HappyCode Image Gen

Use this skill as this project's default provider-specific image adapter. Keep creative decisions with the user and keep API, authentication, timeout, download, and PNG validation behavior inside `<SKILL_DIR>/scripts/imagegen.mjs`, with `<SKILL_DIR>/scripts/imagegen.py` only as a runtime fallback.

After loading this file, do not inspect other skill files, read `config.json`, run tests, probe the API, or execute setup commands unless the client reports missing configuration. Do not call the built-in `image_gen` tool or another image provider. The clients already handle configuration, `quality=auto`, `size=auto`, `background=auto`, proxying, and output. Without `--out`, they create `<working-directory>/output` before making the API request.

## Configure

`config.json` is intentionally omitted from distributable copies. Treat an empty `api_key` or the literal `replace-with-your-api-key` as unconfigured. Respond only after the client reports either a missing configuration file or an unconfigured `api_key`.

1. When `config.json` is missing, copy `<SKILL_DIR>/config.example.json` to `<SKILL_DIR>/config.json` without changing its contents. Do not create or overwrite it when the client reports only a missing `api_key`.
2. Tell the user to set `api_key` locally in `<SKILL_DIR>/config.json`; normally leave `base_url` and `model` unchanged. Set `proxy` to a proxy URL or leave it as `""` to disable proxying.
3. Treat the `ERROR: CONFIG_REQUIRED:` and `CONFIG_EDIT_COMMAND:` lines as a configuration protocol. The client already chooses an OS-appropriate command and includes the absolute config path; do not alter either value.
4. In Codex desktop, render an absolute clickable link to the created or existing file, for example `[config.json](/absolute/path/to/config.json)`, so the user can open and edit it directly.
5. Treat Codex CLI as a terminal-only client. In every terminal-only configuration response, include the resolved absolute config path and render the exact `CONFIG_EDIT_COMMAND:` value in one fenced code block. Never provide only a bare path, a `<SKILL_DIR>` placeholder, or a rewritten command.
6. Wait for the user to confirm configuration is complete, then retry the original image request exactly once.

Never read, display, or modify the values in `config.json`, and never ask the user to paste an API key into the conversation.

## Decide

1. Treat a request with no input image as a new generation unless the user clearly asks to edit an existing image.
2. Treat a request that changes an existing image while preserving other content as an edit.
3. For every supplied image, identify its role from the request: edit target, reference, mask, or supporting input. Pass relevant non-mask images with repeated `--image` arguments and state their roles only when the prompt needs that distinction.
4. Ask for an image only when the requested edit has no available target. Ask another question only when a missing detail makes execution impossible; otherwise proceed.

## Track Edit Inputs

- Internally remember which input target produced each successful `SAVED` path. A text-only generation has no input image. Do not print, persist, or show this bookkeeping to the user.
- For a normal follow-up change, edit the latest successful `SAVED` result.
- Treat statements such as "wrong", "not this", "has a problem", "redo", and their equivalents in the user's language as rejection when they refer to the latest result or its prompt.
- When the user rejects a result, edit the remembered input target that produced it. Do not use the rejected result itself. If the rejected result was generated without an input image, generate again without `--image`.
- Apply the correction to that last valid source and preserve all other explicit requirements from the task.

## Shape The Prompt

- Pass the user's image request verbatim as `--prompt`. Do not translate, normalize, paraphrase, expand, qualify, censor, or add style, subject, count, pose, setting, negative constraints, or preservation language.
- For an edit, pass the user's requested change verbatim. Do not append a "keep everything else unchanged" instruction unless the user stated it.
- Resolve a pronoun only to select an already supplied input image; do not alter the prompt text to record that resolution.
- When inspecting a result, compare it only with the user's exact request.

## Batch Generation

- Interpret a quantity as an output count only when it explicitly modifies the requested images, such as "生成两张" or "给我 3 张". A quantity describing subjects inside one image, such as "一张图片中包含 2 个", is not a batch and must stay in one request.
- For a new-image request with an output count from 2 through 5, make that many independent single-image requests concurrently. Do not use an API `n` parameter and do not ask for multiple images in one prompt.
- Derive each single-image prompt by replacing only the output-count phrase with a one-image phrase. For example, run `生成1张美女照片` twice for `生成2张美女照片`. Preserve all other user text exactly; do not add "独立", "不同", style language, constraints, or any other wording.
- When the output-count request explicitly asks for different values of an attribute, replace only the applicable `不同` with `随机` in each single-image prompt when that is enough to express a standalone request. For example, `生成3张不同颜色的衣服` becomes three requests for `生成1张随机颜色的衣服`. If that minimal replacement is not possible, retain the original wording after changing only the output count.
- If the requested output count exceeds 5, do not start any client or API process. Tell the user that one batch supports at most 5 images and ask them to reduce the count.
- If the output count is unclear, ask for the count before starting. Do not infer a batch from words such as "多个" or "一些".

## Execute

For one requested asset or edit, start the Node client after the required `SKILL.md` read:

```bash
node "<SKILL_DIR>/scripts/imagegen.mjs" --prompt "<user's request verbatim>"
```

```bash
node "<SKILL_DIR>/scripts/imagegen.mjs" --image "<target path>" --prompt "<user's requested change verbatim>"
```

For a 2-5 image batch, call the batch client once with one derived single-image prompt per `--prompt`. It launches the independent image requests concurrently and enforces the five-image limit:

```bash
node "<SKILL_DIR>/scripts/imagegen-batch.mjs" --prompt "<first derived prompt>" --prompt "<second derived prompt>"
```

Use the Python client only when the shell cannot start `node` or the Node client exits with `RUNTIME_UNAVAILABLE:`. That marker means the installed Node runtime is unsupported and no API request started. Use an available Python 3 launcher (`python3`, `python`, or `py -3`) with the same arguments:

```bash
python "<SKILL_DIR>/scripts/imagegen.py" --prompt "<same resolved request>"
```

Do not fall back after `ERROR:`, an interruption, a timeout, an active process, or any other Node failure because an API request may already have started. A runtime-unavailable Node attempt is not a generation attempt; otherwise start exactly one API-attempting process per requested asset.

Repeat `--image` for relevant inputs. Add `--mask` only when supplied. Add `--out` only when the user requested another destination. On an image-capable surface, use the default output directory unless the user requested another one. On a non-image-capable surface, ask for a destination before running.

For a batch, use the batch client rather than separate `exec_command` calls. Wait on its one process using the continuation flow below; it waits for all concurrent child requests. Do not create unrequested variants.

The clients use a 600-second network timeout. Prefer one blocking execution call that waits for the client to exit. With `functions.exec`, begin the tool input with this exact first line:

```javascript
// @exec: {"yield_time_ms": 660000}
```

`exec_command` may return after at most 30 seconds with a `session_id` while the process is still running. This initial yield is only a transport handoff: preserve the identifier and never turn it into a user-facing result. Then wait on that same process for up to 300 seconds at a time. The wait returns immediately when the API call completes; otherwise resume the same session only after its 300-second wait ends. Use this exact control flow, substituting only the command arguments:

```javascript
const first = await tools.exec_command({
  cmd: 'node "<SKILL_DIR>/scripts/imagegen.mjs" --prompt "<user request verbatim>"',
  yield_time_ms: 30000,
});
let output = first.output || "";
let sessionId = first.session_id;
while (sessionId != null) {
  const next = await tools.write_stdin({
    session_id: sessionId,
    chars: "",
    yield_time_ms: 300000,
  });
  output += next.output || "";
  sessionId = next.session_id;
}
text(output);
```

Do not start another shell command, restart the script, inspect output files, or send a status update while the process is active. A `write_stdin` wait is a continuation of the original process, not another API request. A wait with no output or `still running` after 300 seconds means the process remains active; continue waiting. An empty, truncated, or prematurely returned result without an exit status or `SAVED:`/`ERROR:` is not a terminal result and must not be shown to the user.

## Complete And Validate

- Treat `SAVED: <absolute-path>` as an internal tool protocol. Use it to identify the exact result path and technical completion; never echo the marker to the user. A client prints it only after saving the result.
- Treat `RUNTIME_UNAVAILABLE:` as an internal instruction to use the Python fallback. Never show the marker to the user.
- Treat an API-attempting process as failed only after an explicit non-zero exit status or `ERROR:`. A zero exit status without `SAVED:` is a client-protocol failure. Do not report a timeout while the original process is active or when its completion status is unavailable.
- Treat `SAVED:` as technical completion, not proof that the image satisfies the prompt.
- Do not inspect an image merely to confirm technical completion. Inspect it when the user requests review, when the task explicitly requires visual validation, or when the next edit needs visual understanding unavailable from the instruction.
- If inspection finds an unmet explicit requirement, report that mismatch without automatically retrying. Apply one targeted correction only after the user requests a revision.
- On image-capable surfaces, a normal successful final response contains only the saved image or images rendered inline with concise alt text. Do not add a success sentence, `SAVED:` marker, filename, visible path, or internal state. Add text only when the user requested a path, explanation, or review result. On non-image-capable surfaces, report the requested saved path concisely.

Never expose `config.json`, automatically retry an unknown request, search output directories for a result, or call another image provider.
