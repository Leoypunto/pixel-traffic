require('dotenv').config();
const puppeteer = require('puppeteer');
const { queries } = require('./db');
const fs = require('fs');

const URL      = process.env.DASHBOARD_URL;
const EMAIL    = process.env.DASHBOARD_EMAIL;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(page) {
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });

  // Clear & type — React needs real keyboard events to update state
  const emailInput = await page.$('input[type="email"]');
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(EMAIL, { delay: 60 });

  const passInput = await page.$('input[type="password"]');
  await passInput.click({ clickCount: 3 });
  await passInput.type(PASSWORD, { delay: 60 });

  await new Promise(r => setTimeout(r, 500));
  await page.click('button[type="submit"]');

  // Wait for redirect away from login page
  await page.waitForFunction(
    () => !window.location.href.includes('/login'),
    { timeout: 15000 }
  ).catch(() => {});

  await new Promise(r => setTimeout(r, 2000));
  console.log('  ✓ Login OK →', page.url());
}

// ─── Navigate to Registro ────────────────────────────────────────────────────
async function goToRegistry(page) {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.innerText.trim().toLowerCase().includes('registro'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 3000));
  console.log('  ✓ En Registro Tráfico →', page.url());
}

// ─── Load all rows (click "Cargar más" until gone) ────────────────────────────
async function loadAllRows(page) {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const loadMore = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.innerText && b.innerText.includes('Cargar más'));
      if (btn) { btn.click(); return btn.innerText.trim(); }
      return null;
    });
    if (!loadMore) break;
    console.log(`  → ${loadMore} (click ${i + 1})`);
    await new Promise(r => setTimeout(r, 2000));
    total++;
  }
  console.log(`  ✓ Paginación completa (${total} clicks)`);
}

// ─── Extract all tasks from the table ────────────────────────────────────────
async function extractTasks(page) {
  return page.evaluate(() => {
    const tasks = [];

    // Helper: get selected value from a <select> or text from an input/div
    const getSelectValue = (cell) => {
      if (!cell) return '';
      const sel = cell.querySelector('select');
      if (sel && sel.value) return sel.value;
      const inp = cell.querySelector('input[type="text"], input:not([type])');
      if (inp && inp.value) return inp.value;
      return '';
    };

    // Helper: get text input value
    const getInputValue = (cell) => {
      if (!cell) return '';
      const inp = cell.querySelector('input[type="text"], input:not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
      if (inp) return inp.value.trim();
      // Fallback to visible text (avoiding option lists)
      const sel = cell.querySelector('select');
      if (sel) return sel.value;
      return '';
    };

    // Helper: get designer tags from ASIGNADO cell
    // Tags look like colored spans/divs with "Diseño - Name ×"
    const getDesignerTags = (cell) => {
      if (!cell) return [];
      // Look for tag elements — they usually have a close button (×) nearby
      const tagContainers = Array.from(cell.querySelectorAll('[class*="tag"], [class*="badge"], [class*="chip"], [class*="label"], [class*="pill"]'));
      if (tagContainers.length > 0) {
        return tagContainers
          .map(el => el.innerText.replace(/×/g, '').replace(/\s+/g, ' ').trim())
          .filter(t => t.length > 2);
      }
      // Fallback: look for colored spans with "×" siblings
      const spans = Array.from(cell.querySelectorAll('span'));
      const tags = [];
      for (const span of spans) {
        const txt = span.innerText.trim();
        if (txt && txt.includes(' - ') && txt.length > 4) {
          tags.push(txt.replace(/×/g, '').trim());
        }
      }
      return tags.length ? tags : [];
    };

    const rows = Array.from(document.querySelectorAll('table tr, tbody tr'));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 6) continue;

      // Column order: ACTIONS(0) CLIENTE(1) ESTADO(2) PRIORIDAD(3) ASIGNADO(4) ASIGNADOX(5) PROYECTO(6) FECHAINICIO(7) FECHAFIN(8) DIAS(9) DIA(10) MES(11) LINKS(12)
      const cliente     = getSelectValue(cells[1]);
      const estado      = getSelectValue(cells[2]);
      const prioridad   = getSelectValue(cells[3]);
      const asignadoX   = getSelectValue(cells[5]);
      // PROYECTO uses a textarea
      const proyecto = (() => {
        const ta = cells[6]?.querySelector('textarea');
        if (ta && ta.value) return ta.value.trim();
        return (cells[6]?.innerText || '').trim();
      })();
      // Dates are rendered as span text content
      const fechaInicio = (cells[7]?.innerText || '').trim().split('\n')[0];
      const fechaFin    = (cells[8]?.innerText || '').trim().split('\n')[0];
      const dia         = getSelectValue(cells[10]);
      const mes         = getSelectValue(cells[11]);

      if (!cliente) continue;

      const asignadoTags = getDesignerTags(cells[4]);
      const asignadoRaw  = asignadoTags.join(' | ') || getSelectValue(cells[4]);

      // Basecamp links — search entire row
      const basecampLinks = Array.from(row.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.includes('basecamp'));

      const extId = btoa(encodeURIComponent(
        [cliente, proyecto || asignadoRaw, fechaInicio].join('|')
      )).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);

      tasks.push({
        external_id:   extId,
        cliente,
        estado,
        prioridad,
        asignado_raw:  asignadoRaw,
        asignado_tags: asignadoTags,
        asignado_x:    asignadoX,
        proyecto,
        fecha_inicio:  fechaInicio,
        fecha_fin:     fechaFin,
        dia,
        mes,
        basecamp_urls: [...new Set(basecampLinks)],
      });
    }

    return tasks;
  });
}

// ─── Main scrape ─────────────────────────────────────────────────────────────
async function scrape() {
  const now = new Date().toISOString();
  console.log(`\n[${now}] 🎮 Iniciando scrape de Pixel Traffic...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });

    await login(page);
    await goToRegistry(page);
    await loadAllRows(page);

    const tasks = await extractTasks(page);
    console.log(`  ✓ ${tasks.length} tareas extraídas`);

    // Debug: save first run
    if (tasks.length > 0) {
      fs.writeFileSync('debug-tasks.json', JSON.stringify(tasks.slice(0, 5), null, 2));
      console.log('  → Muestra guardada en debug-tasks.json');
    }

    // ─── Save to SQLite ───────────────────────────────────────────────────────
    let saved = 0;
    for (const task of tasks) {
      // One task can have multiple designers → create one record per designer
      const designers = task.asignado_tags.length > 0
        ? task.asignado_tags
        : [task.asignado_raw || 'Sin asignar'];

      for (const designerTag of designers) {
        // Extract clean name: "Diseño - Cristian Delgado" → "Cristian Delgado"
        const designerName = designerTag.includes(' - ')
          ? designerTag.split(' - ').slice(1).join(' - ').trim()
          : designerTag.trim();

        // Determine status from "estado"
        const statusMap = {
          'diseño': 'design',
          'creatividad': 'creative',
          'producción': 'production',
          'completado': 'completed',
          'aprobado': 'approved',
          'revisión': 'review',
          'pendiente': 'pending',
        };
        const statusKey = (task.estado || '').toLowerCase();
        const status = Object.entries(statusMap).find(([k]) => statusKey.includes(k))?.[1] || 'active';

        queries.insertTask.run({
          external_id:   `${task.external_id}_${btoa(designerName).substring(0, 8)}`,
          designer_name: designerName,
          title:         task.proyecto || task.cliente,
          status,
          created_by:    task.asignado_x || null,
          assigned_to:   designerName,
          order_date:    task.fecha_inicio || task.dia + '/' + task.mes || null,
          basecamp_url:  task.basecamp_urls[0] || null,
          raw_html:      JSON.stringify({
            cliente:  task.cliente,
            estado:   task.estado,
            prioridad: task.prioridad,
            fecha_fin: task.fecha_fin,
            all_links: task.basecamp_urls,
            designer_tag: designerTag,
          }),
          scraped_at: now,
        });
        saved++;
      }
    }

    console.log(`  ✓ ${saved} registros guardados en SQLite`);

    queries.logSync.run({
      synced_at:   now,
      status:      'ok',
      tasks_found: tasks.length,
      error:       null,
    });

    return { ok: true, tasks_found: tasks.length, saved };

  } catch (err) {
    console.error('  ❌ Error:', err.message);
    queries.logSync.run({
      synced_at:   now,
      status:      'error',
      tasks_found: 0,
      error:       err.message,
    });
    return { ok: false, error: err.message };

  } finally {
    if (browser) await browser.close();
  }
}

// Run directly
if (require.main === module) {
  scrape().then(r => {
    console.log('\n' + (r.ok ? '✅' : '❌'), r);
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { scrape };
