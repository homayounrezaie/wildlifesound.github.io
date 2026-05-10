# WildlifeSound

WildlifeSound identifies wildlife from audio. Record outdoors or upload an audio file, then the app shows likely species, confidence scores, model sources, Wikipedia photos, and Xeno-canto reference sounds.

## Why

Wildlife is often easier to hear than see. This app turns short field recordings into quick species suggestions using multiple audio/AI models.

## How It Works

1. Record audio for up to 60 seconds, or upload an audio file.
2. While recording, the app analyzes each 10-second chunk.
3. Gemini 2.5 Flash Lite and BirdNET analyze the sound.
4. Xeno-canto adds verified reference recordings for matched species.
5. Results are grouped by Gemini, BirdNET, and Xeno-canto references.
6. Species images are loaded from the Wikipedia REST API.

## Setup

Create `.env.local`:

```bash
GEMINI_API_KEY=your_gemini_api_key
HF_TOKEN=your_huggingface_token
XENO_CANTO_API_KEY=your_xeno_canto_api_key
```

Run locally:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Test Sounds

Add sample clips to the `sounds/` folder, then use the app's upload button to test them.

Supported formats: `.mp3`, `.wav`, `.m4a`, `.webm`, `.ogg`, `.flac`.

## Notes

- `GEMINI_API_KEY` powers Gemini wildlife detection.
- `HF_TOKEN` powers the BirdNET Hugging Face model section.
- `XENO_CANTO_API_KEY` powers verified reference recordings and sonograms.
- Keep tokens server-side in `.env.local`. Do not put secret keys in frontend files.
- To let public users share your keys, host the app with the included API routes. A static GitHub Pages deploy cannot hide shared keys.
- If the frontend is hosted separately from the API, set `window.WILDLIFE_API_BASE` to the API host before loading `assets/app.js`.
