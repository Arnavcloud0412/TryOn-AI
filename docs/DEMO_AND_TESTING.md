# Demo script & testing guide

## Automated API test

```bash
cd backend && npm run dev          # terminal 1
cd backend && npm run smoke        # terminal 2
# against a deployment:
API=https://<your-project>.vercel.app/api npm run smoke
```

The smoke test covers registration, profile creation, photo upload, product image upload, SSRF rejection, try-on job, polling, result download, the result cache, the wardrobe list and full account deletion.

## Mandatory demonstration (suggested video script, about 5 minutes)

| # | Requirement | What to show |
|---|---|---|
| 1 | Create a personal digital profile | Profile tab → create "Me" → upload full-body, upper-body, feet and face photos; open "How to take this photo"; show the category coverage chips |
| 2 | Install the extension | `chrome://extensions` → Load unpacked → pin → open the side panel → Settings shows the Vercel URL and "Connected" |
| 3 | Open multiple shopping websites | Use at least 3 sites with different structures (see matrix below) |
| 4 | Detect products | Panel lists detected products with source ("Structured data", "Listing card"…); click one and it is highlighted on the page |
| 5 | Select a product | Show category detection, image strip with the auto-picked **BEST** image, variant chips |
| 6 | Generate a try-on | Press Try On → progress stages → result |
| 7 | Two different categories | e.g. a T-shirt (upper body) **and** shoes (feet) or a necklace |
| 8 | Product stays recognisable | Show the result next to the product thumbnail; use Compare in Wardrobe |
| 9 | Profile reused for multiple products | Try a second and third product without re-uploading anything; open Wardrobe |

Bonus moments: a listing page with many products, a right-click "Try this on", an outfit (T-shirt + trousers) across two sites, a custom scene ("Paris street at sunset"), the auto beach scene for a Hawaiian shirt, side-by-side compare, a second profile, fast mode, and Delete all my data.

## Website testing matrix

Fill this in while recording the demo. The sites below are examples with different page structures.

| Website type | Example | Page type | Main signals expected | Category tested | Result |
|---|---|---|---|---|---|
| Shopify store | any `*.myshopify.com` / Allbirds / Gymshark | Product | JSON-LD Product + variants, Shopify CDN upgrade | Shoes / T-shirt | |
| Large marketplace | Amazon | Product | `data-old-hires` / `data-a-dynamic-image`, H1 + cart button | Watch / bag | |
| Fashion retailer | H&M, Zara, Uniqlo, ASOS | Product + listing | JSON-LD / OG, gallery heuristic, listing cards | Dress / jacket | |
| Indian fashion | Myntra, Ajio | Product + listing | Cloudinary-style `w_` URLs, listing cards | Kurta / T-shirt | |
| Jewellery | Tanishq, Pandora, Mejuri | Product | JSON-LD, plain-background images | Necklace / ring | |
| Category page | any site's "Men's T-shirts" page | Listing | Repeated cards with price + link | Several | |

## Manual checks

- [ ] Panel on `chrome://extensions` shows the "cannot read this page" message
- [ ] Stopping the backend shows the offline card; Retry reconnects
- [ ] Uploading a dark or low-resolution photo shows a quality hint
- [ ] Shoes selected with no feet photo shows the "add a Feet photo" tip
- [ ] Pressing Try On twice with identical settings returns the second result instantly ("Instant (cached)")
- [ ] Regenerate produces a new image
- [ ] Closing and reopening the panel during generation resumes progress
- [ ] Delete profile removes its photos and results; Delete all my data resets the extension
