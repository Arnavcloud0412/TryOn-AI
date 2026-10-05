# TryOn AI - Technical Architecture

## 1. Overview

```
┌──────────────────────── Chrome ────────────────────────┐        ┌──────────── Vercel ─────────────┐
│  Shopping tab                 Side panel (UI)          │ HTTPS  │  Express app on Vercel Function │
│  ┌────────────────┐  inject  ┌──────────────────────┐  │ Bearer │  (Fluid Compute, Node.js)       │
│  │ detector.js    │◄─────────│ sidepanel.js         │──┼───────►│  /api/profiles  /api/tryon ...  │
│  │ (on demand)    │─results─►│ classify / imageTools│  │ token  │        │            │           │
│  └────────────────┘          └──────────────────────┘  │        │   Neon Postgres   Private Blob  │
│  background.js: side panel, context menu, tab events   │        │   (documents)     (images)      │
└────────────────────────────────────────────────────────┘        │        │                        │
                                                                  │        ▼ waitUntil(runJob)      │
                                                                  │   Google Gemini image model     │
                                                                  └─────────────────────────────────┘
```

| Layer | Technology |
|---|---|
| Extension | Manifest V3, side panel, `chrome.scripting` on-demand injection, vanilla ES modules (no build step) |
| API | Express 4, deployed unchanged as a Vercel Function (Fluid Compute, Node.js 22+), `maxDuration` 300 s |
| Database | Neon serverless Postgres (HTTP driver, no connection pool) - local JSON file in development |
| Object storage | **Private** Vercel Blob store - local disk in development |
| Image processing | `sharp` (libvips) |
| AI | Google Gemini image model (`gemini-2.5-flash-image` by default, configurable) over REST; pluggable provider interface |

## 2. Chrome extension architecture

| File | Role |
|---|---|
| `manifest.json` | MV3; permissions `sidePanel, storage, scripting, activeTab, contextMenus, tabs`; `host_permissions: <all_urls>` so the detector can run on any shop and product images can be read without CORS issues. |
| `background.js` | Service worker: opens the side panel on toolbar click, registers the **"Try this on with TryOn AI"** image context menu, forwards tab-activation/navigation events so the panel re-scans. |
| `content/detector.js` | Product detector, injected **only when the panel is open** (no permanent content script). Returns serialisable product data and tags elements with `data-tryon-id` so the panel can highlight them on the page. |
| `sidepanel/*` | The whole UI: Try On, Profile, Wardrobe and Settings tabs. |
| `lib/api.js` | Backend client: device registration, bearer token, re-registration on 401, authenticated image blobs. |
| `lib/classify.js` | Category classifier using keywords from the backend catalog. |
| `lib/imageTools.js` | Client-side resize/re-encode of uploads, product-image quality analysis, bounded concurrency. |

The extension holds **no secrets**: just the backend URL and an anonymous device token in `chrome.storage.local`.

## 3. Product detection mechanism

`detector.js` combines several independent signals so it works across differently built sites rather than relying on per-site selectors.

1. **JSON-LD** (`script[type="application/ld+json"]`): recursive walk through `@graph`, `mainEntity` etc. for `Product`, `ProductGroup` (+ `hasVariant`), `ItemList` (listing pages) and `BreadcrumbList`. Extracts name, brand, description, colour, category, price/currency (`Offer`, `AggregateOffer`), images (string / array / `ImageObject`) and variants. Products that share a `productGroupID` are merged into one product with variants.
2. **Microdata** (`itemtype=schema.org/Product`, `itemprop=*`).
3. **Open Graph / product meta tags** (`og:type=product`, `og:image`, `product:price:amount`, `product:brand`, `twitter:image`).
4. **DOM gallery heuristic** for product pages: visible images are scored by rendered area, aspect ratio, gallery-like containers (`gallery|carousel|pdp|product-image|media`) and position. The nearest container holding several large images is treated as the gallery. High-resolution sources come from `srcset`, `<picture>`, `data-zoom-image`, `data-old-hires`, `data-a-dynamic-image` and lazy-load attributes. Header, footer and navigation images, logos, sprites, icons and swatches are excluded. The page is classified as a product page using structured data, `og:type` or an "Add to cart/bag" button plus `<h1>`.
5. **Listing heuristic**: for each sizeable image, walk up the DOM to the smallest ancestor that contains a link and a price-like string (multi-currency regex) and is narrower than 70 % of the viewport. Nested cards are removed and title, brand, price, link and images are extracted.
6. **Image URL upgrading**: common CDN patterns (Amazon `._AC_…_`, Shopify `_400x`, Cloudinary-style `w_`/`h_`, `?w=`/`width=` parameters) are rewritten to request about 1200 px renditions. The original URL is kept as a fallback.
7. **Variants**: JSON-LD variants with their own images, plus colour `<select>` options and `aria-label` swatches as named variants.

The side panel then:

- **Classifies the category** by weighted keyword matching over title, structured category, breadcrumbs, URL path, image alt text and description. Keywords come from the backend catalog. The user can override the result, and low-confidence results are flagged.
- **Selects the best image**: up to 6 candidate images are downloaded, downscaled to 48×48 and analysed for border uniformity (a plain studio background means a product-only shot), centre/border contrast, resolution and aspect ratio. This is combined with the detector score. The user can pick up to 3 images (primary plus extra views) or a variant.

## 4. Profile storage

- A **profile** (`profiles` collection) has a name, optional height, fit preference and notes. A device can have up to 6 profiles.
- **Photo slots** are defined in the catalog: `full` (required), `upper`, `lower`, `feet`, `face`, `hands`. Each comes with a description and capture guidance shown in the UI.
- On upload, the extension downsizes the image to ≤1600 px JPEG and gives brightness and resolution hints. The server then applies EXIF rotation, **strips all metadata (GPS)**, resizes to ≤1280 px, re-encodes to JPEG, hashes it (SHA-256) and stores it in the **private Blob store** at `users/<userId>/photos/<photoId>.jpg`. Re-uploading an identical photo is a no-op.
- **Photo selection per category** (`prompt.js`): each category lists its preferred slots in priority order (e.g. shoes: `feet → full`, necklace: `face → upper → full`). The first available slot is the primary person image, plus up to 2 supporting references (usually the face, for identity). Outfits use the full-body photo.

## 5. Backend / API architecture

The backend is a single Express app (`src/server.js`, `export default app`) that Vercel runs as a Function. Locally, the same file starts an HTTP server.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Provider, model, storage drivers (returns 503 if storage is not configured on Vercel) |
| `GET /api/config` | Categories, photo slots, scenes, privacy text (public, cached 5 min) |
| `POST /api/auth/register` | Creates an anonymous device account and returns a bearer token (rate-limited per IP hash) |
| `GET/PATCH/DELETE /api/me` | Account info, consent and active profile; **DELETE erases everything** |
| `GET/POST/PATCH/DELETE /api/profiles[/:id]` | Profile CRUD |
| `PUT/GET/DELETE /api/profiles/:id/photos/:slot` | Photo upload (multipart), authenticated download, delete |
| `POST /api/product-images` | Server fetches and caches product image URLs (SSRF-protected) |
| `POST /api/product-images/upload` | Fallback: extension uploads the image bytes itself |
| `GET /api/product-images/:id` | Cached product image (auth required) |
| `POST /api/tryon` | Validates the request, returns a cached result or creates a job (202) |
| `GET /api/tryon/:id` | Job status / progress / ETA (polled every 1.5 s) |
| `GET /api/results`, `GET /api/results/:id/image[?size=thumb]`, `DELETE /api/results[/:id]` | Wardrobe |

**Authentication**: random 256-bit device token. Only its SHA-256 hash is stored, and every resource is checked for ownership.

**Serverless job model**: `POST /api/tryon` writes a `results` document (`status: queued`), responds immediately, and passes the generation promise to `waitUntil()` from `@vercel/functions`. That keeps the same function invocation alive until generation finishes, within the 300 s duration available on every plan. The job writes its stage (`preparing → uploading → generating → saving → done/failed`) to Postgres with atomic JSONB merges, so polling requests can be answered by any instance. Progress during generation is estimated from the average duration of recent jobs. If a job's invocation dies, it is marked `failed` (`TIMEOUT`) the next time it is read (after 330 s without updates). Limits: 2 concurrent jobs per user and 40 try-ons per hour (configurable).

**Database schema** (`db/schema.sql`): a single `docs(collection, id, data jsonb, created_at, updated_at)` table with a GIN index (`jsonb_path_ops`) for equality filters such as `data @> '{"userId": "…"}'`. The document shapes are listed in the schema file. The same document interface (`get/find/put/patch/remove/removeWhere`) is implemented by the Postgres driver and by a local JSON driver used in development.

## 6. AI model / provider

- **Provider**: Google Gemini image generation/editing model via REST `generateContent` with `responseModalities: ["IMAGE","TEXT"]` and a 3:4 portrait aspect ratio. It accepts multiple reference images and follows instructions well, so one model covers every category (garments, shoes, jewellery, eyewear, bags) and can generate new scenes and poses, which classic garment-only VTON models cannot.
- **Models**: `GEMINI_IMAGE_MODEL` (default `gemini-2.5-flash-image`) and `GEMINI_FAST_MODEL` for fast mode. Both are configurable without code changes.
- **Pluggable**: `src/ai/index.js` defines the provider interface (`generate(parts, opts)`, `deleteRemoteFile`). A `mock` provider (labelled composite) allows offline development and demos without a key.
- **Free fallback** (`src/ai/huggingface.js`): the public IDM-VTON diffusion model on Hugging Face (ZeroGPU), called via `@gradio/client`. It is used automatically when Gemini returns a quota, rate-limit or auth error (`AI_FALLBACK=huggingface`), or as the primary provider with `AI_PROVIDER=huggingface`. It needs no billing; an optional free `HF_TOKEN` raises the GPU quota. Limitations: upper-body garments only (T-shirts, shirts, jackets; other categories get a clear `UNSUPPORTED_CATEGORY` error), one garment per image, the original background is kept (no scene generation), and about 25 s per image. Fallback results are cached under a model-specific key, so they are never served in place of a Gemini result.

### Prompt design (`src/prompt.js`)

The prompt is an ordered list of parts in which **every image is preceded by a text label** ("PERSON - main reference photo (Full body)", "PRODUCT 1 - main product photo", …), followed by instructions covering:

- **Identity**: preserve face, skin tone, hair, body shape and age; no beautification.
- **Product fidelity** (top priority): identical colours, patterns, prints, logos, text, materials, cut and proportions. Ignore any model, mannequin or background in the product photos.
- **Placement**: category-specific instructions from the catalog (e.g. shoes: correct left/right, perspective, ground contact shadows; necklace: chain length on the collarbones, head-and-shoulders framing).
- **Scene (context-aware)**: `auto` picks a scene by matching product text against scene keywords (swimwear or Hawaiian → beach, puffer or wool → winter street, blazer → office, running → sport…), falling back to the category's default. Users can also choose studio, keep their own background, a named scene or a custom description.
- **Realism**: natural drape, folds, occlusion, lighting consistent with the scene; a single photo with no collage, text or watermark.
- **Outfits**: all products worn together in one image.

## 7. Image-processing workflow

1. The page shows the product → the detector extracts image URLs (upgraded to high resolution).
2. The panel analyses candidates and picks the best image, then **prefetches** it to the backend as soon as a product is selected, before the user presses Try On.
3. The backend downloads the image: only http(s), DNS-resolved addresses checked against private/loopback/link-local ranges on every redirect hop, 15 s timeout, 15 MB cap, image content types only. It flattens transparency onto white, resizes to ≤1024 px JPEG, hashes, and stores it at `products/<id>.jpg` in Blob with a `productImages` record (7-day cache keyed by URL).
4. If the server can't fetch the image (hotlink protection, geo-blocking), the extension fetches it with its host permission, downsizes it below the 4.5 MB function body limit and uploads it.
5. At try-on time, the job loads the profile photos and product images from Blob. Profile photos are uploaded to the **Gemini Files API once** and the file URI is cached on the photo document for up to 48 h, so they aren't re-sent with every request. Product images are sent inline.
6. The generated image is stored in Blob (`users/<uid>/results/<id>.png`) along with a 360×480 thumbnail for the wardrobe.

## 8. Result storage

Result metadata lives in the `results` documents: products with their image IDs, scene, model, duration and cache key. Images are stored in the private Blob store and streamed to the owner only through `GET /api/results/:id/image`. The extension fetches them with the bearer token and shows them as `blob:` URLs. **Result cache**: the cache key is a SHA-256 of the prompt version, provider, model, photo hashes, product image hashes, categories, variant, scene and profile details. An identical request returns the stored result instantly unless the user presses **Regenerate**.

## 9. Error handling

| Situation | Handling |
|---|---|
| Backend unreachable | The panel shows an offline card with Retry and a link to server settings; the connection dot in the header turns red |
| Page can't be scripted (`chrome://`, Web Store) | Friendly message; the right-click flow still works on normal pages |
| No products detected | Empty state with tips (open a product page / right-click an image) |
| Product image fetch fails | Automatic fallback URL, then extension-side upload, then a clear error |
| Invalid / too large upload | 400 / 413 with readable messages; client-side downsizing prevents most cases |
| AI rate limit / 5xx / timeout | Retries with backoff while enough function time remains, then `AI_RATE_LIMITED` / `AI_TIMEOUT`; the UI offers **Try again** |
| AI safety block / no image returned | `AI_BLOCKED` / `AI_NO_IMAGE` with the provider's reason; not retryable |
| Expired Gemini file reference | Cache invalidated and request resent with inline images |
| Function killed mid-job | Stale detection marks the job failed (`TIMEOUT`) |
| Per-user limits | 429 with explanation |
| Unknown errors | Logged server-side; generic message to the client (no internals leaked) |

## 10. Privacy & security

- **No API keys in the extension**. The Gemini key exists only as a server-side environment variable.
- **Secure transport**: the deployed backend is HTTPS-only (Vercel). The bearer token is sent in the `Authorization` header.
- **Where images are stored**: a private Vercel Blob store (not publicly addressable), plus transiently at the Gemini Files API (48 h auto-expiry, deleted when the photo is deleted). This is shown in Settings and on the Profile tab.
- **Access control**: every document is owned by a user ID and checked on every request. Tokens are stored hashed.
- **Data minimisation**: EXIF/GPS is stripped, photos are downsized, and only the photos needed for the category are sent.
- **Deletion**: delete a single photo, a profile (with its photos and results), single or all results, or **Delete all my data** (account, documents, every Blob under `users/<id>/`, and remote AI files).
- **No training**: consent is off by default and stored per user. The system never uses images for training. Use a billing-enabled Gemini key so Google doesn't use inputs to improve its products.
- **Hardening**: SSRF-safe fetcher, CORS restricted to `chrome-extension://` origins (or an explicit allow-list), `nosniff` / `no-referrer` / `DENY` framing headers, JSON body limit 200 KB, upload limit 4 MB, input length clamping, HTML-escaped rendering of all page-derived text in the panel, strict extension CSP.
- **Legitimate use**: the detector only reads what the user's page already displays. It does not bypass logins, paywalls or bot protection.

## 11. Performance

- Profile photos are uploaded once, deduplicated by hash, and cached at the AI provider.
- Product images are prefetched on selection, cached server-side by URL for 7 days, and fetched in parallel.
- Image sizes are matched to model needs (≤1280 px person, ≤1024 px product).
- Identical try-on requests return instantly from the result cache.
- Fast mode uses a configurable lower-latency model.
- Progress stages are shown with a percentage and ETA. The user can keep browsing; a banner appears when the result is ready, and an in-progress job resumes if the panel is reopened.
- Neon's HTTP driver avoids connection-pool exhaustion, and Fluid Compute reuses warm instances.
