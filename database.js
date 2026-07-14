const Database = require("better-sqlite3");

const db = new Database("hydra-wallet.db");

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    user_id TEXT PRIMARY KEY,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    reserved_cents INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

console.log("✅ Banco de dados conectado!");

module.exports = db;