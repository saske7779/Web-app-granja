const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.db');

db.serialize(() => {
  // Tabla de usuarios
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      balance REAL DEFAULT 0,
      referral_code TEXT UNIQUE,
      referred_by INTEGER,
      banned INTEGER DEFAULT 0,
      daily_referral_income REAL DEFAULT 0,
      FOREIGN KEY (referred_by) REFERENCES users(id)
    )
  `);
  
  // Migración para añadir la columna 'banned' si no existe
  db.run(`
    ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0
  `, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error(`[${new Date().toISOString()}] Error adding banned column: ${err.message}`);
    } else {
      console.log(`[${new Date().toISOString()}] Migration: banned column added or already exists`);
    }
  });
  
  // Migración para añadir la columna 'daily_referral_income' si no existe
  db.run(`
    ALTER TABLE users ADD COLUMN daily_referral_income REAL DEFAULT 0
  `, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error(`[${new Date().toISOString()}] Error adding daily_referral_income column: ${err.message}`);
    } else {
      console.log(`[${new Date().toISOString()}] Migration: daily_referral_income column added or already exists`);
    }
  });
  
  // Tabla de animales
  db.run(`
    CREATE TABLE IF NOT EXISTS animals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      purchase_date TEXT DEFAULT CURRENT_TIMESTAMP,
      expiry_date TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  // Tabla de transacciones
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      wallet_address TEXT,
      network TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  // Tabla de referidos
  db.run(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      referred_id INTEGER NOT NULL,
      earned REAL DEFAULT 0,
      FOREIGN KEY (referrer_id) REFERENCES users(id),
      FOREIGN KEY (referred_id) REFERENCES users(id)
    )
  `);
  
  // Tabla de recompensas por referidos
  db.run(`
    CREATE TABLE IF NOT EXISTS referral_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      milestone INTEGER NOT NULL,
      FOREIGN KEY (referrer_id) REFERENCES users(id)
    )
  `);
});

module.exports = db;