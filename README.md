# WildlifeSound

WildlifeSound identifies wildlife from audio. Record outdoors or upload an audio file, then the app shows likely species, confidence scores, model sources, and Wikipedia photos.

## Why

Wildlife is often easier to hear than see. This app turns short field recordings into quick species suggestions using multiple audio/AI models.

## How It Works

1. Record audio for up to 60 seconds, or upload an audio file.
2. While recording, the app analyzes each 10-second chunk.
3. Gemini 2.5 Flash Lite analyzes birds, frogs, insects, mammals, and other wildlife.
4. BirdNET runs locally in the browser for bird sound detection.
5. NatureLM-audio can run through an optional server endpoint.
6. Results are grouped by Gemini, BirdNET, and NatureLM when configured.
7. Species images are loaded from the Wikipedia REST API.

## Setup

Create `.env.local`:

```bash
GEMINI_API_KEY=your_gemini_api_key
NATURELM_API_URL=http://localhost:8787/analyze
NATURELM_API_TOKEN=
```

Run locally:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Optional NatureLM

NatureLM-audio runs in Python, not directly in the browser or Node server. In a Python environment with NatureLM-audio installed and Hugging Face access configured, run:

```bash
python naturelm-server.py
```

Then keep this in `.env.local`:

```bash
NATURELM_API_URL=http://localhost:8787/analyze
```

## Test Sounds

Add sample clips to the `sounds/` folder, then use the app's upload button to test them.

Supported formats: `.mp3`, `.wav`, `.m4a`, `.webm`, `.ogg`, `.flac`.

Included sample:

- `sounds/Eurasian Nuthatch - Sitta europaea hispaniensis - 30s.wav`

## Notes

- `GEMINI_API_KEY` powers Gemini wildlife detection.
- BirdNET runs locally in the browser with TensorFlow.js and does not need a server token.
- NatureLM-audio is not available through Hugging Face hosted Inference Providers. To use it, run `naturelm-server.py` or deploy the same bridge on a machine that can load the model.
- Keep tokens server-side in `.env.local`. Do not put secret keys in frontend files.
- To let public users share your keys, host the app with the included API routes. A static GitHub Pages deploy cannot hide shared keys.
- If the frontend is hosted separately from the API, set `window.WILDLIFE_API_BASE` to the API host before loading `assets/app.js`.
