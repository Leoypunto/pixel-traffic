const Database = require('better-sqlite3');
const path = require('path');

// DB_PATH: configurable vía env para Railway volumes (/data/traffic.db)
// Crea el directorio si no existe
const DB_DIR  = process.env.DB_DIR ? path.resolve(process.env.DB_DIR) : __dirname;
const DB_PATH = path.join(DB_DIR, 'traffic.db');
require('fs').mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

// Enable WAL for better performance
db.pragma('journal_mode = WAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS designers (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    color     TEXT NOT NULL DEFAULT '#4ECDC4',
    active    INTEGER NOT NULL DEFAULT 1,
    skills    TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id     TEXT,
    designer_name   TEXT NOT NULL,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_by      TEXT,
    assigned_to     TEXT,
    order_date      TEXT,
    basecamp_url    TEXT,
    raw_html        TEXT,
    scraped_at      TEXT NOT NULL,
    UNIQUE(external_id)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at   TEXT NOT NULL,
    status      TEXT NOT NULL,
    tasks_found INTEGER DEFAULT 0,
    error       TEXT
  );
`);

// Seed designers if empty
const count = db.prepare('SELECT COUNT(*) as c FROM designers').get();
if (count.c === 0) {
  const insert = db.prepare('INSERT OR IGNORE INTO designers (name, color) VALUES (?, ?)');
  const designers = [
    ['Alexander Caballero', '#FF6B6B'],
    ['Ana Turner',          '#4ECDC4'],
    ['Aris Alain',          '#45B7D1'],
    ['Arturo Atencio',      '#96CEB4'],
    ['Cristian Delgado',    '#FFEAA7'],
    ['Eduardo Rolla',       '#FFA07A'],
    ['Jesús Ortega',        '#F0E68C'],
    ['Jonathan Barrelier',  '#FFB347'],
    ['Jonathan Fajardo',    '#87CEEB'],
    ['Julio Mejía',         '#DDA0DD'],
    ['Leo Castro',          '#98FB98'],
    ['Luis Wong',           '#20B2AA'],
    ['Marcela Sánchez',     '#FF69B4'],
    ['Mariel Marengo',      '#BA55D3'],
    ['Miguel Díaz',         '#CD853F'],
    ['Paula Lobo',          '#7B68EE'],
    ['Ramiro González',     '#3CB371'],
    ['Robin De León',       '#FF8C00'],
    ['Yamileth Batista',    '#DB7093'],
  ];
  const insertMany = db.transaction((rows) => {
    for (const [name, color] of rows) insert.run(name, color);
  });
  insertMany(designers);
}

// ─── Migration: add skills column if missing ─────────────────────────────────
try {
  db.prepare('SELECT skills FROM designers LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE designers ADD COLUMN skills TEXT');
}

// ─── Seed skills data from medicion_habilidades ───────────────────────────────
// Escala 1-5: Dirección de Arte (40%), Ejecución (20%), Animación (20%), Velocidad (20%)
const skillsData = [
  { name: 'Alexander Caballero', arte: 2, ejecucion: 3, animacion: 2, velocidad: 4, promedio: 2.6, nivel: 'Junior' },
  { name: 'Ana Turner',          arte: 2, ejecucion: 5, animacion: 4, velocidad: 5, promedio: 3.6, nivel: 'Mid' },
  { name: 'Aris Alain',          arte: 3, ejecucion: 4, animacion: 2, velocidad: 3, promedio: 3.0, nivel: 'Mid' },
  { name: 'Arturo Atencio',      arte: 3, ejecucion: 4, animacion: 4, velocidad: 5, promedio: 3.8, nivel: 'Mid' },
  { name: 'Cristian Delgado',    arte: 4, ejecucion: 5, animacion: 5, velocidad: 3, promedio: 4.2, nivel: 'Senior' },
  { name: 'Eduardo Rolla',       arte: 2, ejecucion: 4, animacion: 5, velocidad: 5, promedio: 3.6, nivel: 'Mid' },
  { name: 'Jesús Ortega',        arte: 3, ejecucion: 4, animacion: 3, velocidad: 3, promedio: 3.2, nivel: 'Mid' },
  { name: 'Jonathan Barrelier',  arte: 4, ejecucion: 5, animacion: 2, velocidad: 4, promedio: 3.8, nivel: 'Mid' },
  { name: 'Jonathan Fajardo',    arte: 5, ejecucion: 5, animacion: 1, velocidad: 5, promedio: 4.2, nivel: 'Senior' },
  { name: 'Julio Mejía',         arte: 2, ejecucion: 4, animacion: 4, velocidad: 5, promedio: 3.4, nivel: 'Mid' },
  { name: 'Leo Castro',          arte: 5, ejecucion: 5, animacion: 5, velocidad: 3, promedio: 4.6, nivel: 'Lead' },
  { name: 'Luis Wong',           arte: 4, ejecucion: 5, animacion: 3, velocidad: 3, promedio: 3.8, nivel: 'Mid' },
  { name: 'Marcela Sánchez',     arte: 5, ejecucion: 5, animacion: 3, velocidad: 3, promedio: 4.2, nivel: 'Senior' },
  { name: 'Mariel Marengo',      arte: 2, ejecucion: 4, animacion: 3, velocidad: 5, promedio: 3.2, nivel: 'Mid' },
  { name: 'Miguel Díaz',         arte: 4, ejecucion: 5, animacion: 2, velocidad: 3, promedio: 3.6, nivel: 'Mid' },
  { name: 'Paula Lobo',          arte: 4, ejecucion: 4, animacion: 3, velocidad: 3, promedio: 3.6, nivel: 'Mid' },
  { name: 'Ramiro González',     arte: 4, ejecucion: 5, animacion: 5, velocidad: 5, promedio: 4.6, nivel: 'Lead' },
  { name: 'Robin De León',       arte: 1, ejecucion: 3, animacion: 1, velocidad: 1, promedio: 1.4, nivel: 'Junior bajo' },
  { name: 'Yamileth Batista',    arte: 5, ejecucion: 5, animacion: 1, velocidad: 4, promedio: 4.0, nivel: 'Senior' },
];

const updateSkills = db.prepare('UPDATE designers SET skills = ? WHERE name = ?');
const seedSkills = db.transaction(() => {
  for (const d of skillsData) {
    const existing = db.prepare('SELECT skills FROM designers WHERE name = ?').get(d.name);
    if (existing && !existing.skills) {
      updateSkills.run(JSON.stringify({
        arte: d.arte, ejecucion: d.ejecucion,
        animacion: d.animacion, velocidad: d.velocidad,
        promedio: d.promedio, nivel: d.nivel,
      }), d.name);
    }
  }
});
seedSkills();

// ─── Migration: add brands column if missing ─────────────────────────────────
try {
  db.prepare('SELECT brands FROM designers LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE designers ADD COLUMN brands TEXT');
}

// ─── Seed brands ──────────────────────────────────────────────────────────────
const brandsData = [
  { name: 'Jonathan Fajardo',    brands: ['Multiplaza'] },
  { name: 'Yamileth Batista',    brands: ['Alcaldía'] },
  { name: 'Ramiro González',     brands: ['Banisi'] },
  { name: 'Leo Castro',          brands: ['Metromall'] },
  { name: 'Aris Alain',          brands: ['Betcha'] },
  { name: 'Mariel Marengo',      brands: ['MadCam'] },
  { name: 'Paula Lobo',          brands: ['Volkswagen', "Steven's"] },
  { name: 'Julio Mejía',         brands: ['MadCam'] },
  { name: 'Miguel Díaz',         brands: ['General'] },
  { name: 'Alexander Caballero', brands: ['Xtra'] },
  { name: 'Arturo Atencio',      brands: ['Más Móvil'] },
  { name: 'Eduardo Rolla',       brands: ['Más Móvil'] },
  { name: 'Jonathan Barrelier',  brands: ['Más Móvil'] },
  { name: 'Jesús Ortega',        brands: ['FASA'] },
  { name: 'Luis Wong',           brands: ['Nissan'] },
  { name: 'Cristian Delgado',    brands: ['General'] },
  { name: 'Robin De León',       brands: ['Xtra'] },
  { name: 'Ana Turner',          brands: ['Multiplaza', 'Metromall'] },
];

const updateBrands = db.prepare('UPDATE designers SET brands = ? WHERE name = ?');
db.transaction(() => {
  for (const d of brandsData) updateBrands.run(JSON.stringify(d.brands), d.name);
})();

// ─── Migration: add title column if missing ──────────────────────────────────
try {
  db.prepare('SELECT title FROM designers LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE designers ADD COLUMN title TEXT');
}

// ─── Seed titles ──────────────────────────────────────────────────────────────
const titlesData = [
  { name: 'Leo Castro',          title: 'Head of Design' },
  { name: 'Jonathan Fajardo',    title: 'Director de Arte Lead' },
  { name: 'Yamileth Batista',    title: 'Directora de Arte Lead' },
  { name: 'Ramiro González',     title: 'Animador y Editor Lead' },
  { name: 'Cristian Delgado',    title: 'Diseñador 360' },
  { name: 'Marcela Sánchez',     title: 'Directora de Arte' },
  { name: 'Miguel Díaz',         title: 'Director de Arte' },
  { name: 'Luis Wong',           title: 'Diseñador de Ejecución' },
  { name: 'Jonathan Barrelier',  title: 'Diseñador de Ejecución' },
  { name: 'Eduardo Rolla',       title: 'Animador / Motion Designer' },
  { name: 'Julio Mejía',         title: 'Diseñador Motion' },
  { name: 'Ana Turner',          title: 'Diseñadora de Producción Rápida' },
  { name: 'Arturo Atencio',      title: 'Diseñador de Producción Rápida' },
  { name: 'Mariel Marengo',      title: 'Diseñadora de Producción Rápida' },
  { name: 'Paula Lobo',          title: 'Diseñadora de Dirección de Arte' },
  { name: 'Jesús Ortega',        title: 'Diseñador Generalista' },
  { name: 'Aris Alain',          title: 'Diseñador de Producción' },
  { name: 'Alexander Caballero', title: 'Diseñador de Producción' },
  { name: 'Robin De León',       title: 'Diseñador en Desarrollo' },
];

const updateTitle = db.prepare('UPDATE designers SET title = ? WHERE name = ?');
db.transaction(() => {
  for (const d of titlesData) updateTitle.run(d.title, d.name);
})();

// Queries
const queries = {
  getAllDesigners: db.prepare('SELECT * FROM designers WHERE active = 1 ORDER BY name'),

  getTasksByDesigner: db.prepare(`
    SELECT * FROM tasks
    WHERE designer_name = ?
    ORDER BY scraped_at DESC
  `),

  getAllTasks: db.prepare(`
    SELECT t.*, d.color
    FROM tasks t
    LEFT JOIN designers d ON d.name = t.designer_name
    ORDER BY t.designer_name, t.scraped_at DESC
  `),

  upsertTask: db.prepare(`
    INSERT INTO tasks (external_id, designer_name, title, status, created_by, assigned_to, order_date, basecamp_url, raw_html, scraped_at)
    VALUES (@external_id, @designer_name, @title, @status, @created_by, @assigned_to, @order_date, @basecamp_url, @raw_html, @scraped_at)
    ON CONFLICT(external_id) DO UPDATE SET
      title        = excluded.title,
      status       = excluded.status,
      created_by   = excluded.created_by,
      assigned_to  = excluded.assigned_to,
      order_date   = excluded.order_date,
      basecamp_url = excluded.basecamp_url,
      raw_html     = excluded.raw_html,
      scraped_at   = excluded.scraped_at
  `),

  insertTask: db.prepare(`
    INSERT OR REPLACE INTO tasks (external_id, designer_name, title, status, created_by, assigned_to, order_date, basecamp_url, raw_html, scraped_at)
    VALUES (@external_id, @designer_name, @title, @status, @created_by, @assigned_to, @order_date, @basecamp_url, @raw_html, @scraped_at)
  `),

  // Elimina filas duplicadas (mismo designer+title+order_date) conservando la más reciente
  deduplicateTasks: db.prepare(`
    DELETE FROM tasks WHERE id NOT IN (
      SELECT MAX(id) FROM tasks GROUP BY designer_name, title, order_date
    )
  `),

  logSync: db.prepare(`
    INSERT INTO sync_log (synced_at, status, tasks_found, error)
    VALUES (@synced_at, @status, @tasks_found, @error)
  `),

  getLastSync: db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1'),

  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM designers WHERE active = 1) as total_designers,
      (SELECT COUNT(*) FROM tasks WHERE status != 'completed') as active_tasks,
      (SELECT COUNT(*) FROM tasks WHERE status = 'completed') as completed_tasks,
      (SELECT COUNT(*) FROM tasks) as total_tasks
  `),
};

module.exports = { db, queries };
