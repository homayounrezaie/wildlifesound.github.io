# WildlifeSound

WildlifeSound identifies wildlife from audio. Record outdoors or upload an audio file, then the app shows likely species, confidence scores, model sources, Wikipedia photos, and Xeno-canto reference sounds.

## Why

Wildlife is often easier to hear than see. This app turns short field recordings into quick species suggestions using multiple audio/AI models.

## How It Works

1. Record audio for up to 60 seconds, or upload an audio file.
2. While recording, the app analyzes each 10-second chunk.
3. Results are grouped by model:
   - BirdNET · AST
   - BirdNET · Wav2Vec
   - Gemini AI
4. Duplicate species in the same model section are merged, keeping the best score.
5. Species images are loaded from the Wikipedia REST API.
6. Reference recordings are loaded from Xeno-canto for comparison.

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
- `HF_TOKEN` powers the two BirdNET Hugging Face models.
- `XENO_CANTO_API_KEY` powers verified reference recordings and sonograms.
- Keep tokens server-side in `.env.local`. Do not put secret keys in frontend files.
- To let public users share your keys, host the app with the included API routes. A static GitHub Pages deploy cannot hide shared keys.
