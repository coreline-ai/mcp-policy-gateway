// Minimal forward-only SQL migration runner.
// Applies src/storage/migrations/*.sql in filename order, once each, tracked in _migrations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "./db";
import { openDb } from "./db";
import { loadConfig } from "../config/load-config";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function migrate(db: DB): string[] {
  db.exec(
    `create table if not exists _migrations (
       name text primary key,
       applied_at text not null default (datetime('now'))
     );`,
  );
  const applied = new Set(
    (db.prepare("select name from _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare("insert into _migrations (name) values (?)").run(file);
    });
    tx();
    ran.push(file);
  }
  return ran;
}

// Allow `npm run migrate` to apply migrations standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const ran = migrate(db);
  console.error(ran.length ? `applied: ${ran.join(", ")}` : "no pending migrations");
}
