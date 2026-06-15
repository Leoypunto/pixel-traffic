require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const cron    = require('node-cron');
const { db, queries } = require('./db');
const { scrape } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 3333;

// ─── Auth ─────────────────────────────────────────────────────────────────────
const ACCESS_KEY   = process.env.ACCESS_KEY   || 'pixeltraffic2026';
const GENERAL_KEY  = process.env.GENERAL_KEY  || 'eljoint2026';
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

function makeToken(payload) {
  const data = JSON.stringify(payload);
  const sig   = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('hex');
  return Buffer.from(data).toString('base64') + '.' + sig;
}

function verifyToken(raw) {
  if (!raw) return null;
  const [b64, sig] = raw.split('.');
  if (!b64 || !sig) return null;
  const data = Buffer.from(b64, 'base64').toString();
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('hex');
  if (sig !== expected) return null;
  try { return JSON.parse(data); } catch { return null; }
}

// Lista de diseñadores para auth de modo designer
const DESIGNERS = [
  'Leo Castro','Jonathan Fajardo','Yamileth Batista','Ramiro González',
  'Cristian Delgado','Marcela Sánchez','Miguel Díaz','Luis Wong',
  'Jonathan Barrelier','Ana Turner','Paula Lobo','Eduardo Rolla',
  'Julio Mejía','Arturo Atencio','Jesús Ortega','Aris Alain',
  'Mariel Marengo','Alexander Caballero','Robin De León',
];

function requireAuth(req, res, next) {
  const raw = req.headers['x-token'] || req.query._t;
  const payload = verifyToken(raw);
  if (payload && payload.mode) { req.authPayload = payload; return next(); }
  res.status(401).json({ error: 'Unauthorized' });
}

// Login endpoint (público, sin auth)
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth', express.json(), (req, res) => {
  const { password, mode, designer } = req.body || {};

  if (mode === 'admin' && password === ACCESS_KEY) {
    return res.json({ ok: true, token: makeToken({ mode: 'admin' }), mode: 'admin' });
  }
  if (mode === 'general' && password === GENERAL_KEY) {
    return res.json({ ok: true, token: makeToken({ mode: 'general' }), mode: 'general' });
  }
  if (mode === 'designer' && designer) {
    const match = DESIGNERS.find(d => d.toLowerCase() === designer.toLowerCase());
    if (match) {
      // password = primer nombre del diseñador en minúsculas
      const expectedPw = match.split(' ')[0].toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, ''); // sin tildes
      const givenPw = (password || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (givenPw === expectedPw) {
        return res.json({ ok: true, token: makeToken({ mode: 'designer', designer: match }), mode: 'designer', designer: match });
      }
    }
  }
  res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
});

// Todas las rutas /api/* requieren token, excepto /api/auth
app.use('/api', (req, res, next) => {
  if (req.path === '/auth' && req.method === 'POST') return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Ruta para limpiar SW y caché del browser — visitar una vez para forzar actualización
app.get('/clear-cache', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clearing cache...</title></head><body>
<script>
(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const r of regs) await r.unregister();
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  window.location.replace('/');
})();
</script>
<p style="font-family:monospace;padding:20px">Limpiando caché... redirigiendo</p>
</body></html>`);
});

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

// ─── API: Heatmap ──────────────────────────────────────────────────────
app.get('/api/metrics/heatmap', (req, res) => {
  const allTasks = db.prepare('SELECT * FROM tasks').all();
  const designers = db.prepare('SELECT * FROM designers WHERE active = 1').all();

  // Últimos 14 días con datos
  const today = new Date();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0,10));
  }

  const matrix = {};
  designers.forEach(d => {
    matrix[d.name] = {};
    days.forEach(day => {
      matrix[d.name][day] = allTasks.filter(t => {
        if (t.designer_name !== d.name) return false;
        if (t.status === 'completed' || t.status === 'archived') return false;
        const start = t.order_date || '';
        let extra = {};
        try { extra = JSON.parse(t.raw_html || '{}'); } catch(e) {}
        const end = extra.fecha_fin || '';
        if (!start && !end) return true;
        if (start && end)  return start <= day && day <= end;
        if (start && !end) return start <= day;
        return false;
      }).length;
    });
  });

  res.json({ designers: designers.map(d => ({ name: d.name, color: d.color })), days, matrix });
});

// ─── API: Vencidas ────────────────────────────────────────────────────
app.get('/api/metrics/vencidas', (req, res) => {
  const today = todayStr();
  const allTasks = db.prepare('SELECT * FROM tasks WHERE status != ? AND status != ?').all('completed','archived');

  const vencidas = allTasks
    .map(t => {
      let extra = {};
      try { extra = JSON.parse(t.raw_html || '{}'); } catch(e) {}
      const fin = extra.fecha_fin || '';
      if (!fin || fin >= today) return null;
      const daysOver = Math.round((new Date(today) - new Date(fin)) / 86400000);
      return { designer_name: t.designer_name, title: t.title, fecha_fin: fin, days_overdue: daysOver, cliente: extra.cliente || '' };
    })
    .filter(Boolean)
    .sort((a,b) => b.days_overdue - a.days_overdue);

  res.json({ count: vencidas.length, tasks: vencidas.slice(0, 20) });
});

// ─── API: Throughput ──────────────────────────────────────────────────
app.get('/api/metrics/throughput', (req, res) => {
  const completed = db.prepare("SELECT * FROM tasks WHERE status = 'completed'").all();
  const designers = db.prepare('SELECT * FROM designers WHERE active = 1').all();

  // Semanas (últimas 6)
  const now = new Date();
  const weekly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay()+6)%7)); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate()+6);
    const wStr = mon.toISOString().slice(0,10);
    const wEnd = sun.toISOString().slice(0,10);
    const label = `${String(mon.getDate()).padStart(2,'0')}/${String(mon.getMonth()+1).padStart(2,'0')}`;
    const count = completed.filter(t => t.order_date >= wStr && t.order_date <= wEnd).length;
    weekly.push({ week: label, completed: count });
  }

  // Avg por semana — usando rango de fechas de las tareas (no días de scraper)
  // El rango cubre desde la tarea completada más antigua hasta hoy
  const dateRange = db.prepare("SELECT MIN(order_date) as min_d, MAX(order_date) as max_d FROM tasks WHERE status='completed' AND order_date LIKE '2026-%'").get();
  const minDate = dateRange?.min_d ? new Date(dateRange.min_d) : new Date();
  const weeksRange = Math.max(1, Math.round((Date.now() - minDate) / (7 * 86400000)));
  const avgPerWeek = +(completed.length / weeksRange).toFixed(1);
  // También calcular avg/día útil de esta semana vs la anterior
  const prevWeekStart = new Date(now); prevWeekStart.setDate(prevWeekStart.getDate() - ((prevWeekStart.getDay()+6)%7) - 7); prevWeekStart.setHours(0,0,0,0);
  const prevWeekEnd   = new Date(prevWeekStart); prevWeekEnd.setDate(prevWeekStart.getDate()+6);
  const prevWeekStr   = prevWeekStart.toISOString().slice(0,10);
  const prevWeekEndStr= prevWeekEnd.toISOString().slice(0,10);
  const prevWeekCount = completed.filter(t => t.order_date >= prevWeekStr && t.order_date <= prevWeekEndStr).length;

  // Scoreboard esta semana
  const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay()+6)%7)); mon.setHours(0,0,0,0);
  const weekStart = mon.toISOString().slice(0,10);
  const scores = designers.map(d => ({
    name: d.name,
    count: completed.filter(t => t.designer_name === d.name && t.order_date >= weekStart).length
  })).filter(s => s.count > 0).sort((a,b) => b.count - a.count);

  res.json({ weekly, avg_per_week: avgPerWeek, avg_per_day: +(avgPerWeek/7).toFixed(1), prev_week: prevWeekCount, best_designer: scores[0] || null, scoreboard: scores });
});

// ─── API: Rebotes ──────────────────────────────────────────────────────
app.get('/api/metrics/rebotes', (req, res) => {
  const allTasks = db.prepare('SELECT * FROM tasks WHERE status != ? AND status != ?').all('completed','archived');

  const reboteEstados = ['cambios en diseño','cambios en creatividad','cambios en edición'];
  const clienteMap = {};
  const totalMap = {};

  allTasks.forEach(t => {
    let extra = {};
    try { extra = JSON.parse(t.raw_html || '{}'); } catch(e) {}
    const cliente = extra.cliente || '';
    const estado = (extra.estado || '').toLowerCase();
    if (!cliente) return;
    totalMap[cliente] = (totalMap[cliente] || 0) + 1;
    if (reboteEstados.includes(estado)) clienteMap[cliente] = (clienteMap[cliente] || 0) + 1;
  });

  const result = Object.entries(clienteMap)
    .map(([cliente, cambios]) => ({
      cliente,
      cambios,
      total: totalMap[cliente] || 0,
      pct: Math.round((cambios / (totalMap[cliente] || 1)) * 100)
    }))
    .sort((a,b) => b.cambios - a.cambios)
    .slice(0,8);

  res.json(result);
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
