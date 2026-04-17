# Last Breath

**An acoustic biodiversity monitor that listens to the world and tells you what's disappearing.**

Point a microphone at any outdoor environment — a garden, a forest edge, a park at dawn — and Last Breath identifies every species by sound, cross-references each one against the IUCN Red List, and gives you a real-time biodiversity health score for that place. Verified sightings are logged to a live global map shared across all users.

---

## The Problem

We are living through the sixth mass extinction. Most people have no idea it is happening outside their window. Acoustic monitoring — listening for the species present in a soundscape — is one of the most sensitive and non-invasive ways to measure biodiversity. Field researchers have done this for decades with expensive equipment and months of manual analysis. Last Breath brings the same capability to anyone with a browser.

---

## Demo

> *Record a 10-second clip outdoors. Within seconds you'll know which species you're sharing your environment with, whether their populations are declining, and roughly how many breeding seasons remain if current trends continue.*

![Last Breath demo](https://raw.githubusercontent.com/YOUR_USERNAME/last-breath/main/demo.gif)

---

## How It Works

```
Microphone input (10s)
        │
        ▼
  Web Audio API          ←─ live waveform visualisation
        │
        ▼
  Base64 audio blob
        │
        ▼
  /api/analyse           ←─ Vercel serverless function (key never exposed)
        │
        ▼
  Gemini 2.5 Flash       ←─ bioacoustician prompt → structured JSON
        │
        ▼
  Species list
        │
        ├──► /api/iucn   ←─ IUCN Red List API v4 (parallel lookups)
        │         │
        │         ▼
        │    category · population trend · habitat narrative
        │
        ▼
  Biodiversity score     ←─ weighted by threat category
        │
        ▼
  /api/sightings         ←─ Supabase (global, shared across all users)
        │
        ▼
  Leaflet map            ←─ live global sightings from every user
```

---

## Features

- **Live waveform visualiser** — Web Audio API renders your microphone input in real time so you can see the soundscape before the analysis begins
- **AI species identification** — Gemini 2.5 Flash identifies birds, frogs, insects and mammals by their acoustic signatures alone
- **Real conservation data** — every detected species is looked up against the IUCN Red List v4 API for its current threat category, population trend, and habitat description
- **Biodiversity health score** — a 0–100 score calculated from the threat categories present in your soundscape, animated with an SVG ring gauge
- **Extinction countdown** — for species that are Vulnerable, Endangered, or Critically Endangered with a decreasing population trend, the app estimates breeding seasons remaining in your region
- **Verified sighting log** — Auth0 authentication lets users log sightings as provable conservation records
- **Global community map** — every logged sighting is stored in Supabase and appears on a shared Leaflet map with CartoDB dark tiles
- **No build step** — single `index.html` file served statically; backend logic lives in three Vercel serverless functions

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript (zero frameworks) |
| AI analysis | Google Gemini 2.5 Flash via `generateContent` API |
| Conservation data | IUCN Red List API v4 |
| Authentication | Auth0 Universal Login (SPA SDK) |
| Map | Leaflet.js + CartoDB Dark Matter tiles |
| Database | Supabase (PostgreSQL) |
| Hosting | Vercel (static site + serverless functions) |
| Fonts | DM Serif Display + DM Mono (Google Fonts) |

---

## Self-Hosting

### 1. Clone and deploy

```bash
git clone https://github.com/YOUR_USERNAME/last-breath.git
cd last-breath
```

Deploy to Vercel:

```bash
npm i -g vercel
vercel deploy --prod
```

Or connect the repo directly at [vercel.com](https://vercel.com) — no build settings required.

### 2. Set environment variables

In your Vercel project → **Settings → Environment Variables**, add:

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) |
| `IUCN_API_TOKEN` | [api.iucnredlist.org/users/sign_up](https://api.iucnredlist.org/users/sign_up) |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase project → Settings → API → `service_role` secret |
| `ALLOWED_ORIGIN` | Your deployed URL e.g. `https://last-breath.vercel.app` |

### 3. Configure Auth0

1. Create a free application at [auth0.com](https://auth0.com) — type: **Single Page Application**
2. Copy **Domain** and **Client ID** into `index.html`:

```js
const AUTH0_DOMAIN    = 'dev-xxxx.us.auth0.com';
const AUTH0_CLIENT_ID = 'your_client_id';
```

3. In your Auth0 application settings, add your Vercel URL to:
   - Allowed Callback URLs
   - Allowed Logout URLs
   - Allowed Web Origins

### 4. Create the Supabase table

In your Supabase project → **SQL Editor**:

```sql
CREATE TABLE sightings (
  id              TEXT PRIMARY KEY,
  timestamp       TIMESTAMPTZ DEFAULT NOW(),
  common_name     TEXT NOT NULL,
  scientific_name TEXT,
  iucn_category   TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  city            TEXT,
  user_sub        TEXT NOT NULL,
  user_email      TEXT
);
```

### 5. Local development

```bash
vercel dev
```

This runs the static site and all serverless functions locally at `localhost:3000`.

---

## Security

API keys and database credentials never reach the browser. All external API calls are proxied through three serverless functions:

- `api/analyse.js` — injects `GEMINI_API_KEY` server-side; retries across model fallbacks on overload
- `api/iucn.js` — injects `IUCN_API_TOKEN` server-side; handles the two-step v4 taxa → assessment lookup
- `api/sightings.js` — injects `SUPABASE_SERVICE_KEY` server-side; validates all writes

Only Auth0's `domain` and `clientId` are in client-side code — this is by design; the Auth0 SPA SDK is built for browser use and security is enforced by the Allowed Callback URLs whitelist in your Auth0 dashboard.

---

## Project Structure

```
last-breath/
├── index.html              # entire frontend — HTML, CSS, JS
├── api/
│   ├── analyse.js          # Gemini proxy with retry + model fallback
│   ├── iucn.js             # IUCN Red List v4 proxy
│   └── sightings.js        # Supabase read/write proxy
└── .gitignore
```

---

## Roadmap

- [ ] Audio file upload (analyse recordings you didn't make live)
- [ ] Species trend graph over time for a specific location
- [ ] Exportable PDF field report for each recording session
- [ ] PWA support for offline-first mobile use
- [ ] Community species verification (flag uncertain identifications)

---

## Data Sources

- **Species conservation status** — [IUCN Red List of Threatened Species](https://www.iucnredlist.org/), the world's most comprehensive inventory of species' global conservation status
- **Acoustic identification** — Google Gemini 2.5 Flash multimodal model
- **Reverse geocoding** — [Nominatim](https://nominatim.openstreetmap.org/) (OpenStreetMap)
- **Map tiles** — [CartoDB Dark Matter](https://carto.com/basemaps/)

---

## Contributing

Pull requests are welcome. For significant changes please open an issue first.

If you find a species misidentified, or want to improve the bioacoustician prompt, the system prompt lives at the top of the `callGemini` function in `index.html` — it is the single most impactful thing to tune.

---

## License

MIT
