# HappyCode Image Gen

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

## Development

Generated images are written to `output/` and are intentionally not tracked.
The distributable configuration template is `config.example.json`.
