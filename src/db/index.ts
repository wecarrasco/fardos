import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

/** Open (and on first call, migrate) the SQLite database. */
export function getDb(): Database.Database {
  if (db) return db;

  const path = resolve(config.dbPath);
  mkdirSync(dirname(path), { recursive: true });

  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));

  log.info('database ready', { path });
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
