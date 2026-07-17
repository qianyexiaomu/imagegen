# HappyCode Image Gen

[English](#happycode-image-gen) | [简体中文](#中文说明)

Generate and edit raster images through the HappyCode OpenAI-compatible GPT Image 2 API.

## Install

```bash
npx skills add gorden888/happycode-imagegen
```

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

## Development

Generated images are written to `output/` and are intentionally not tracked.
The distributable configuration template is `config.example.json`.

## 中文说明

通过 HappyCode 兼容 OpenAI 的 GPT Image 2 API 生成和编辑位图图片。

### 安装

```bash
npx skills add gorden888/happycode-imagegen
```

### 配置

安装后，根据 `config.example.json` 创建本地 `config.json`，并填写自己的
`api_key`。不要提交 `config.json`，也不要泄露其中的 API 密钥。

### 使用

让你的编程 Agent 生成新图片或编辑已有图片。该 skill 会通过 HappyCode API
处理图像生成、编辑和局部重绘。

### 批量生成

请求生成 2 到 5 张图片时，skill 会拆分为独立的单图 API 请求并发执行。每批
最多支持 5 张；超过 5 张会在发起任何 API 请求前直接拒绝。

### 开发

生成图片会写入 `output/`，该目录不会被 Git 跟踪。可发布的配置模板为
`config.example.json`。
