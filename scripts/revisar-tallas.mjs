// Robot de DEALER SPORTS MX: revisa en la página de cada marca qué tallas siguen disponibles
// de lo que vendes sobre pedido (Preventa / Early Access / En camino) y actualiza la tienda.
// - Si una talla se agota en la marca, se quita; si regresa, se vuelve a poner.
// - Si un color se queda sin ninguna talla, se marca "agotado" y la tienda lo esconde.
// Corre solo cada 3 horas en GitHub (ver .github/workflows/revisar-tallas.yml).
import fs from 'node:fs';

const ARCHIVOS = ['datos.json', 'borrador/datos.json'];
const SOBRE_PEDIDO = ['early', 'preventa', 'camino'];
const dormir = ms => new Promise(r => setTimeout(r, ms));
const igual = (a, b) => String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();

// "Small" → "S", "XLarge" → "XL"… (igual que la extensión)
function corta(t) {
  const x = String(t).toLowerCase().trim().replace(/[\s_]+/g, '-');
  const m = { 'xx-small': 'XXS', 'x-small': 'XS', 'xsmall': 'XS', 'small': 'S', 'medium': 'M', 'large': 'L', 'x-large': 'XL', 'xlarge': 'XL',
    'xx-large': '2XL', 'xxlarge': '2XL', 'xxl': '2XL', 'xxx-large': '3XL', 'xxxlarge': '3XL', 'xxxl': '3XL' };
  return m[x] || String(t).trim().toUpperCase();
}

// Lee la prenda en la marca UNA sola vez (todos sus colores vienen juntos).
// Si la marca frena por ir muy rápido (429) o falla, espera y vuelve a intentar.
const yaLeidas = new Map();
async function leerPrenda(origin, handle) {
  const k = origin + '/' + handle;
  if (yaLeidas.has(k)) return yaLeidas.get(k);
  let p = null;
  for (let i = 0; i < 5 && !p; i++) {
    try {
      const r = await fetch(`${origin}/products/${handle}.js`, { headers: { 'User-Agent': 'Mozilla/5.0 (DealerSportsMX tallas)' } });
      if (r.ok) p = await r.json();
      else if (r.status === 404) break; // la marca ya no tiene esa prenda
      else await dormir(5000 * (i + 1));
    } catch (e) { await dormir(5000 * (i + 1)); }
  }
  await dormir(1500); // sin prisa, para no molestar a la marca
  yaLeidas.set(k, p);
  return p;
}

// Gymshark: su página no tiene el archivo de la prenda como las demás tiendas, pero la página de cada color
// trae sus tallas dentro (__NEXT_DATA__). Cada color de Gymshark es una prenda aparte, así que basta su link.
async function tallasGymshark(link, handle) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0 (DealerSportsMX tallas)' } });
      if (r.status === 404) return null;
      if (!r.ok) { await dormir(5000 * (i + 1)); continue; }
      const html = await r.text();
      const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html); if (!m) return null;
      let prenda = null;
      (function walk(o) { if (prenda || !o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk);
        if (o.handle === handle && Array.isArray(o.availableSizes)) { prenda = o; return; } Object.values(o).forEach(walk); })(JSON.parse(m[1]));
      await dormir(1500);
      if (!prenda) return null;
      const t = new Map(); prenda.availableSizes.forEach(s => { if (/default/i.test(s.size)) return; const k = corta(s.size); t.set(k, t.get(k) || !!s.inStock); });
      return t.size ? [...t].map(([t, ok]) => ({ t, ok })) : null;
    } catch (e) { await dormir(5000 * (i + 1)); }
  }
  return null;
}

// Pregunta a la marca (tiendas Shopify: YoungLA, Gymshark, Darc Sport…) qué tallas tiene de un color.
// Regresa [{t, ok}] o null si no se pudo leer.
async function tallasDeLink(link, color) {
  let u; try { u = new URL(link); } catch (e) { return null; }
  const h = /\/products\/([^/?#]+)/.exec(u.pathname);
  if (!h) return null;
  if (/gymshark\.com$/.test(u.hostname)) return tallasGymshark(link, h[1]);
  try {
    const p = await leerPrenda(u.origin, h[1]);
    if (!p) return null;
    const opts = (p.options || []).map(o => typeof o === 'string' ? o : o.name);
    const ci = opts.findIndex(n => /colou?r/i.test(n)), si = opts.findIndex(n => /size|talla/i.test(n));
    if (si < 0) return null;
    let col = color;
    const vid = u.searchParams.get('variant');
    if (ci >= 0 && !(p.variants || []).some(v => igual(v['option' + (ci + 1)], col))) {
      const v = (p.variants || []).find(x => String(x.id) === vid); col = v ? v['option' + (ci + 1)] : col;
    }
    const m = new Map();
    (p.variants || []).filter(v => ci < 0 || !col || igual(v['option' + (ci + 1)], col))
      .forEach(v => { const t = corta(v['option' + (si + 1)]); if (t) m.set(t, m.get(t) || !!v.available); });
    return m.size ? [...m].map(([t, ok]) => ({ t, ok })) : null;
  } catch (e) { return null; }
}

// Cuadritos de color de YoungLA: las mismas imágenes que muestra su página para cada color
// (color liso, pedazo de tela o acercamiento al diseño). Se guardan en colores.json:
// { "<handle de la prenda>": { "<color en minúsculas>": "https://…png" o "lightgrey" } }.
// Solo se lee la página de las prendas que todavía no tienen sus cuadritos.
const COLORES_JSON = 'colores.json';
async function cuadritosYoungLA(handle) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://www.youngla.com/products/${handle}`, { headers: { 'User-Agent': 'Mozilla/5.0 (DealerSportsMX colores)' } });
      if (r.status === 404) return null;
      if (!r.ok) { await dormir(5000 * (i + 1)); continue; }
      const html = await r.text(), o = {};
      for (const m of html.matchAll(/<label[^>]*class="[^"]*color-swatch[^"]*"[^>]*>/g)) {
        const s = m[0].replace(/&amp;/g, '&'), n = (/data-tooltip="([^"]+)"/.exec(s) || [])[1];
        if (!n || o[n.toLowerCase().trim()]) continue;
        const img = (/background-image:\s*url\(([^)]+)\)/.exec(s) || [])[1], col = (/background-color:\s*([^;"]+)/.exec(s) || [])[1];
        if (img) o[n.toLowerCase().trim()] = img.replace(/^\/\//, 'https://').replace(/width=\d+/, 'width=96');
        else if (col) o[n.toLowerCase().trim()] = col.trim();
      }
      await dormir(1500);
      return o;
    } catch (e) { await dormir(5000 * (i + 1)); }
  }
  return null;
}
async function revisarCuadritos() {
  let mapa = {}; try { mapa = JSON.parse(fs.readFileSync(COLORES_JSON, 'utf8')); } catch (e) {}
  const pendientes = new Set();
  for (const f of ARCHIVOS) {
    if (!fs.existsSync(f)) continue;
    for (const p of JSON.parse(fs.readFileSync(f, 'utf8')).productos || []) for (const c of p.colores || []) {
      const m = /youngla\.com\/(?:[a-z-]+\/)?products\/([^/?#]+)/i.exec(c.link || p.link || '');
      const x = m && mapa[m[1]], semana = x && Date.now() - Date.parse(x._revisado || 0) < 7 * 864e5; // si un color no sale en su página, se vuelve a ver en una semana
      if (m && c.nombre && !(x && x[String(c.nombre).toLowerCase().trim()]) && !semana) pendientes.add(m[1]);
    }
  }
  let nuevos = 0;
  for (const h of pendientes) {
    const o = await cuadritosYoungLA(h);
    if (o && Object.keys(o).length) { mapa[h] = Object.assign(mapa[h] || {}, o, { _revisado: new Date().toISOString() }); nuevos++; console.log(`✓ cuadritos de ${h}: ${Object.keys(o).join(', ')}`); }
  }
  if (nuevos) fs.writeFileSync(COLORES_JSON, JSON.stringify(mapa));
  console.log(nuevos ? `Cuadritos nuevos de ${nuevos} prendas.` : 'Cuadritos: nada nuevo.');
}

// Fotos de espalda de YoungLA: a cada color que en la tienda tiene una sola foto se le buscan en youngla.com
// más fotos: primero las de modelo de ese color (llevan el color y "ecomm" en el nombre, ej. 5128_red-wash_003_johnny_ecomm.jpg);
// si no hay, sus acercamientos y las fotos generales de la prenda, para que todos cambien con la flechita.
// Se guardan en fotos-extra.json: { "<handle>": { "<color en minúsculas>": ["https://cdn.shopify.com/…", …] } }.
const FOTOS_EXTRA_JSON = 'fotos-extra.json';
const aSlug = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const archivoDe = u => String(u || '').split('?')[0].split('/').pop();
async function revisarEspaldas() {
  let mapa = {}; try { mapa = JSON.parse(fs.readFileSync(FOTOS_EXTRA_JSON, 'utf8')); } catch (e) {}
  let nuevos = 0; // (cada prenda ya se leyó al revisar tallas, así que esto casi no hace llamadas nuevas)
  for (const f of ARCHIVOS) {
    if (!fs.existsSync(f)) continue;
    for (const p of JSON.parse(fs.readFileSync(f, 'utf8')).productos || []) {
      if (!/youngla/i.test(p.marca || '') || p.estado === 'disponible') continue;
      for (const c of p.colores || []) {
        if ((c.fotos || []).length !== 1 || !c.nombre) continue;
        const m = /youngla\.com\/(?:[a-z-]+\/)?products\/([^/?#]+)/i.exec(c.link || p.link || ''); if (!m) continue;
        const h = m[1], k = String(c.nombre).toLowerCase().trim();
        if ((mapa[h] || {})[k]) continue; // ya las tiene
        const q = await leerPrenda('https://www.youngla.com', h); if (!q) continue;
        const opts = (q.options || []).map(o => typeof o === 'string' ? o : o.name), ci = opts.findIndex(n => /colou?r/i.test(n)); if (ci < 0) continue;
        const nombres = [...new Set((q.variants || []).map(v => v['option' + (ci + 1)]))];
        const nm = nombres.find(n => aSlug(n) === aSlug(c.nombre)); if (!nm) continue;
        const slugs = nombres.map(n => ({ n, s: aSlug(n) })).filter(x => x.s).sort((a, b) => b.s.length - a.s.length); // "black-wash" antes que "black"
        // fotos principales de cada color (las que ya tiene la tienda): no se repiten
        const principales = new Set((q.variants || []).filter(v => v.featured_image).map(v => archivoDe(v.featured_image.src)));
        // 1) su color con modelo (espalda / de lado), 2) si no hay, sus acercamientos y luego las generales de la prenda:
        // así todos los colores cambian de foto con la flechita, aunque no sea la espalda
        const modelo = [], cerca = [], general = [];
        for (const u0 of q.images || []) {
          const u = String(u0).replace(/^\/\//, 'https://'), a0 = archivoDe(u);
          if (principales.has(a0) || /size|chart|guide/i.test(a0)) continue;
          const a = '-' + aSlug(a0.replace(/\.\w+$/, '')) + '-', x = slugs.find(x => a.includes('-' + x.s + '-'));
          if (x && x.n === nm) (/_ecomm/i.test(a0) ? modelo : cerca).push(u);
          else if (!x) general.push(u);
        }
        const extra = (modelo.length ? modelo : cerca.concat(general)).slice(0, 3).map(u => u.split('?')[0] + '?width=800');
        if (extra.length) { mapa[h] = Object.assign(mapa[h] || {}, { [k]: extra }); nuevos++; console.log(`✓ fotos de espalda de ${p.nombre} (${c.nombre}): ${extra.length}`); }
      }
    }
  }
  if (nuevos) fs.writeFileSync(FOTOS_EXTRA_JSON, JSON.stringify(mapa));
  console.log(nuevos ? `Fotos de espalda nuevas: ${nuevos} colores.` : 'Fotos de espalda: nada nuevo.');
}

let total = 0;
for (const f of ARCHIVOS) {
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  let cambio = false;
  for (const p of d.productos || []) {
    if (!SOBRE_PEDIDO.includes(p.estado)) continue;
    for (const c of p.colores || []) {
      if (!c.link) continue;
      const quien = `${p.nombre}${c.nombre ? ' (' + c.nombre + ')' : ''}`;
      const t = await tallasDeLink(c.link, c.nombre);
      if (!t) { console.log(`· ${f} · ${quien}: no pude leer la página de la marca`); continue; }
      const hay = t.filter(x => x.ok).map(x => x.t);
      const antes = Object.keys(c.tallas || {});
      const nuevo = {}; hay.forEach(x => { nuevo[x] = (c.tallas || {})[x] || 0; });
      const agotado = !hay.length;
      const mismas = antes.length === hay.length && antes.every(x => hay.includes(x));
      if (mismas && !!c.agotado === agotado) continue;
      const quita = antes.filter(x => !hay.includes(x)), pone = hay.filter(x => !antes.includes(x));
      console.log(`✓ ${f} · ${quien}: ` + [pone.length ? 'regresó ' + pone.join(', ') : '', quita.length ? 'se agotó ' + quita.join(', ') : '', agotado ? 'COLOR AGOTADO (se esconde)' : (c.agotado ? 'el color regresó' : '')].filter(Boolean).join(' · '));
      c.tallas = nuevo; c.agotado = agotado; cambio = true; total++;
    }
  }
  if (cambio) { d.tallasRevisadas = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(d)); }
}
console.log(total ? `Listo: ${total} cambios.` : 'Sin cambios: todo sigue igual.');
await revisarCuadritos();
await revisarEspaldas();
