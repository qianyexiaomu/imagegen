#!/usr/bin/env node
"use strict";

import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const VERSION = "3.6.0";
const MIN_NODE_MAJOR = 18;
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(SKILL_DIR, "config.json");
const DEFAULT_BASE_URL = "https://us.happycode.vip/v1";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_OUTPUT_DIR = "output";
const DEFAULT_TIMEOUT = 600;
const DEFAULT_QUALITY = "auto";
const DEFAULT_SIZE = "auto";
const DEFAULT_BACKGROUND = "auto";
const API_KEY_PLACEHOLDER = "replace-with-your-api-key";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class ImagegenError extends Error {}
class RuntimeUnavailable extends Error {}

function configurationGuidance(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !message.startsWith("Missing configuration:")
    && !message.startsWith("api_key is required in ")
  ) {
    return null;
  }
  const command = process.platform === "win32"
    ? `notepad "${CONFIG_PATH}"`
    : `nano "${CONFIG_PATH}"`;
  return { command, path: CONFIG_PATH };
}

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function ensureRuntime() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new RuntimeUnavailable(
      `Node.js ${MIN_NODE_MAJOR} or newer is required; found ${process.versions.node}`,
    );
  }
}

function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

async function loadConfig(configPath = CONFIG_PATH) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ImagegenError(`Missing configuration: ${configPath}`);
    }
    throw new ImagegenError(`Invalid configuration: ${configPath}: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ImagegenError(`Invalid configuration: ${configPath}: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ImagegenError(`Configuration must be a JSON object: ${configPath}`);
  }

  const apiKey = data.api_key;
  if (
    typeof apiKey !== "string"
    || !apiKey.trim()
    || apiKey.trim() === API_KEY_PLACEHOLDER
  ) {
    throw new ImagegenError(`api_key is required in ${configPath}`);
  }
  if (data.proxy != null && typeof data.proxy !== "string") {
    throw new ImagegenError(`proxy must be a string in ${configPath}`);
  }
  if (data.base_url != null && typeof data.base_url !== "string") {
    throw new ImagegenError(`base_url must be a string in ${configPath}`);
  }
  if (data.model != null && typeof data.model !== "string") {
    throw new ImagegenError(`model must be a string in ${configPath}`);
  }

  const baseUrl = (data.base_url || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const model = (data.model || DEFAULT_MODEL).trim();
  const proxy = typeof data.proxy === "string" && data.proxy.trim()
    ? data.proxy.trim()
    : null;
  return { apiKey: apiKey.trim(), baseUrl, model, proxy, timeout: DEFAULT_TIMEOUT };
}

function sanitize(value, secret) {
  return secret ? value.split(secret).join("***") : value;
}

function parseHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImagegenError(`${label} must be an HTTP or HTTPS URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImagegenError(`${label} must be an HTTP or HTTPS URL`);
  }
  return parsed;
}

function proxyHeaders(proxy) {
  if (!proxy.username && !proxy.password) return {};
  let username;
  let password;
  try {
    username = decodeURIComponent(proxy.username);
    password = decodeURIComponent(proxy.password);
  } catch {
    throw new ImagegenError("proxy contains invalid credentials");
  }
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return { "Proxy-Authorization": `Basic ${token}` };
}

function authority(hostname, port) {
  const host = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return `${host}:${port}`;
}

class HttpsProxyAgent extends https.Agent {
  constructor(proxy, timeout) {
    super({ keepAlive: false });
    this.proxy = proxy;
    this.timeout = timeout;
  }

  createConnection(options, callback) {
    const targetHost = options.hostname || options.host;
    const targetPort = Number(options.port || 443);
    const target = authority(targetHost, targetPort);
    const transport = this.proxy.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    const request = transport.request({
      hostname: this.proxy.hostname,
      port: this.proxy.port || (this.proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: target,
      headers: { Host: target, ...proxyHeaders(this.proxy) },
    });
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`proxy CONNECT returned HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secureSocket = tls.connect({
        socket,
        servername: net.isIP(targetHost) ? undefined : targetHost,
        ALPNProtocols: ["http/1.1"],
      });
      secureSocket.once("secureConnect", () => finish(null, secureSocket));
      secureSocket.once("error", (error) => finish(error));
    });
    request.once("response", (response) => {
      response.resume();
      finish(new Error(`proxy CONNECT returned HTTP ${response.statusCode}`));
    });
    request.once("error", (error) => finish(error));
    request.setTimeout(this.timeout * 1000, () => {
      request.destroy(new Error("proxy connection timed out"));
    });
    request.end();
  }
}

function requestBuffer(url, { method, headers, body, proxy, timeout }) {
  const target = parseHttpUrl(url, "request URL");
  const proxyUrl = proxy ? parseHttpUrl(proxy, "proxy") : null;
  const requestHeaders = { ...headers };
  let transport;
  let options;

  if (target.protocol === "http:" && proxyUrl) {
    transport = proxyUrl.protocol === "https:" ? https : http;
    options = {
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80),
      method,
      path: target.href,
      headers: { ...requestHeaders, Host: target.host, ...proxyHeaders(proxyUrl) },
    };
  } else {
    transport = target.protocol === "https:" ? https : http;
    options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method,
      path: `${target.pathname}${target.search}`,
      headers: requestHeaders,
    };
    if (target.protocol === "https:" && proxyUrl) {
      options.agent = new HttpsProxyAgent(proxyUrl, timeout);
    }
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    request.setTimeout(timeout * 1000, () => {
      request.destroy(new Error("request timed out"));
    });
    request.end(body);
  });
}

function responseMessage(body, apiKey) {
  let text = body.subarray(0, 8192).toString("utf8").trim();
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (typeof error === "string") text = error;
    if (error && typeof error.message === "string") text = error.message;
  } catch {}
  return sanitize(text, apiKey);
}

async function requestJson(config, endpoint, body, contentType) {
  const url = `${config.baseUrl}/${endpoint.replace(/^\/+/, "")}`;
  let response;
  try {
    response = await requestBuffer(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": `happycode-imagegen/${VERSION}`,
      },
      body,
      proxy: config.proxy,
      timeout: config.timeout,
    });
  } catch (error) {
    throw new ImagegenError(
      `API request failed; completion state is unknown: ${sanitize(error.message, config.apiKey)}`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const message = responseMessage(response.body, config.apiKey) || "request failed";
    throw new ImagegenError(`API HTTP ${response.status}: ${message}`);
  }

  let result;
  try {
    result = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new ImagegenError("API returned invalid JSON");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ImagegenError("API returned invalid JSON");
  }
  let error = result.error;
  if (error && typeof error === "object") error = error.message;
  if (typeof error === "string" && error.trim()) {
    throw new ImagegenError(`API error: ${sanitize(error.trim(), config.apiKey)}`);
  }
  return result;
}

function imageParameters(args, model) {
  if (!args.prompt.trim()) throw new ImagegenError("Prompt cannot be empty");
  return {
    model,
    prompt: args.prompt,
    quality: DEFAULT_QUALITY,
    size: DEFAULT_SIZE,
    background: DEFAULT_BACKGROUND,
  };
}

function mimeType(filename) {
  const types = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return types[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

async function multipartRequestBody(parameters, images, mask) {
  const boundary = `----happycode-${randomHex(16)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(parameters)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8",
    ));
  }

  const files = images.map((image) => ["image[]", image]);
  if (mask) files.push(["mask", mask]);
  for (const [name, filename] of files) {
    let data;
    try {
      data = await readFile(filename);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ImagegenError(`Input image not found: ${filename}`);
      }
      throw new ImagegenError(`Could not read input image ${filename}: ${error.message}`);
    }
    const safeName = path.basename(filename).replace(/"/g, "_");
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${safeName}"\r\nContent-Type: ${mimeType(safeName)}\r\n\r\n`,
      "utf8",
    ));
    chunks.push(data, Buffer.from("\r\n", "ascii"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function downloadImage(url, config) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response;
    try {
      response = await requestBuffer(current, {
        method: "GET",
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": `happycode-imagegen/${VERSION}`,
        },
        body: null,
        proxy: config.proxy,
        timeout: config.timeout,
      });
    } catch (error) {
      throw new ImagegenError(`Could not download generated image: ${error.message}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new ImagegenError(`Could not download generated image: HTTP ${response.status}`);
      }
      current = new URL(location, current).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ImagegenError(`Could not download generated image: HTTP ${response.status}`);
    }
    return response.body;
  }
  throw new ImagegenError("Could not download generated image: too many redirects");
}

async function decodeImage(item, config) {
  let encoded = item.b64_json;
  if (typeof encoded === "string" && encoded) {
    if (encoded.startsWith("data:")) {
      const comma = encoded.indexOf(",");
      if (comma < 0) throw new ImagegenError("API returned invalid base64 image data");
      encoded = encoded.slice(comma + 1);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new ImagegenError("API returned invalid base64 image data");
    }
    const data = Buffer.from(encoded, "base64");
    if (data.toString("base64") !== encoded) {
      throw new ImagegenError("API returned invalid base64 image data");
    }
    return data;
  }
  if (typeof item.url === "string" && item.url) {
    return downloadImage(item.url, config);
  }
  throw new ImagegenError("API response contains no image data");
}

async function isDirectory(filename) {
  try {
    return (await stat(filename)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function prepareOutput(value) {
  let outputPath;
  let isFile;
  if (value == null) {
    outputPath = path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR);
    isFile = false;
  } else {
    outputPath = path.resolve(expandPath(value));
    isFile = Boolean(path.extname(outputPath)) && !(await isDirectory(outputPath));
  }
  const directory = isFile ? path.dirname(outputPath) : outputPath;
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new ImagegenError(`Cannot create output directory ${directory}: ${error.message}`);
  }
  return { outputPath, isFile };
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function unusedPath(filename) {
  if (!(await exists(filename))) return filename;
  const parsed = path.parse(filename);
  for (let number = 2; number < 10_000; number += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${number}${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new ImagegenError(`Cannot find an unused name near ${filename}`);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function saveImages(response, config, output) {
  const items = response.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ImagegenError("API response contains no images");
  }
  const stem = `image-${timestamp()}-${randomHex(3)}`;
  const saved = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ImagegenError("API returned an invalid image item");
    }
    const data = await decodeImage(item, config);
    if (data.length < PNG_SIGNATURE.length || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new ImagegenError("API returned a non-PNG image");
    }

    let target;
    if (output.isFile) {
      const parsed = path.parse(output.outputPath);
      const suffix = items.length === 1 ? "" : `-${index + 1}`;
      target = path.join(parsed.dir, `${parsed.name}${suffix}.png`);
    } else {
      const suffix = items.length === 1 ? "" : `-${index + 1}`;
      target = path.join(output.outputPath, `${stem}${suffix}.png`);
    }
    target = await unusedPath(target);
    try {
      await writeFile(target, data, { flag: "wx" });
    } catch (error) {
      throw new ImagegenError(`Could not save image ${target}: ${error.message}`);
    }
    saved.push(target);
  }
  return saved;
}

async function run(args) {
  const config = await loadConfig();
  const output = await prepareOutput(args.out);
  const parameters = imageParameters(args, config.model);
  let response;
  if (args.images.length === 0) {
    if (args.mask) throw new ImagegenError("--mask requires at least one --image");
    response = await requestJson(
      config,
      "images/generations",
      Buffer.from(JSON.stringify(parameters), "utf8"),
      "application/json",
    );
  } else {
    const images = args.images.map((value) => path.resolve(expandPath(value)));
    const mask = args.mask ? path.resolve(expandPath(args.mask)) : null;
    const multipart = await multipartRequestBody(parameters, images, mask);
    response = await requestJson(
      config,
      "images/edits",
      multipart.body,
      multipart.contentType,
    );
  }
  return saveImages(response, config, output);
}

function printHelp() {
  console.log(`usage: happycode-imagegen --prompt PROMPT [--image IMAGE] [--mask MASK] [--out OUT]

Generate or edit PNG images through the HappyCode API.

options:
  -h, --help             show this help message and exit
  --version              show program's version number and exit
  -p, --prompt PROMPT    image request
  -i, --image IMAGE      input image for editing; repeat for multiple images
  --mask MASK            optional edit mask; requires --image
  --out OUT              output directory, or a file path when it has an extension`);
}

function parseArgs(argv) {
  const args = { prompt: null, images: [], mask: null, out: null };
  const takeValue = (index, option) => {
    if (index + 1 >= argv.length) throw new ImagegenError(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "-h" || option === "--help") {
      printHelp();
      return null;
    }
    if (option === "--version") {
      console.log(`happycode-imagegen ${VERSION}`);
      return null;
    }
    if (option === "-p" || option === "--prompt") {
      args.prompt = takeValue(index, option);
      index += 1;
    } else if (option === "-i" || option === "--image") {
      args.images.push(takeValue(index, option));
      index += 1;
    } else if (option === "--mask") {
      args.mask = takeValue(index, option);
      index += 1;
    } else if (option === "--out") {
      args.out = takeValue(index, option);
      index += 1;
    } else {
      throw new ImagegenError(`unrecognized argument: ${option}`);
    }
  }
  if (args.prompt == null) throw new ImagegenError("--prompt is required");
  return args;
}

async function main() {
  try {
    ensureRuntime();
    const args = parseArgs(process.argv.slice(2));
    if (args == null) return 0;
    for (const filename of await run(args)) {
      console.log(`SAVED: ${filename}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof RuntimeUnavailable) {
      console.error(`RUNTIME_UNAVAILABLE: ${error.message}`);
      return 69;
    }
    const guidance = configurationGuidance(error);
    if (guidance) {
      console.error(`ERROR: CONFIG_REQUIRED: ${guidance.path}`);
      console.error(`CONFIG_EDIT_COMMAND: ${guidance.command}`);
      return 78;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
