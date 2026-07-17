#!/usr/bin/env node
"use strict";

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_IMAGES = 5;
const MIN_NODE_MAJOR = 18;
const CLIENT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "imagegen.mjs",
);

class RuntimeUnavailable extends Error {}

function ensureRuntime() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new RuntimeUnavailable(
      `Node.js ${MIN_NODE_MAJOR} or newer is required; found ${process.versions.node}`,
    );
  }
}

function usage() {
  console.error(
    "usage: imagegen-batch --prompt PROMPT --prompt PROMPT [--prompt PROMPT ...]",
  );
}

function parseArgs(argv) {
  const prompts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "-h" || option === "--help") {
      usage();
      return null;
    }
    if (option !== "-p" && option !== "--prompt") {
      throw new Error(`unrecognized argument: ${option}`);
    }
    if (index + 1 >= argv.length) {
      throw new Error(`${option} requires a value`);
    }
    prompts.push(argv[index + 1]);
    index += 1;
  }

  if (prompts.length < 2) {
    throw new Error("batch generation requires at least 2 prompts");
  }
  if (prompts.length > MAX_IMAGES) {
    throw new Error(
      `batch generation supports at most ${MAX_IMAGES} images; received ${prompts.length}`,
    );
  }
  if (prompts.some((prompt) => !prompt.trim())) {
    throw new Error("Prompt cannot be empty");
  }
  return prompts;
}

function createChildController() {
  const children = new Map();
  const interruptedIndexes = new Set();
  let receivedSignal = null;

  const forward = (signal) => {
    const childSignal = receivedSignal == null ? signal : "SIGKILL";
    if (receivedSignal == null) receivedSignal = signal;
    for (const [child, index] of children) {
      if (child.exitCode != null || child.signalCode != null) continue;
      interruptedIndexes.add(index);
      try {
        child.kill(childSignal);
      } catch {
        try {
          child.kill();
        } catch {}
      }
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");

  return {
    children,
    interruptedIndexes,
    get receivedSignal() { return receivedSignal; },
    install() {
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
    },
    remove() {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
  };
}

function runClient(prompt, index, controller) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT_PATH, "--prompt", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    controller.children.set(child, index);
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      controller.children.delete(child);
      resolve({ index, code, signal, stdout, stderr, spawnError });
    });
  });
}

function parseClientResult(raw, forcedSignal = null) {
  const saved = [];
  const messages = [];
  let configPath = null;
  let configEditCommand = null;
  const lines = `${raw.stdout}\n${raw.stderr}`.split(/\r?\n/).filter(Boolean);
  const addMessage = (message) => {
    if (!messages.includes(message)) messages.push(message);
  };
  for (const line of lines) {
    if (line.startsWith("SAVED:")) {
      saved.push(line.slice("SAVED:".length).trim());
    } else if (line.startsWith("ERROR: CONFIG_REQUIRED:")) {
      configPath = line.slice("ERROR: CONFIG_REQUIRED:".length).trim();
    } else if (line.startsWith("CONFIG_EDIT_COMMAND:")) {
      configEditCommand = line.slice("CONFIG_EDIT_COMMAND:".length).trim();
    } else {
      addMessage(line);
    }
  }
  if (raw.spawnError) {
    addMessage(`Could not start image client: ${raw.spawnError.message}`);
  }

  const signal = raw.signal || forcedSignal;
  let status;
  if (raw.code === 0 && saved.length > 0) status = "saved";
  else if (signal) status = "interrupted";
  else if (saved.length > 0) status = "partial";
  else if (raw.code === 78) status = "config_required";
  else if (raw.code === 69) status = "runtime_unavailable";
  else if (raw.code === 0) status = "protocol_error";
  else status = "error";

  return {
    index: raw.index,
    status,
    exit_code: raw.code,
    signal,
    saved,
    config_path: configPath,
    config_edit_command: configEditCommand,
    messages,
  };
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function resultExitCode(results, receivedSignal) {
  if (receivedSignal) return signalExitCode(receivedSignal);
  if (results.every((result) => result.status === "saved")) return 0;
  if (results.every((result) => result.status === "config_required")) return 78;
  if (results.every((result) => result.status === "runtime_unavailable")) return 69;
  return 1;
}

function emitResults(results, exitCode, receivedSignal) {
  for (const result of results) {
    console.log(`BATCH_RESULT: ${JSON.stringify(result)}`);
  }
  const succeededItems = results.filter((result) => result.status === "saved").length;
  const savedFiles = results.reduce((total, result) => total + result.saved.length, 0);
  let status = "error";
  if (receivedSignal) status = "interrupted";
  else if (succeededItems === results.length) status = "saved";
  else if (succeededItems > 0) status = "partial";
  else if (results.every((result) => result.status === "config_required")) {
    status = "config_required";
  } else if (results.every((result) => result.status === "runtime_unavailable")) {
    status = "runtime_unavailable";
  }
  console.log(`BATCH_SUMMARY: ${JSON.stringify({
    status,
    requested_items: results.length,
    succeeded_items: succeededItems,
    failed_items: results.length - succeededItems,
    saved_files: savedFiles,
    signal: receivedSignal,
    exit_code: exitCode,
  })}`);
}

async function main() {
  try {
    ensureRuntime();
    const prompts = parseArgs(process.argv.slice(2));
    if (prompts == null) return 0;

    const controller = createChildController();
    controller.install();
    try {
      const rawResults = await Promise.all(
        prompts.map((prompt, offset) => runClient(prompt, offset + 1, controller)),
      );
      const results = rawResults.map((raw) => parseClientResult(
        raw,
        controller.interruptedIndexes.has(raw.index) ? controller.receivedSignal : null,
      ));
      const exitCode = resultExitCode(results, controller.receivedSignal);
      emitResults(results, exitCode, controller.receivedSignal);
      return exitCode;
    } finally {
      controller.remove();
    }
  } catch (error) {
    if (error instanceof RuntimeUnavailable) {
      console.error(`RUNTIME_UNAVAILABLE: ${error.message}`);
      return 69;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    return 64;
  }
}

main().then((code) => {
  process.exitCode = code;
});
