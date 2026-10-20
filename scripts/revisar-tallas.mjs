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

// Pregunta a la marca (tiendas Shopify: YoungLA, Gymshark, Darc Sport…) qué tallas tiene de un color.
// Regresa [{t, ok}] o null si no se pudo leer.
async function tallasDeLink(link, color) {
  let u; try { u = new URL(link); } catch (e) { return null; }
  const h = /\/products\/([^/?#]+)/.exec(u.pathname);
  if (!h) return null;
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
