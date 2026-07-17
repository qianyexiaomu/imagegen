#!/usr/bin/env node
"use strict";

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_IMAGES = 5;
const CLIENT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "imagegen.mjs",
);

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

function runClient(prompt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT_PATH, "--prompt", prompt], {
      stdio: "inherit",
    });
    child.once("error", (error) => {
      console.error(`ERROR: Could not start image client: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`ERROR: Image client stopped by signal ${signal}`);
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  try {
    const prompts = parseArgs(process.argv.slice(2));
    if (prompts == null) return 0;
    const codes = await Promise.all(prompts.map(runClient));
    return codes.some((code) => code !== 0) ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    return 64;
  }
}

main().then((code) => {
  process.exitCode = code;
});
