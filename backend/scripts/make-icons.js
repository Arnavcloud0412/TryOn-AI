// Generates the extension icons from an inline SVG: `npm run icons`
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#db2777"/></linearGradient></defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <path d="M44 26 L28 34 L16 52 L30 62 L36 56 L36 104 L92 104 L92 56 L98 62 L112 52 L100 34 L84 26
           C82 36 74 42 64 42 C54 42 46 36 44 26 Z" fill="#fff"/>
  <path d="M86 70 l4 9 9 4 -9 4 -4 9 -4 -9 -9 -4 9 -4z" fill="#db2777"/>
</svg>`;

for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(outDir, `icon${size}.png`));
}
console.log('Icons written to', outDir);
