// Builds the 1024px app icon source from the extracted portrait (CRT head),
// then `npx tauri icon assets-src/icon.png` generates all platform sizes.
import sharp from 'sharp';
const portrait = 'public/sprites/portrait.png';
const meta = await sharp(portrait).metadata();
// Head and shoulders: a square from the top of the full-body portrait.
const head = await sharp(portrait)
  .extract({ left: 0, top: 0, width: meta.width, height: Math.min(meta.width, meta.height) })
  .resize(720, 720, { kernel: 'nearest', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
.png().toBuffer();
const bg = Buffer.from(`<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#15101F"/>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="none" stroke="#765A9D" stroke-width="16"/>
</svg>`);
await sharp(bg).composite([{ input: head, left: 152, top: 170 }]).png().toFile('assets-src/icon.png');
console.log('wrote assets-src/icon.png');
