require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { db, queries } = require('./db');
const { scrape } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Helper: today as YYYY-MM-DD ─────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Helper: filter tasks for a given date ───────────────────────────────────
// Reglas:
//   - start y end presentes → mostrar solo si start <= dateStr <= end
//   - solo start (sin end)  → mostrar solo en esa fecha exacta
//   - solo end (sin start)  → mostrar solo en esa fecha exacta
//   - sin fechas            → mostrar siempre (tarea sin fecha)
function isTaskForDate(task, dateStr) {
  const extra = (() => { try { return JSON.parse(task.raw_html || '{}'); } catch(e) { return {}; } })();
  const clean = v => (!v || v.startsWith('Select') || v.length > 20) ? '' : v.trim();
  const start = clean(extra.fecha_inicio || task.order_date || '');
  const end   = clean(extra.fecha_fin || '');

  if (!start && !end) return true;                              // sin fechas → siempre
  if (start && end)   return start <= dateStr && dateStr <= end; // rango
  if (start && !end)  return start === dateStr;                  // fecha exacta de inicio
  if (!start && end)  return end   === dateStr;                  // fecha exacta de fin
  return false;
}

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const allTime  = req.query.all === 'true';
  const dateStr  = req.query.date || todayStr();
  const allTasks = db.prepare('SELECT * FROM tasks').all();

  const filtered   = allTime ? allTasks : allTasks.filter(t => isTaskForDate(t, dateStr));
  const activeCount = filtered.filter(t => t.status !== 'completed' && t.status !== 'archived').length;
  const doneCount   = filtered.filter(t => t.status === 'completed').length;

  const lastSync = queries.getLastSync.get();
  res.json({
    total_designers: queries.getStats.get().total_designers,
    active_tasks:    activeCount,
    completed_tasks: doneCount,
    total_tasks:     filtered.length,
    last_sync:       lastSync,
    date:            dateStr,
    all_time:        allTime,
  });
});

// ─── API: Designers with tasks (date-filtered or all-time) ───────────────────
app.get('/api/designers', (req, res) => {
  const allTime = req.query.all === 'true';
  const dateStr = req.query.date || todayStr();
  const designers = queries.getAllDesigners.all();

  const result = designers.map(designer => {
    const rawTasks = queries.getTasksByDesigner.all(designer.name);

    const enriched = rawTasks.map(t => {
      let extra = {};
      try { extra = JSON.parse(t.raw_html || '{}'); } catch (e) {}
      return { ...t, ...extra, raw_html: undefined };
    });

    const filtered  = allTime ? enriched : enriched.filter(t => isTaskForDate(t, dateStr));
    const active    = filtered.filter(t => t.status !== 'completed' && t.status !== 'archived');
    const completed = filtered.filter(t => t.status === 'completed');

    return {
      ...designer,
      tasks:           filtered,
      active_tasks:    active,
      completed_tasks: completed,
      active_count:    active.length,
      completed_count: completed.length,
    };
  });

  res.json(result);
});

// ─── API: All tasks (with filters) ───────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  const { designer, status, cliente, date } = req.query;
  const filterDate = date || todayStr();

  let tasks = queries.getAllTasks.all();

  let enriched = tasks
    .filter(t => isTaskForDate(t, filterDate))
    .map(t => {
      let extra = {};
      try { extra = JSON.parse(t.raw_html || '{}'); } catch (e) {}
      return { ...t, ...extra, raw_html: undefined };
    });

  if (designer) enriched = enriched.filter(t => t.designer_name === designer);
  if (status)   enriched = enriched.filter(t => t.status === status);
  if (cliente)  enriched = enriched.filter(t => (t.cliente || '').toLowerCase().includes(cliente.toLowerCase()));

  res.json(enriched);
});

// ─── API: Metrics ────────────────────────────────────────────────────────────
app.get('/api/metrics', (req, res) => {
  const period  = req.query.period || 'all'; // 'day' | 'week' | 'month' | 'all'
  const allTasks    = db.prepare('SELECT * FROM tasks').all();
  const designers   = db.prepare('SELECT * FROM designers WHERE active=1').all();

  // Rango de fechas para el período
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  let periodStart = null;
  if (period === 'day') {
    periodStart = today;
  } else if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // lunes
    periodStart = d.toISOString().slice(0, 10);
  } else if (period === 'month') {
    periodStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  }

  // Enrich tasks with raw_html fields
  const tasks = allTasks.map(t => {
    let extra = {};
    try { extra = JSON.parse(t.raw_html || '{}'); } catch(e) {}
    const clean = v => (!v || v.startsWith('Select') || v.length > 20) ? '' : v.trim();
    return {
      ...t,
      estado:       extra.estado      || '',
      cliente:      extra.cliente     || '',
      fecha_inicio: clean(extra.fecha_inicio || t.order_date || ''),
      fecha_fin:    clean(extra.fecha_fin    || ''),
    };
  });

  // Filtro de período sobre tareas
  function inPeriod(t) {
    if (!periodStart) return true;
    const s = t.fecha_inicio, e = t.fecha_fin;
    if (!s && !e) return true; // sin fecha → siempre
    if (s && e)  return s <= today && e >= periodStart;
    if (s)       return s >= periodStart && s <= today;
    if (e)       return e >= periodStart && e <= today;
    return false;
  }

  // ── 1. Ranking de carga actual ─────────────────────────────────────────────
  const ranking = designers.map(d => {
    const dtasks = tasks.filter(t =>
      t.designer_name === d.name &&
      t.status !== 'completed' && t.status !== 'archived' &&
      inPeriod(t)
    );
    return { name: d.name, color: d.color, count: dtasks.length };
  }).sort((a, b) => b.count - a.count);

  // ── 2. Historial semanal — últimas 8 semanas ─────────────────────────────
  const weeks = [];
  const nowW = new Date();
  for (let i = 7; i >= 0; i--) {
    const d = new Date(nowW);
    d.setDate(d.getDate() - i * 7);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // lunes
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    const label = `${String(monday.getDate()).padStart(2,'0')}/${String(monday.getMonth()+1).padStart(2,'0')}`;

    const wStr  = monday.toISOString().slice(0, 10);
    const wEnd  = sunday.toISOString().slice(0, 10);

    // tasks active during this week
    const count = tasks.filter(t => {
      const s = t.fecha_inicio, e = t.fecha_fin;
      if (!s && !e) return false;
      if (s && e)  return s <= wEnd && e >= wStr;
      if (s)       return s >= wStr && s <= wEnd;
      if (e)       return e >= wStr && e <= wEnd;
      return false;
    }).length;

    weeks.push({ label, start: wStr, end: wEnd, count });
  }

  // ── 3. Distribución de estados ────────────────────────────────────────────
  const estadoMap = {};
  tasks.filter(t => t.status !== 'completed' && t.estado && inPeriod(t)).forEach(t => {
    estadoMap[t.estado] = (estadoMap[t.estado] || 0) + 1;
  });
  const estados = Object.entries(estadoMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // ── 4. Top clientes ───────────────────────────────────────────────────────
  const clienteMap = {};
  tasks.filter(t => t.status !== 'completed' && t.cliente && inPeriod(t)).forEach(t => {
    clienteMap[t.cliente] = (clienteMap[t.cliente] || 0) + 1;
  });
  const clientes = Object.entries(clienteMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  res.json({ ranking, weeks, estados, clientes });
});

// ─── API: Update designer skills ─────────────────────────────────────────────
app.put('/api/designers/:name/skills', express.json(), (req, res) => {
  const { name } = req.params;
  const { arte, ejecucion, animacion, velocidad, nivel, star_rating } = req.body;

  const designer = db.prepare('SELECT * FROM designers WHERE name = ?').get(decodeURIComponent(name));
  if (!designer) return res.status(404).json({ error: 'Designer not found' });

  let existing = {};
  try { existing = JSON.parse(designer.skills || '{}'); } catch(e) {}

  const promedio = +(arte * 0.4 + ejecucion * 0.2 + animacion * 0.2 + velocidad * 0.2).toFixed(1);

  const updated = {
    ...existing,
    arte:       Number(arte),
    ejecucion:  Number(ejecucion),
    animacion:  Number(animacion),
    velocidad:  Number(velocidad),
    nivel:      nivel || existing.nivel || 'Mid',
    star_rating: Number(star_rating),
    promedio,
  };

  db.prepare('UPDATE designers SET skills = ? WHERE name = ?').run(JSON.stringify(updated), designer.name);
  res.json({ ok: true, skills: updated });
});

// ─── API: Manual refresh ─────────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  res.json({ ok: true, message: 'Scrape iniciado en background' });
  scrape().then(r => console.log('[Refresh]', r));
});

// ─── Cron: auto-refresh every 15 min, Mon-Fri 8am-6pm ───────────────────────
cron.schedule('*/15 8-18 * * 1-5', () => {
  console.log('[Cron] Auto-refresh...');
  scrape().then(r => console.log('[Cron]', r));
});

app.listen(PORT, () => {
  console.log(`🎮 Pixel Traffic → http://localhost:${PORT}`);
  const stats = queries.getStats.get();
  console.log(`📊 ${stats.total_designers} diseñadores, ${stats.total_tasks} tareas en DB`);
});
