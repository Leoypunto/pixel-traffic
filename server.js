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
