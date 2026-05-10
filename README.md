# WildlifeSound

WildlifeSound identifies wildlife from audio. Record outdoors or upload an audio file, then the app shows likely species, confidence scores, model sources, and Wikipedia photos.

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

## Setup

Create `.env.local`:

```bash
GEMINI_API_KEY=your_gemini_api_key
HF_TOKEN=your_huggingface_token
```

Run locally:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Notes

- `GEMINI_API_KEY` powers Gemini wildlife detection.
- `HF_TOKEN` powers the two BirdNET Hugging Face models.
- Keep both tokens server-side in `.env.local`. Do not put secret keys in frontend files.
