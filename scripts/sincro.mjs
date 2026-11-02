// Sincronía con las marcas: compara cada prenda subida con la página de la marca y arma sincro.json y el reporte.
// No lee internet ni archivos (eso lo hace revisar-tallas.mjs): así se puede probar con datos guardados.
// La prenda se identifica por su liga o código de la marca, nunca por el nombre.
const TALLAS = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
const LETRA = /^(XXS|XS|S|M|L|XL|XXL|\dXL)$/;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const marcaDe = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
const esGym = p => marcaDe(p.marca) === 'gymshark';
export const handleDe = l => (/\/products\/([^/?#]+)/.exec(l || '') || [])[1] || '';

export function corta(t) {
  const x = String(t).toLowerCase().trim().replace(/[\s_]+/g, '-');
  const m = { 'xx-small': 'XXS', 'x-small': 'XS', 'xsmall': 'XS', 'small': 'S', 'medium': 'M', 'large': 'L', 'x-large': 'XL', 'xlarge': 'XL',
    'xx-large': '2XL', 'xxlarge': '2XL', 'xxl': '2XL', 'xxx-large': '3XL', 'xxxlarge': '3XL', 'xxxl': '3XL' };
  return m[x] || String(t).trim().toUpperCase();
}

// Rebajas: basta una talla disponible entre XS y XL (y se muestran todas las que haya, también 2XL y 3XL)
export function tallasReb(tallas) {
  if (!tallas.some(x => LETRA.test(x.t))) return true;
  return tallas.some(x => x.ok && ['XS', 'S', 'M', 'L', 'XL'].includes(x.t));
}
// Regla de tallas (Sobre pedido y Preventa): mínimo 3 disponibles entre XS y 2XL (prendas sin tallas de letra no cuentan)
export function tallasOk(tallas) {
  const letras = tallas.filter(x => LETRA.test(x.t));
  if (!letras.length) return true;
  return new Set(letras.filter(x => x.ok && TALLAS.includes(x.t)).map(x => x.t)).size >= 3;
}

// Gymshark: la página de un color trae todos los colores del modelo, con precio, tallas y fotos (productData.variants)
export function modeloGymshark(pd, origen = 'https://www.gymshark.com') {
  const lista = [...(pd.variants || [])];
  if (pd.product && !lista.some(v => v.handle === pd.product.handle)) lista.push(pd.product);
  return { titulo: (pd.product || lista[0] || {}).title || '', colores: lista.filter(v => v && v.handle).map(v => ({
    nombre: String(v.colour || '').trim(), clave: v.handle, link: `${origen}/products/${v.handle}`, usd: +v.price || 0, antes: +v.compareAtPrice || 0,
    tallas: [...new Map((v.availableSizes || []).filter(s => !/default/i.test(s.size)).map(s => [corta(s.size), !!s.inStock]))].map(([t, ok]) => ({ t, ok })),
    fotos: (v.media || []).map(m => m.src).filter(Boolean).slice(0, 4) })) };
}

// Demás marcas (Shopify): un archivo por prenda con todos sus colores; precios en centavos
export function modeloShopify(q, origen) {
  const opts = (q.options || []).map(o => typeof o === 'string' ? o : o.name);
  const ci = opts.findIndex(n => /colou?r/i.test(n)), si = opts.findIndex(n => /size|talla/i.test(n));
  const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const grupos = new Map();
  for (const v of q.variants || []) {
    const nombre = ci >= 0 ? String(v['option' + (ci + 1)] || '').trim() : '';
    if (!grupos.has(nombre)) grupos.set(nombre, { nombre, clave: norm(nombre), link: `${origen}/products/${q.handle}?variant=${v.id}`, usd: 0, antes: 0, m: new Map(), fotos: [], variantes: [] });
    const g = grupos.get(nombre); g.variantes.push(String(v.id));
    g.usd = Math.max(g.usd, (+v.price || 0) / 100); g.antes = Math.max(g.antes, (+v.compare_at_price || 0) / 100);
    if (si >= 0) { const t = corta(v['option' + (si + 1)]); g.m.set(t, g.m.get(t) || !!v.available); }
    else g.m.set('Única', g.m.get('Única') || !!v.available);
    const f = v.featured_image && v.featured_image.src; if (f && !g.fotos.includes(f)) g.fotos.push(f);
  }
  const todos = [...grupos.values()].sort((a, b) => slug(b.nombre).length - slug(a.nombre).length);
  for (const u0 of q.images || []) { // fotos del color por su nombre de archivo ("black-wash" antes que "black")
    const u = String(u0).replace(/^\/\//, 'https://'), a = '-' + slug(u.split('?')[0].split('/').pop().replace(/\.\w+$/, '')) + '-';
    const g = todos.find(x => slug(x.nombre) && a.includes('-' + slug(x.nombre) + '-')); if (g && !g.fotos.includes(u)) g.fotos.push(u);
  }
  return { titulo: q.title || '', colores: [...grupos.values()].map(g => ({ nombre: g.nombre, clave: g.clave, link: g.link, variantes: g.variantes, usd: g.usd, antes: g.antes,
    tallas: [...g.m].map(([t, ok]) => ({ t, ok })), fotos: g.fotos.map(f => String(f).replace(/^\/\//, 'https://').split('?')[0] + '?width=800').slice(0, 4) })) };
}

function redondeador(aj) {
  const r = +(aj || {}).red || 50, m = String((aj || {}).redondeo || '');
  const abajo = x => m === '90' ? Math.max(90, Math.floor((x + 10) / 100) * 100 - 10) : Math.floor(x / r + 1e-9) * r;
  const normal = x => m === '90' ? abajo(x) : /a$/.test(m) ? Math.ceil(x / r - 1e-9) * r : Math.floor(x / r + 0.5 + 1e-9) * r;
  return { normal, abajo };
}

// (sin factor de marca: ver el ancla de precio más abajo)

// Revisa solo lo que cambió de una prenda. Regresa la lista de fallas (vacía = se puede publicar).
function revisar(p, e, previa) {
  const fallas = [], antes = previa || {};
  (e.nuevos || []).filter(n => !(antes.nuevos || []).some(x => x.k === n.k)).forEach(n => {
    if (!n.nombre) fallas.push('color nuevo sin nombre');
    if (!(n.fotos || []).length) fallas.push(`color nuevo ${n.nombre} sin fotos`);
    const ts = Object.keys(n.tallas || {}).map(t => ({ t, ok: true }));
    if (!(tallasOk(ts) || (n.d > 0 && tallasReb(ts)))) fallas.push(`color nuevo ${n.nombre} sin tallas suficientes`);
  });
  const nombres = (p.colores || []).map(c => c.nombre).concat((e.nuevos || []).map(n => n.nombre)).map(norm).filter(Boolean);
  if (new Set(nombres).size !== nombres.length) fallas.push('color repetido');
  const fotos = (p.colores || []).map(c => ((e.fotos || {})[c.k] || c.fotos || [])[0]).concat((e.nuevos || []).map(n => n.fotos[0])).filter(Boolean);
  if (new Set(fotos).size !== fotos.length) fallas.push('dos colores con la misma foto');
  for (const [k, x] of [...Object.entries(e.colores || {}), ...(e.nuevos || []).map(n => [n.k, n])]) {
    const previo = (antes.colores || {})[k];
    if (!(x.n > 0)) fallas.push('precio en cero');
    if (x.d < 0 || x.d > 90) fallas.push(`descuento raro de ${x.d}%`);
    if (previo && previo.n > 0 && (x.n / previo.n > 1.6 || x.n / previo.n < 0.5)) fallas.push(`precio brincó de $${previo.n} a $${x.n} USD`);
    if (!previo && +p.usd > 0 && !k.startsWith('n-')) { const v = x.n / p.usd; if (v > 1.8 || v < 0.5) fallas.push(`precio de la marca no cuadra con el tuyo ($${x.n} USD)`); }
  }
  return [...new Set(fallas)];
}

/* lector(link, nombreColor) → modelo de la marca o null si no se pudo leer. Solo se pide una vez por modelo. */
export async function sincronizar({ datos, previo, lector, eventos = {}, ahora = new Date().toISOString() }) {
  const red = redondeador(datos.ajustes), prendasAntes = (previo && previo.prendas) || {};
/* Precio: tu precio normal (el que publicas desde el Catálogo) se mueve en la misma proporción que el precio de la marca.
     No se guarda ni se publica tu tipo de cambio ni tu margen: solo tus precios finales y los precios públicos de la marca.
     u = precio de la marca (USD) con el que está hecho tu precio b; si el Catálogo lo manda (p.usd) se usa ese. */
  const lecturas = new Map();
  const ps = (datos.productos || []).filter(p => p.estado !== 'disponible');

  for (const p of ps) {
    const ms = [];
    for (const c of p.colores || []) { if (!c.link) continue; const m = await lector(c.link, c.nombre); if (m && !ms.includes(m)) ms.push(m); }
    lecturas.set(p.id, ms);
  }

  const prendas = {}, rep = { agregados: [], precios: [], entraron: [], salieron: [], reactivados: eventos.reactivados || [], errores: [] };
  for (const p of ps) {
    const ms = lecturas.get(p.id), previa = prendasAntes[p.id];
    if (!ms.length) { if (previa) prendas[p.id] = previa; continue; } // no se pudo leer: se queda como estaba
    const lee = buscarColor(p, ms), e = { colores: {}, fotos: {}, nuevos: [] };
    const base = +p.precioBase || 0;
    const conocidas = new Set(), fotosVistas = new Set();
    for (const c of p.colores || []) {
      const r = lee(c);
      if (!r) { const x = previa && (previa.colores || {})[c.k]; if (x) e.colores[c.k] = x; continue; }
      conocidas.add(r);
      e.colores[c.k] = { r, n: Math.max(r.usd, r.antes), d: 0 };
      // color sin fotos o con la foto de otro color: se usan las de la marca
      const f0 = (c.fotos || [])[0];
      const fijas = previa && (previa.fotos || {})[c.k]; // una foto ya corregida se queda corregida
      if (fijas) e.fotos[c.k] = fijas; else if ((!f0 || fotosVistas.has(f0)) && r.fotos.length) e.fotos[c.k] = r.fotos; else if (f0) fotosVistas.add(f0);
    }
    // colores nuevos en la marca (solo Sobre pedido; los que quitaste a mano no regresan)
    const quitados = new Set((p.coloresNo || []).map(norm));
    if (p.estado === 'preventa') for (const m of ms) for (const r of m.colores) {
      if (conocidas.has(r) || !r.nombre || quitados.has(norm(r.nombre)) || (p.colores || []).some(c => norm(c.nombre) === norm(r.nombre)) || e.nuevos.some(n => norm(n.nombre) === norm(r.nombre))) continue;
      const enRebaja = r.antes > r.usd && r.usd > 0;
      if (!r.fotos.length || !r.tallas.some(x => x.ok) || !(tallasOk(r.tallas) || (enRebaja && tallasReb(r.tallas)))) continue;
      const tallas = {}; r.tallas.filter(x => x.ok).forEach(x => { tallas[x.t] = 0; }); // también 2XL y 3XL: la tienda los enseña solo en Rebajas
      e.nuevos.push({ k: 'n-' + norm(r.nombre), nombre: r.nombre, link: r.link, tallas, fotos: r.fotos, agotado: false, r, n: Math.max(r.usd, r.antes), d: 0 });
    }
    // descuentos: cada color el suyo; Gymshark un solo descuento por modelo, el más bajo entre sus colores con alguna talla de XS a XL
    const todos = [...Object.values(e.colores), ...e.nuevos].filter(x => x.r);
    const conRebaja = todos.filter(x => x.r.antes > x.r.usd && x.r.usd > 0);
    const pct = x => Math.round((1 - x.r.usd / x.r.antes) * 1000) / 10;
    if (esGym(p)) {
      const validos = conRebaja.filter(x => tallasReb(x.r.tallas));
      const uno = validos.length ? Math.min(...validos.map(pct)) : 0;
      validos.forEach(x => { x.d = uno; });
    } else conRebaja.forEach(x => { x.d = pct(x); });
    // ancla del precio: la del Catálogo; si no la manda, la de la corrida anterior mientras tu precio no cambie; si cambió, la de hoy
    const leidos = todos.map(x => x.n).filter(n => n > 0);
    if (+p.usd > 0) { e.u = +p.usd; e.b = base; }
    else if (previa && previa.b === base && previa.u > 0) { e.u = previa.u; e.b = base; }
    else if (leidos.length && base) { e.u = Math.max(...leidos); e.b = base; }
    todos.forEach(x => { delete x.r; });
    if (!Object.keys(e.fotos).length) delete e.fotos;
    if (!e.nuevos.length) delete e.nuevos;

    if (JSON.stringify(e) === JSON.stringify(previa)) { prendas[p.id] = previa; continue; } // nada cambió: no se revisa nada más
    const fallas = revisar(p, e, previa);
    if (fallas.length) { rep.errores.push(`${p.marca} · ${p.nombre}: ${fallas.join('; ')}`); if (previa) prendas[p.id] = previa; continue; } // no se publica: se queda como estaba
    prendas[p.id] = e;

    const mx = (n, x) => (x || e).u > 0 && (x || e).b > 0 ? red.normal((x || e).b * n / (x || e).u) : 0, nom = k => ((p.colores || []).find(c => c.k === k) || (e.nuevos || []).find(c => c.k === k) || {}).nombre || '';
    (e.nuevos || []).filter(n => !((previa || {}).nuevos || []).some(x => x.k === n.k)).forEach(n => rep.agregados.push(`${p.marca} · ${p.nombre}: ${n.nombre}`));
    const antesC = Object.assign({}, (previa || {}).colores, Object.fromEntries(((previa || {}).nuevos || []).map(n => [n.k, n])));
    const ahoraC = Object.assign({}, e.colores, Object.fromEntries((e.nuevos || []).map(n => [n.k, n])));
    for (const [k, x] of Object.entries(ahoraC)) {
      const a = antesC[k], antes = a && previa && previa.u ? mx(a.n, previa) : base, hoy = mx(x.n);
      if (!p.precioFijo && hoy && antes && hoy !== antes && !k.startsWith('n-') && (!previa || previa.b === base)) rep.precios.push(`${p.marca} · ${p.nombre} (${nom(k)}): ${'$' + antes} → ${'$' + hoy}`);
      const eraReb = a ? a.d > 0 : false;
      if (x.d > 0 && !eraReb) rep.entraron.push(`${p.marca} · ${p.nombre} (${nom(k)}): ${x.d}%`);
      if (!(x.d > 0) && eraReb) rep.salieron.push(`${p.marca} · ${p.nombre} (${nom(k)})`);
    }
  }
  // misma prenda subida dos veces (misma liga y color, en el mismo tipo de venta)
  const vistos = new Map();
  for (const p of ps) for (const c of p.colores || []) { const h = handleDe(c.link); if (!h) continue; const k = h + '|' + norm(c.nombre), o = vistos.get(k);
    if (o && o !== p.id) rep.duplicadas = [...new Set([...(rep.duplicadas || []), `${p.marca} · ${p.nombre}`])]; else vistos.set(k, p.id); }
  return { sincro: { prendas }, reporte: Object.assign({ fecha: ahora }, rep) };
}

// Busca un color de la tienda en lo que dice la marca: por su liga en Gymshark (cada color tiene la suya), por variante o nombre en las demás
function buscarColor(p, ms) {
  return c => {
    const h = handleDe(c.link);
    for (const m of ms) {
      const r = m.colores.find(x => x.clave === h) || m.colores.find(x => handleDe(x.link) === h && norm(x.nombre) === norm(c.nombre));
      if (r) return r;
    }
    // marcas con una liga por color (DFYNE): la página trae solo ese color, sin nombre
    for (const m of ms) if (m.colores.length === 1 && !m.colores[0].nombre && handleDe(m.colores[0].link) === h) return m.colores[0];
    for (const m of ms) { const v = /[?&]variant=(\d+)/.exec(c.link || ''); const r = v && m.colores.find(x => (x.variantes || []).includes(v[1])); if (r) return r; }
    return null;
  };
}

// Corridas guardadas para el Catálogo: solo las que hicieron algo o encontraron errores
export function agregarReporte(anterior, r, max = 40) {
  const hizo = ['agregados', 'precios', 'entraron', 'salieron', 'reactivados', 'errores', 'duplicadas'].some(k => (r[k] || []).length);
  const lista = (anterior && anterior.corridas) || [];
  return { corridas: hizo ? [r, ...lista].slice(0, max) : lista };
}
