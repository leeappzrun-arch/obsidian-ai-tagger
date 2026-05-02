# AI Tagger

An [Obsidian](https://obsidian.md) plugin that reads your note content and uses a local or remote AI to generate and maintain relevant tags.

Works with any [Ollama](https://ollama.ai) instance or any OpenAI-compatible chat completions endpoint (OpenAI, LM Studio, OpenRouter, etc.).

---

## Features

- Generate tags for the active note from the ribbon or command palette
- Generate tags for every note in your vault in one command
- Right-click any note in the file explorer to generate tags for it
- Optionally regenerate tags automatically after note content changes
- Prefer existing vault tags when they match the AI's suggestion, even if casing differs
- Preserve manually added tags — only plugin-managed tags are replaced on regeneration
- Choose tag casing: keep AI output, lower-kebab, UC first, camelCase, PascalCase, or snake_case
- Experimental: link related words in the note body to Obsidian tag searches

---

## Installation

### Manual

1. Download `obsidian-ai-tagger.zip` from the [latest release](../../releases/latest)
2. Unzip into your vault's `.obsidian/plugins/` folder so it looks like:
   ```
   .obsidian/plugins/obsidian-ai-tagger/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```
3. In Obsidian go to **Settings → Community plugins**, disable Safe Mode if prompted, then enable **AI Tagger**

---

## Setup

### 1 — Run an AI endpoint

**Ollama (recommended for local use)**

```bash
ollama pull llama3.1
ollama serve
```

**OpenAI-compatible (cloud)**

Use any service that exposes a `/v1/chat/completions` endpoint, e.g. `https://api.openai.com/v1`.

### 2 — Configure the plugin

Open **Settings → AI Tagger** and fill in:

| Setting | Description |
|---|---|
| Provider | `Ollama` or `OpenAI-compatible` |
| AI URL | Base URL of your endpoint, e.g. `http://localhost:11434` |
| API key | Optional — sent as a Bearer token |
| Model | Model name, e.g. `llama3.1` or `gpt-4o-mini` |
| Automatically generate tags | Regenerate tags after note content changes |
| Auto-generate delay | Seconds to wait after the last change before calling the AI (default: 8) |
| Tag search links | Experimentally link related words in the note to Obsidian tag searches |
| Tag format | Casing applied to new tags: keep AI output, lower-kebab, UC first, camelCase, PascalCase, snake_case |
| Maximum tags | Upper limit for generated tags per note (default: 8) |
| Generated tags property | Frontmatter property used to track plugin-managed tags (default: `aiGeneratedTags`) |

---

## Usage

### Generate tags for the active note

Click the **sparkles** icon in the ribbon, or run **AI Tagger: Generate tags for active note** from the command palette.

### Generate tags for all notes

Run **AI Tagger: Generate tags for all notes in vault** from the command palette.

### Generate tags from the file explorer

Right-click any markdown file and choose **Generate AI tags**.

---

## Building from source

```bash
npm install
npm run build   # outputs main.js
```

---

## License

MIT
