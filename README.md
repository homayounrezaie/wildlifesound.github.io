# WildlifeSound

Acoustic biodiversity monitor — record or upload audio and identify wildlife species by sound.

## How it works

Record audio or upload a file. Every 10 seconds while recording, the audio is sent to three models in parallel and results appear live, grouped by model. When you stop, the full recording is analyzed for a final summary with photos and confidence scores.

## Models

| Model | What it does |
|-------|-------------|
| BirdNET · AST | 4,941 bird species via Audio Spectrogram Transformer |
| BirdNET · Wav2Vec | Broad bird classifier via Wav2Vec2 |
| Gemini 2.5 Flash | Birds, frogs, insects, and mammals |

## How to use

**Deploy to Vercel** and add these environment variables:

```
HF_TOKEN=your_huggingface_token
GEMINI_API_KEY=your_gemini_api_key
```

**Run locally:**

```bash
npm install -g vercel
vercel dev
```

Then open `http://localhost:3000`.

## License

MIT
