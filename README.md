# WildlifeSound

WildlifeSound identifies wildlife from short audio clips. Record up to 60 seconds or upload audio, then the app shows model results, confidence scores, and Wikipedia photos.

## Why

Wildlife is often easier to hear than see. This app gives quick field suggestions from sound, with multiple models shown separately so users can compare results.

## How It Works

1. Record audio or upload a file.
2. Live detection runs every 10 seconds while recording.
3. Gemini 2.5 Flash Lite identifies birds, frogs, insects, mammals, and other wildlife.
4. BirdNET identifies bird species through the local API when available, with browser TensorFlow.js fallback.
5. YAMNet runs fully in the browser for broad animal/audio classes.
6. Species photos come from the Wikipedia REST API.

## Setup

Create `.env.local`:

```bash
GEMINI_API_KEY=your_gemini_api_key
ALLOWED_ORIGIN=http://localhost:3000
```

Run locally:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## BirdNET

The app can use a local BirdNET Python analyzer if it exists:

```bash
BIRDNET_ANALYZE_BIN=/path/to/birdnet-analyze
```

If that is not set or not installed, the app falls back to the browser BirdNET model.

Optional tuning:

```bash
BIRDNET_MIN_CONF=0.03
BIRDNET_TOP_N=8
BIRDNET_THREADS=2
```

## Test Sounds

Use the upload button with clips in the `sounds/` folder.

Included sample:

```text
sounds/Eurasian Nuthatch - Sitta europaea hispaniensis - 30s.wav
```

Supported formats: `.mp3`, `.wav`, `.m4a`, `.webm`, `.ogg`, `.flac`.

## Hosting

For the best public deployment, keep API keys server-side. Deploy the included API routes somewhere server-capable, then point the frontend to it with:

```html
<script>
  window.WILDLIFE_API_BASE = "https://your-api-host.example";
</script>
```

For the static GitHub Pages demo, visitors are prompted for their own Gemini API key when they try detection. The key is stored only in that browser tab with `sessionStorage`.

## Models

- Gemini 2.5 Flash Lite: species-level general wildlife detection.
- BirdNET: bird species detection.
- YAMNet AudioSet: broad browser-only sound class detection.
