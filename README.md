# HappyCode Image Gen

[English](#happycode-image-gen) | [简体中文](#中文说明)

Generate and edit raster images through the HappyCode OpenAI-compatible GPT Image 2 API.

## Install

Install in the current project:

```bash
npx skills add gorden888/happycode-imagegen
```

Install globally for all supported agents:

```bash
npx skills add -g gorden888/happycode-imagegen
```

**Quick install with Codex**

Send Codex this message:

> Globally install this skill: `npx skills add -g gorden888/happycode-imagegen`

## Configure

After installation, add your API key to the local `config.json` file created from
`config.example.json`. Do not commit `config.json` or share its API key.

## Use

Ask your coding agent to generate a new image or edit an existing image. The
skill uses the HappyCode API for image generation, edits, and inpainting.

### Batch generation

Requests for 2 to 5 output images are split into independent single-image API
requests and run concurrently. One batch supports at most 5 images; requests
for more images are rejected before any API call starts.
Results are reported in request order, and cancelling the batch stops its
active child requests.

Node.js is preferred. Equivalent Python clients provide runtime fallback for
both single-image and batch requests.

## Development

Generated images are written to `output/` and are intentionally not tracked.
The distributable configuration template is `config.example.json`.

## 中文说明

通过 HappyCode 兼容 OpenAI 的 GPT Image 2 API 生成和编辑位图图片。

### 安装

安装到当前项目：

```bash
npx skills add gorden888/happycode-imagegen
```

全局安装到所有支持的 Agent：

```bash
npx skills add -g gorden888/happycode-imagegen
```

**使用 Codex 快速安装**

将下面这句话发送给 Codex：

> 全局安装技能：`npx skills add -g gorden888/happycode-imagegen`

### 配置

安装后，根据 `config.example.json` 创建本地 `config.json`，并填写自己的
`api_key`。不要提交 `config.json`，也不要泄露其中的 API 密钥。

### 使用

让你的编程 Agent 生成新图片或编辑已有图片。该 skill 会通过 HappyCode API
处理图像生成、编辑和局部重绘。

### 批量生成

请求生成 2 到 5 张图片时，skill 会拆分为独立的单图 API 请求并发执行。每批
最多支持 5 张；超过 5 张会在发起任何 API 请求前直接拒绝。
结果会按请求顺序返回；取消批处理时，也会终止其中仍在运行的子请求。

默认优先使用 Node.js；Node 运行时不可用时，单图和批量请求均可回退到等价的
Python 客户端。

### 开发

生成图片会写入 `output/`，该目录不会被 Git 跟踪。可发布的配置模板为
`config.example.json`。
