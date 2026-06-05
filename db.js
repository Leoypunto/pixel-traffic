const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'traffic.db');
const db = new Database(DB_PATH);

// Enable WAL for better performance
db.pragma('journal_mode = WAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS designers (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    color     TEXT NOT NULL DEFAULT '#4ECDC4',
    active    INTEGER NOT NULL DEFAULT 1
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
