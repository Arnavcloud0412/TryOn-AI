# TryOn AI - Virtual Try-On Chrome Extension

Create a personal digital profile once, then virtually try on clothes, shoes, jewellery and accessories from **any** shopping website, directly from a Chrome side panel.

```
extension/   Chrome extension (Manifest V3, plain JS, no build step)
backend/     Serverless API (Express on Vercel Functions) + AI try-on pipeline
docs/        Architecture and demo/testing guide
```

- Architecture & design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Demo script & website testing matrix: [docs/DEMO_AND_TESTING.md](docs/DEMO_AND_TESTING.md)
- Database schema: [backend/db/schema.sql](backend/db/schema.sql)

## Features

- **Digital body profile** - guided photo slots (full body, upper body, legs, feet, face, hands) with capture tips, quality hints, EXIF/GPS stripping and per-category coverage. Multiple profiles supported.
- **Cross-site product detection** - schema.org JSON-LD (incl. product groups and variants), microdata, Open Graph / product meta tags, DOM gallery heuristics and listing-card detection. Works on product pages *and* listing pages. Right-click any image -> "Try this on".
- **Automatic category + best-image selection** - keyword classifier served by the backend; images scored by structure, resolution and pixel analysis (plain background = product-only shot).
- **AI try-on** - Google Gemini image model with identity-preserving, product-faithful prompts, category-specific placement and **context-aware scenes** (e.g. beach for swimwear, snowy street for a puffer jacket).
- **Outfits** - combine up to 4 products (even from different sites) in one generated image.
- **Wardrobe** - saved results, side-by-side comparison, download, regenerate, delete.
- **Privacy** - no API keys in the extension, private Blob storage, device-token auth, full data deletion, no training use.
- **Performance** - profile photos uploaded once (and cached at the AI provider via the Gemini Files API), product images cached server-side, identical requests served instantly from the result cache, fast mode, progress with ETA.

## 1. Deploy the backend to Vercel

Prerequisites: a Vercel account, the Vercel CLI (`npm i -g vercel`), and a Gemini API key from <https://aistudio.google.com/apikey>.

```bash
cd backend
vercel link                      # create/link a Vercel project (Root Directory = backend)
vercel integration add neon      # serverless Postgres -> injects DATABASE_URL
vercel blob create-store tryon-ai-images --access private   # then connect it to the project
vercel env add GEMINI_API_KEY    # paste your key (Production + Preview)
vercel deploy --prod
```

You can do the same in the dashboard: **Storage -> Create -> Neon** and **Storage -> Create -> Blob (Private)**, connect both to the project, then add `GEMINI_API_KEY` under **Settings -> Environment Variables** and redeploy.

Check `https://<your-project>.vercel.app/api/health`. It should return `"ok": true, "database": "postgres", "storage": "vercel-blob-private"`. The database table is created automatically on first request; you can also run `db/schema.sql` yourself.

Optional environment variables are listed in [backend/.env.example](backend/.env.example) (model choice, fast-mode model, rate limits, CORS allow-list).

> **No Gemini billing?** When Gemini reports a quota or billing error, the backend automatically falls back to the free IDM-VTON model on Hugging Face (T-shirts, shirts and jackets only; keeps the original background). For a higher free quota, create a free "Read" token at <https://huggingface.co/settings/tokens> and run `vercel env add HF_TOKEN production`.

> **AI data use:** on Google's paid tier (a billing-enabled key), Gemini API inputs are not used to improve Google's products. Use a billing-enabled key for real user photos.

## 2. Install the Chrome extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Pin **TryOn AI** and click it to open the side panel.
4. In **Settings**, set the backend URL to `https://<your-project>.vercel.app` and press **Save & connect**.
5. In **Profile**, create a profile and upload at least a full-body photo.
6. Open any shopping site, select a product in the panel and press **Try On**.

## Local development (no cloud accounts needed)

```bash
cd backend
npm install
cp .env.example .env      # optionally add GEMINI_API_KEY; without it the "mock" provider is used
npm run dev               # http://127.0.0.1:8787
npm run smoke             # end-to-end API test (in a second terminal)
```

Without `DATABASE_URL` / Blob credentials the backend automatically uses a local JSON file and local disk (`backend/data/`), so the full flow can be developed offline. `vercel dev` or `vercel env pull .env` lets you run locally against the real Neon and Blob resources.

The extension defaults to `http://127.0.0.1:8787`; change it in Settings.

## Adding a product category

Edit [backend/catalog/catalog.js](backend/catalog/catalog.js) and add an entry to `categories` with its label, preferred profile photos, detection keywords, placement instructions and default scene. Redeploy the backend. The extension downloads the catalog at runtime, so it needs no rebuild.
