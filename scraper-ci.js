// scraper-ci.js — corre en GitHub Actions, sube datos a Railway via /api/import
require('dotenv').config();
const { execSync } = require('child_process');

const DASHBOARD_URL = process.env.DASHBOARD_URL;
const EMAIL        = process.env.DASHBOARD_EMAIL;
const PASSWORD     = process.env.DASHBOARD_PASSWORD;
const RAILWAY_URL  = process.env.RAILWAY_URL || 'https://pixel-traffic-production.up.railway.app';
const SECRET       = process.env.IMPORT_SECRET || 'import2026';

// Solo estos son diseñadores — filtramos cualquier otro nombre extraído
const DESIGNERS = new Set([
  'Leo Castro','Jonathan Fajardo','Yamileth Batista','Ramiro González',
  'Cristian Delgado','Marcela Sánchez','Miguel Díaz','Luis Wong',
  'Jonathan Barrelier','Ana Turner','Paula Lobo','Eduardo Rolla',
  'Julio Mejía','Arturo Atencio','Jesús Ortega','Aris Alain',
  'Mariel Marengo','Alexander Caballero','Robin De León',
]);

function findChromium() {
  const candidates = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];
  for (const c of candidates) {
    try { return execSync(`which ${c}`, { encoding: 'utf8' }).trim(); } catch {}
  }
  return undefined;
}

async function run() {
  console.log('🎮 Pixel Traffic CI Scraper');
  const { default: puppeteer } = await import('puppeteer');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });

    // Login
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    const emailInput = await page.$('input[type="email"]');
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(EMAIL, { delay: 60 });
    const passInput = await page.$('input[type="password"]');
    await passInput.click({ clickCount: 3 });
    await passInput.type(PASSWORD, { delay: 60 });
    await new Promise(r => setTimeout(r, 500));
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    console.log('✓ Login OK →', page.url());

    // Ir a Registro
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim().toLowerCase().includes('registro'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 3000));

    // Cargar todas las filas
    for (let i = 0; i < 20; i++) {
      const loaded = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.includes('Cargar más'));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!loaded) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    // Extraer tareas
    const tasks = await page.evaluate(() => {
      const statusMap = { 'diseño':'design','creatividad':'creative','producción':'production','completado':'completed','aprobado':'approved','revisión':'review','pendiente':'pending' };
      const getVal = cell => { if (!cell) return ''; const s = cell.querySelector('select'); if (s?.value) return s.value; const i = cell.querySelector('input[type="text"],input:not([type])'); return i?.value || ''; };
      const getTags = cell => {
        if (!cell) return [];
        const tags = Array.from(cell.querySelectorAll('[class*="tag"],[class*="badge"],[class*="chip"],[class*="label"],[class*="pill"]')).map(el => el.innerText.replace(/×/g,'').trim()).filter(t => t.length > 2);
        if (tags.length) return tags;
        return Array.from(cell.querySelectorAll('span')).map(s => s.innerText.trim()).filter(t => t.includes(' - ') && t.length > 4).map(t => t.replace(/×/g,'').trim());
      };
      const result = [];
      for (const row of document.querySelectorAll('table tr, tbody tr')) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 6) continue;
        const cliente = getVal(cells[1]);
        if (!cliente) continue;
        const estado = getVal(cells[2]);
        const proyecto = cells[6]?.querySelector('textarea')?.value?.trim() || cells[6]?.innerText?.trim() || '';
        const fechaInicio = (cells[7]?.innerText || '').trim().split('\n')[0];
        const fechaFin = (cells[8]?.innerText || '').trim().split('\n')[0];
        const asignadoTags = getTags(cells[4]);
        const asignadoRaw = asignadoTags.join(' | ') || getVal(cells[4]);
        const extId = btoa(encodeURIComponent([cliente, proyecto || asignadoRaw, fechaInicio].join('|'))).replace(/[^a-zA-Z0-9]/g,'');
        const basecampUrls = Array.from(row.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.includes('basecamp'));
        const designers = asignadoTags.length ? asignadoTags : [asignadoRaw || 'Sin asignar'];
        for (const tag of designers) {
          const name = tag.includes(' - ') ? tag.split(' - ').slice(1).join(' - ').trim() : tag.trim();
          const sk = (estado || '').toLowerCase();
          const status = Object.entries(statusMap).find(([k]) => sk.includes(k))?.[1] || 'active';
          result.push({
            external_id: extId + '_' + btoa(name).replace(/[^a-zA-Z0-9]/g,''),
            designer_name: name, title: proyecto || cliente, status,
            created_by: getVal(cells[5]) || null, assigned_to: name,
            order_date: fechaInicio || null, basecamp_url: basecampUrls[0] || null,
            raw_html: JSON.stringify({ cliente, estado, prioridad: getVal(cells[3]), fecha_fin: fechaFin, all_links: basecampUrls, designer_tag: tag }),
          });
        }
      }
      return result;
    });

    // Log breakdown por nombre (antes de filtrar)
    const byName = {};
    for (const t of tasks) byName[t.designer_name] = (byName[t.designer_name] || 0) + 1;
    const sorted = Object.entries(byName).sort((a,b) => b[1]-a[1]);
    console.log('── Nombres extraídos del Studio ──');
    for (const [n, c] of sorted) console.log(`  ${c.toString().padStart(3)}  ${n}`);
    console.log('──────────────────────────────────');

    const filtered = tasks.filter(t => DESIGNERS.has(t.designer_name));
    console.log(`✓ ${tasks.length} tareas extraídas → ${filtered.length} de diseñadores conocidos`);

    // Enviar a Railway
    console.log(`→ POST ${RAILWAY_URL}/api/import`);
    const res = await fetch(`${RAILWAY_URL}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, tasks: filtered }),
    });
    const text = await res.text();
    console.log(`← HTTP ${res.status}: ${text.slice(0, 300)}`);
    let json;
    try { json = JSON.parse(text); } catch { console.error('❌ No es JSON válido'); process.exit(1); }
    console.log(`✓ Railway respondió:`, json);

    if (!res.ok) process.exit(1);

  } finally {
    await browser.close();
  }
}

run().catch(err => { console.error('❌', err.message); process.exit(1); });
