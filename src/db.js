import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.DB_PATH || './database.sqlite';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir) && dbDir !== '.') {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Promisified database helpers
export const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
};

export const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
};

export const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

export const dbTransaction = async (actions) => {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        db.run('BEGIN TRANSACTION');
        const result = await actions();
        db.run('COMMIT', (err) => {
          if (err) reject(err);
          else resolve(result);
        });
      } catch (err) {
        db.run('ROLLBACK', () => {
          reject(err);
        });
      }
    });
  });
};

// Initialize database tables
export const initDb = async () => {
  // Users Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('worker', 'admin')),
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Jobs Table (keeps track of imported video processing status)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Clips Table (segments to be transcribed)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER,
      local_path TEXT NOT NULL,
      duration REAL NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      transcription TEXT,
      quality_flags TEXT, -- JSON array of flags (e.g. ["noisy", "multiple_speakers"])
      quality_reason TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'draft', 'submitted')),
      annotator_id INTEGER,
      global_id INTEGER UNIQUE, -- Shared consecutive numbering format (e.g. 1, 2, 3...)
      uploaded_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES jobs(id),
      FOREIGN KEY (annotator_id) REFERENCES users(id)
    )
  `);

  // Settings Table (for storing configuration like counter values)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Initialize global counter if it doesn't exist
  const counter = await dbGet("SELECT value FROM settings WHERE key = 'last_assigned_id'");
  if (!counter) {
    await dbRun("INSERT INTO settings (key, value) VALUES ('last_assigned_id', '0')");
  }

  console.log('Database tables initialized successfully');
};
