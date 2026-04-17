import Database from 'better-sqlite3';

const db = new Database('./data/local.db');

const rows = db.prepare(`
  SELECT unit_id, base_id, costs FROM units
  WHERE base_id IN ('spearman', 'archer', 'knight')
  LIMIT 6
`).all() as any[];

for (const r of rows) {
  console.log(`${r.unit_id}: ${r.costs}`);
}

db.close();