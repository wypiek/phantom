// Debug helper: finds connected foreground blobs in the spritesheet and renders
// a numbered overlay so frames can be mapped to animations by hand.
import sharp from 'sharp';
const [src, out] = process.argv.slice(2);
const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const fg = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
  const d = data[i*4+3];
  fg[i] = d > 80 ? 1 : 0;
}
// dilate by R to merge nearby parts
const R = 3;
const dil = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fg[y*W+x]) {
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const xx = x+dx, yy = y+dy; if (xx>=0&&yy>=0&&xx<W&&yy<H) dil[yy*W+xx] = 1; }
}
const lab = new Int32Array(W*H).fill(-1); const boxes = [];
for (let i = 0; i < W*H; i++) if (dil[i] && lab[i] < 0) {
  const st = [i]; lab[i] = boxes.length; let x0=W,y0=H,x1=0,y1=0,n=0;
  while (st.length) { const p = st.pop(); const x = p%W, y = (p/W)|0;
    if (fg[p]) { n++; x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y); }
    for (const q of [p-1,p+1,p-W,p+W]) if (q>=0&&q<W*H&&dil[q]&&lab[q]<0&&Math.abs((q%W)-x)<=1){lab[q]=boxes.length;st.push(q);} }
  boxes.push({x0,y0,x1,y1,n});
}
const big = boxes.filter(b => b.n > 30).map((b,i)=>({...b,w:b.x1-b.x0+1,h:b.y1-b.y0+1}));
big.sort((a,b)=> (Math.round(a.y0/40)-Math.round(b.y0/40)) || a.x0-b.x0);
big.forEach((b,i)=>console.log(i, JSON.stringify(b)));
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${big.map((b,i)=>`<rect x="${b.x0}" y="${b.y0}" width="${b.w}" height="${b.h}" fill="none" stroke="red"/><text x="${b.x0}" y="${b.y0+12}" font-size="13" fill="blue" font-weight="bold">${i}</text>`).join('')}</svg>`;
await sharp(src).composite([{ input: Buffer.from(svg) }]).png().toFile(out);
