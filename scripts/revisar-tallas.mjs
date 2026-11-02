// Robot de DEALER SPORTS MX: revisa en la página de cada marca qué tallas siguen disponibles
// de lo que vendes sobre pedido (Preventa / Early Access / En camino) y actualiza la tienda.
// - Si una talla se agota en la marca, se quita; si regresa, se vuelve a poner.
// - Si un color se queda sin ninguna talla, se marca "agotado" y la tienda lo esconde.
// Corre solo cada 3 horas en GitHub (ver .github/workflows/revisar-tallas.yml).
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { sincronizar, agregarReporte, modeloGymshark, modeloShopify, corta, rebajasDeLigas } from './sincro.mjs';

const ARCHIVOS = ['datos.json', 'borrador/datos.json'];
const SOBRE_PEDIDO = ['early', 'preventa', 'camino'];
const dormir = ms => new Promise(r => setTimeout(r, ms));
const igual = (a, b) => String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();


// Lee la prenda en la marca UNA sola vez (todos sus colores vienen juntos).
// Si la marca frena por ir muy rápido (429) o falla, espera y vuelve a intentar.
const yaLeidas = new Map();
const noEncontrados = new Set(); // páginas que la marca contestó que ya no existen
async function leerPrenda(origin, handle) {
  const k = origin + '/' + handle;
  if (yaLeidas.has(k)) return yaLeidas.get(k);
  let p = null;
  for (let i = 0; i < 5 && !p; i++) {
    try {
      const r = await fetch(`${origin}/products/${handle}.js`, { headers: { 'User-Agent': 'Mozilla/5.0 (DealerSportsMX tallas)' } });
      if (r.ok) p = await r.json();
      else if (r.status === 404) { noEncontrados.add(`${origin}/${handle}`); break; } // la marca ya no tiene esa prenda
      else await dormir(5000 * (i + 1));
    } catch (e) { await dormir(5000 * (i + 1)); }
  }
  await dormir(1500); // sin prisa, para no molestar a la marca
  yaLeidas.set(k, p);
  return p;
}

// Gymshark: su página no tiene el archivo de la prenda como las demás tiendas, pero la página de cualquier color
// trae dentro (__NEXT_DATA__) todos los colores del modelo con precio, tallas y fotos: se lee UNA vez por modelo.
const modelosGym = new Map(); // liga de cada color → su modelo
async function leerGymshark(link, handle) {
  if (modelosGym.has(handle)) return modelosGym.get(handle);
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0 (DealerSportsMX tallas)' } });
      if (r.status === 404 || (r.redirected && !r.url.includes('/products/'))) { noEncontrados.add(link); modelosGym.set(handle, null); return null; }
      if (!r.ok) { await dormir(5000 * (i + 1)); continue; }
      const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(await r.text()); if (!m) return null;
      const pd = ((JSON.parse(m[1]).props || {}).pageProps || {}).productData; if (!pd) return null;
      const modelo = modeloGymshark(pd);
      modelo.colores.forEach(c => modelosGym.set(c.clave, modelo));
      await dormir(1500);
      if (modelo.colores.some(c => c.clave === handle)) return modelo;
      if (modelo.colores.length) coloresQuitados.add(handle); // la página abrió bien, pero la marca ya no tiene ese color
      return null;
    } catch (e) { await dormir(5000 * (i + 1)); }
  }
  return null;
}
const coloresQuitados = new Set();
async function tallasGymshark(link, handle) {
  const m = await leerGymshark(link, handle), c = m && m.colores.find(x => x.clave === handle);
  if (!m && coloresQuitados.has(handle)) return []; // color que ya no está en la marca: se toma como agotado (se esconde solo)
  return c && c.tallas.length ? c.tallas : null;
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
const reactivados = [];
const INICIO = Date.now();
async function revisarTallas(soloGym) {
for (const f of ARCHIVOS) {
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  let cambio = false;
  for (const p of d.productos || []) {
    if (!SOBRE_PEDIDO.includes(p.estado)) continue;
    if (soloGym && !/gymshark/i.test(p.marca || '')) continue;
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
      if (f === 'datos.json' && (pone.length || (c.agotado && !agotado))) reactivados.push(`${p.marca} · ${quien}: ${c.agotado && !agotado ? 'el color regresó' : 'regresó ' + pone.join(', ')}`);
      c.tallas = nuevo; c.agotado = agotado; cambio = true; total++;
    }
  }
  if (cambio) { d.tallasRevisadas = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(d)); }
}
console.log(total ? `Listo: ${total} cambios.` : 'Sin cambios: todo sigue igual.');
}
await revisarTallas(false);

// Prendas que ya no existen en la página de la marca (todos sus colores contestan "no existe").
// Solo se marcan en no-existen.json para que la tienda las esconda y salgan en Ocultos; el bot NUNCA borra nada.
// Si regresan a la página de la marca, se quitan de la lista solas.
function marcarNoExisten() {
  const NE = 'no-existen.json';
  let antes = {}; try { antes = JSON.parse(fs.readFileSync(NE, 'utf8')); } catch (e) {}
  const d = JSON.parse(fs.readFileSync('datos.json', 'utf8')), ahora = {}; let revisadas = 0;
  const falta = l => { try { const u = new URL(l), h = /\/products\/([^/?#]+)/.exec(u.pathname); return !!h && (noEncontrados.has(l) || noEncontrados.has(`${u.origin}/${h[1]}`)); } catch (e) { return false; } };
  for (const p of d.productos || []) {
    if (!SOBRE_PEDIDO.includes(p.estado)) continue;
    const links = (p.colores || []).map(c => c.link).filter(Boolean); if (!links.length) continue;
    revisadas++;
    if (links.every(falta)) ahora[p.id] = { nombre: p.nombre, marca: p.marca, desde: (antes[p.id] || {}).desde || new Date().toISOString() };
  }
  const n = Object.keys(ahora).length;
  // seguro: si de pronto "desaparece" mucho de un jalón, es más probable una falla de la marca; no se toca nada
  if (n > 5 && n > revisadas * 0.2) { console.log(`· No marqué ${n} de ${revisadas} prendas como desaparecidas: parece una falla de la marca.`); return; }
  if (JSON.stringify(ahora) !== JSON.stringify(antes)) { fs.writeFileSync(NE, JSON.stringify(ahora)); console.log(`Ya no existen en la marca: ${n} prendas.`); }
}
marcarNoExisten();
await revisarCuadritos();
await revisarEspaldas();

// Fecha de lanzamiento de cada prenda en su marca, para que la tienda ordene de la más nueva a la más vieja.
// Se guarda en lanzamientos.json: { "<id de la prenda>": "fecha" }. Solo se lee en la marca lo que aún no tiene fecha o ya se leyó en esta corrida.
// Gymshark no publica esa fecha: la tienda usa la fecha de subida al Catálogo.
async function revisarLanzamientos() {
  const LZ = 'lanzamientos.json';
  let antes = {}; try { antes = JSON.parse(fs.readFileSync(LZ, 'utf8')); } catch (e) {}
  const d = JSON.parse(fs.readFileSync('datos.json', 'utf8')), ahora = {};
  for (const p of d.productos || []) {
    let mejor = '';
    const prendas = new Map();
    for (const c of p.colores || []) { try { const u = new URL(c.link), h = /\/products\/([^/?#]+)/.exec(u.pathname); if (h && !/gymshark/i.test(u.hostname)) prendas.set(`${u.origin}/${h[1]}`, [u.origin, h[1]]); } catch (e) {} }
    for (const [k, [origin, handle]] of prendas) {
      if (antes[p.id] && !yaLeidas.has(k)) continue; // ya tiene fecha: no se molesta a la marca
      let q = yaLeidas.get(k);
      if (q === undefined) {
        try { const r = await fetch(`${origin}/products/${handle}.js`, { headers: { 'User-Agent': 'Mozilla/5.0 (DealerSportsMX fechas)' } }); q = r.ok ? await r.json() : null; } catch (e) { q = null; }
        yaLeidas.set(k, q); await dormir(1000);
      }
      const f = q && Date.parse(q.published_at);
      if (f && (!mejor || f > Date.parse(mejor))) mejor = new Date(f).toISOString().replace('.000Z', 'Z');
    }
    if (mejor || antes[p.id]) ahora[p.id] = mejor || antes[p.id];
  }
  if (JSON.stringify(ahora) !== JSON.stringify(antes)) { fs.writeFileSync(LZ, JSON.stringify(ahora)); console.log(`Fechas de lanzamiento: ${Object.keys(ahora).length} prendas.`); }
}
try { await revisarLanzamientos(); } catch (e) { console.log("· No pude revisar las fechas de lanzamiento: se reintenta en la siguiente corrida."); }

// Sincronía con las marcas: precios y rebajas por color, colores nuevos y fotos que faltaban. Se guarda en sincro.json
// (publicar en el Catálogo no lo borra). Lo que falla la autorevisión no se publica: se queda como estaba y va al reporte.
// Reporte de cada corrida en reporte.json (lo enseña el Catálogo). Si hay errores nuevos, el robot termina en rojo y GitHub te avisa.
let hayErroresNuevos = false;
// Lista de una sección de Gymshark con tus filtros (tal cual la liga): todas sus páginas de 60 prendas, máximo 12
async function leerListaGym(liga) {
  let u; try { u = new URL(liga); } catch (e) { return null; } if (!/gymshark\.com$/.test(u.hostname)) return null;
  const todo = [];
  for (let pg = 0, total = 1; pg < Math.min(total, 12); pg++) {
    if (pg) u.searchParams.set('page', pg);
    let q = null;
    for (let i = 0; i < 4 && !q; i++) {
      try {
        const r = await fetch(u.href, { headers: { 'User-Agent': 'Mozilla/5.0 (DealerSportsMX rebajas)' } });
        if (!r.ok) { await dormir(5000 * (i + 1)); continue; }
        const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(await r.text());
        q = m && (((JSON.parse(m[1]).props || {}).pageProps || {}).ssrQuery || null); if (!q) return pg ? todo : null;
      } catch (e) { await dormir(5000 * (i + 1)); }
    }
    if (!q) return pg ? todo : null;
    total = q.nbPages || 1;
    (q.hits || []).forEach(h => todo.push({ handle: h.handle, title: h.title, colour: h.colour, price: h.price, compareAtPrice: h.compareAtPrice, gender: h.gender, availableSizes: h.availableSizes, media: h.media }));
    await dormir(1500);
  }
  return todo;
}
async function revisarSincro(soloGym) {
  const leerJ = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const previo = leerJ('sincro.json', {}), repAntes = leerJ('reporte.json', {});
  const modelos = new Map();
  const lector = async link => {
    let u; try { u = new URL(link); } catch (e) { return null; }
    const h = (/\/products\/([^/?#]+)/.exec(u.pathname) || [])[1]; if (!h) return null;
    if (/gymshark\.com$/.test(u.hostname)) return leerGymshark(link, h);
    if (soloGym) return null; // revisión de cada hora: lo demás se queda como estaba
    const k = u.origin + '/' + h; if (modelos.has(k)) return modelos.get(k);
    const q = await leerPrenda(u.origin, h), m = q ? modeloShopify(q, u.origin) : null; modelos.set(k, m); return m;
  };
const datos = JSON.parse(fs.readFileSync('datos.json', 'utf8'));
  // ganancia mínima: dólar del día (público) y tu piso por pieza (lo manda el Catálogo; mientras no, piso-rebajas.json)
  let dolar = 0; try { const r = await fetch('https://open.er-api.com/v6/latest/USD'); if (r.ok) dolar = +((await r.json()).rates || {}).MXN || 0; } catch (e) {}
  if (!(dolar > 0)) dolar = +previo.dolar || 0;
  const porPieza = +datos.pisoPieza >= 0 && datos.pisoPieza != null ? +datos.pisoPieza : +(leerJ('piso-rebajas.json', {}).porPieza) || 0;
  const piso = { dolar, porPieza };
  const { sincro, reporte } = await sincronizar({ datos, previo, lector, eventos: { reactivados }, piso });
  if (dolar > 0) sincro.dolar = Math.round(dolar * 100) / 100;
  // las rebajas por liga están apagadas (2026-11-02): tú subes las rebajas a mano en el Catálogo
  if (JSON.stringify(sincro) !== JSON.stringify(previo)) fs.writeFileSync('sincro.json', JSON.stringify(sincro));
  const rep = agregarReporte(repAntes, reporte);
  if (JSON.stringify(rep) !== JSON.stringify(repAntes)) fs.writeFileSync('reporte.json', JSON.stringify(rep));
  const yaAvisados = new Set(((repAntes.corridas || []).find(c => c.errores) || {}).errores || []);
  hayErroresNuevos = (reporte.errores || []).some(e => !yaAvisados.has(e));
  console.log(`Sincronía: ${reporte.agregados.length} colores nuevos, ${reporte.precios.length} precios, ${reporte.entraron.length} a rebajas, ${reporte.salieron.length} salieron, ${reporte.errores.length} errores.`);
  reporte.errores.forEach(e => console.log('✗ ' + e));
}
try { await revisarSincro(); } catch (e) { console.log('· No pude revisar la sincronía: se reintenta en la siguiente corrida. ' + (e && e.message || e)); }

/* Limpieza semanal (nunca borra prendas ni fotos; solo quita datos del robot de prendas que ya no están y te avisa):
   - lanzamientos, cuadritos y fotos de espalda de prendas que ya no están en tu tienda
   - te enlista las prendas que ya no existen en la marca desde hace más de 30 días (para que tú las quites en el Catálogo)
   - te avisa si hay fotos en la tienda que ya no usa ninguna prenda
   - el reporte guarda solo los últimos 30 días */
function limpiezaSemanal() {
  const leerJ = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const rep = leerJ('reporte.json', {});
  if (Date.now() - Date.parse(rep.limpieza || 0) < 7 * 864e5) return;
  const d = leerJ('datos.json', null); if (!d || !(d.productos || []).length) return;
  const ids = new Set(d.productos.map(p => p.id)), handles = new Set(), usadas = new Set();
  d.productos.forEach(p => (p.colores || []).forEach(c => { const h = (/\/products\/([^/?#]+)/.exec(c.link || p.link || '') || [])[1]; if (h) handles.add(h); (c.fotos || []).forEach(f => usadas.add(f)); }));
  JSON.stringify(d.inicio || {}).replace(/fotos\/[A-Za-z0-9_-]+\.\w+/g, f => { usadas.add(f); return f; });
  const quitar = (archivo, guarda) => { const o = leerJ(archivo, null); if (!o) return 0; let n = 0; for (const k of Object.keys(o)) if (!guarda(k)) { delete o[k]; n++; } if (n) fs.writeFileSync(archivo, JSON.stringify(o)); return n; };
  const n1 = quitar('lanzamientos.json', k => ids.has(k)), n2 = quitar('colores.json', k => handles.has(k)), n3 = quitar('fotos-extra.json', k => handles.has(k));
  const ne = leerJ('no-existen.json', {}), viejas = Object.values(ne).filter(x => Date.now() - Date.parse(x.desde) > 30 * 864e5).map(x => `${x.marca} · ${x.nombre}`);
  const sinUsar = fs.existsSync('fotos') ? fs.readdirSync('fotos').filter(f => !usadas.has('fotos/' + f)).length : 0;
  const nota = { fecha: new Date().toISOString(), limpieza: [`Limpieza semanal: quité datos viejos del robot de ${n1 + n2 + n3} prendas que ya no están en tu tienda.`].concat(sinUsar ? [`Hay ${sinUsar} fotos que ya no usa ninguna prenda (se quitan solas la próxima vez que publiques).`] : []), paraQuitar: viejas };
  const nuevo = Object.assign({}, rep, { limpieza: nota.fecha, corridas: [nota, ...(rep.corridas || [])].slice(0, 40) });
  fs.writeFileSync('reporte.json', JSON.stringify(nuevo));
  console.log(nota.limpieza.join(' '), viejas.length ? `Para quitar: ${viejas.length}` : '');
}
try { limpiezaSemanal(); } catch (e) { console.log('· No pude hacer la limpieza semanal: ' + (e && e.message || e)); }

// Solo en GitHub: guarda aquí el trabajo, para no perderlo si publicas desde el Catálogo mientras corre
function guardar() {
  if (!process.env.GITHUB_ACTIONS) return;
  try { execSync('bash scripts/guardar-robot.sh', { stdio: 'inherit' }); }
  catch (e) { console.log('· No se pudo guardar: se reintenta en la siguiente corrida.'); }
}
guardar();
// Rebajas de Gymshark cada hora: el robot corre cada 3 horas, así que se queda y a la hora y a las 2 horas
// vuelve a revisar solo Gymshark (precios, rebajas y tallas). No pasa de 2 h 20 min, antes de que empiece la siguiente corrida.
if (process.env.GITHUB_ACTIONS) for (const min of [60, 120]) {
  const falta = INICIO + min * 60000 - Date.now(); if (falta > 0) await dormir(falta);
  if (Date.now() - INICIO > 140 * 60000) break;
  try { execSync('git pull -q --rebase', { stdio: 'inherit' }); } catch (e) { console.log('· No pude traer lo más nuevo: dejo la revisión de Gymshark para la siguiente corrida.'); break; }
  console.log(`Revisión de Gymshark (minuto ${min})`);
  modelosGym.clear(); noEncontrados.clear(); coloresQuitados.clear(); reactivados.length = 0; total = 0;
  try { await revisarTallas(true); await revisarSincro(true); } catch (e) { console.log('· Falló la revisión de Gymshark: ' + (e && e.message || e)); }
  guardar();
}
if (hayErroresNuevos) process.exitCode = 1;
