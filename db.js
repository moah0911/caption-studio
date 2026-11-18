// Persistence: node:sqlite (built into Node 24) + local filesystem.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const EXPORTS_DIR = path.join(DATA_DIR, "exports");

for (const dir of [DATA_DIR, MEDIA_DIR, EXPORTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, "fluxocut.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ratio TEXT NOT NULL DEFAULT '9:16',
  bg_color TEXT NOT NULL DEFAULT '#111318',
  caption_style TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  type TEXT NOT NULL,
  duration REAL,
  size INTEGER,
  path TEXT NOT NULL,
  sha256 TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcriptions (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  language TEXT,
  engine TEXT,
  text TEXT,
  words TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS captions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  words TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS silence_cuts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_id TEXT,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'queued',
  output_path TEXT,
  error TEXT,
  params TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export default db;
