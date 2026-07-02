// db.js — persistence layer.
//
// Uses Node's built-in `node:sqlite` (stable enough for dev/small deployments,
// zero native deps, zero external services) behind a small repository-style
// API. For production/multi-instance deployments, swap this file for a
// Postgres-backed implementation using the schema in prisma/schema.prisma —
// every function below has a 1:1 equivalent SQL query already written in
// comments, so the swap is mechanical, not a redesign.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "data.sqlite");
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    city TEXT NOT NULL,
    currency_code TEXT,
    admin_member_id TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trip_members (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL DEFAULT 'diger',
    paid_by TEXT NOT NULL,
    split_among TEXT NOT NULL,      -- JSON array of member ids
    is_settlement INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hazards (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    added_by TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_members_trip ON trip_members(trip_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);
  CREATE INDEX IF NOT EXISTS idx_hazards_trip ON hazards(trip_id);
`);

const now = () => new Date().toISOString();
const shortCode = () => randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

/* ---------------------------- users ---------------------------- */
// Postgres equivalent: INSERT INTO users (id, name, created_at) VALUES ($1,$2,$3)
export function createUser(name) {
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, now());
  return { id, name };
}
export function getUser(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) || null;
}

/* ---------------------------- trips ---------------------------- */
// Postgres equivalent: INSERT INTO trips (...) VALUES (...)
export function createTrip({ name, country, city, adminUserId, adminName }) {
  const tripId = randomUUID();
  const adminMemberId = randomUUID();
  const inviteCode = shortCode();
  const ts = now();
  db.prepare(`
    INSERT INTO trips (id, name, country, city, currency_code, admin_member_id, invite_code, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(tripId, name, country, city, adminMemberId, inviteCode, ts);
  db.prepare(`INSERT INTO trip_members (id, trip_id, user_id, name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(adminMemberId, tripId, adminUserId, adminName, ts);
  return getTripFull(tripId);
}

// Postgres equivalent: SELECT * FROM trips WHERE id = $1, plus joined members/expenses/hazards
export function getTripFull(tripId) {
  const trip = db.prepare(`SELECT * FROM trips WHERE id = ?`).get(tripId);
  if (!trip) return null;
  const members = db.prepare(`SELECT id, user_id as userId, name FROM trip_members WHERE trip_id = ? ORDER BY created_at ASC`).all(tripId);
  const expensesRaw = db.prepare(`SELECT * FROM expenses WHERE trip_id = ? ORDER BY created_at DESC`).all(tripId);
  const expenses = expensesRaw.map(e => ({
    id: e.id, desc: e.description, amount: e.amount, category: e.category,
    paidBy: e.paid_by, splitAmong: JSON.parse(e.split_among),
    isSettlement: !!e.is_settlement, date: e.created_at,
  }));
  const hazards = db.prepare(`SELECT id, text, created_at as date FROM hazards WHERE trip_id = ? ORDER BY created_at DESC`).all(tripId);
  return {
    id: trip.id, name: trip.name, country: trip.country, city: trip.city,
    currencyCode: trip.currency_code, admin: trip.admin_member_id, inviteCode: trip.invite_code,
    members, expenses, hazards, createdAt: trip.created_at,
  };
}

// Postgres equivalent: SELECT t.* FROM trips t JOIN trip_members m ON m.trip_id=t.id WHERE m.user_id = $1
export function listTripsForUser(userId) {
  const rows = db.prepare(`
    SELECT DISTINCT t.id FROM trips t
    JOIN trip_members m ON m.trip_id = t.id
    WHERE m.user_id = ?
    ORDER BY t.created_at DESC
  `).all(userId);
  return rows.map(r => getTripFull(r.id));
}

export function setTripCurrency(tripId, code) {
  db.prepare(`UPDATE trips SET currency_code = ? WHERE id = ?`).run(code, tripId);
}

export function deleteTrip(tripId) {
  db.prepare(`DELETE FROM trips WHERE id = ?`).run(tripId); // ON DELETE CASCADE clears children
}

export function findTripByInvite(code) {
  return db.prepare(`SELECT id FROM trips WHERE invite_code = ?`).get(code) || null;
}

export function isTripMember(tripId, userId) {
  return !!db.prepare(`SELECT 1 FROM trip_members WHERE trip_id = ? AND user_id = ?`).get(tripId, userId);
}

/* --------------------------- members ---------------------------- */
export function addMember(tripId, { userId = null, name }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO trip_members (id, trip_id, user_id, name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, tripId, userId, name, now());
  return { id, userId, name };
}

// Guards against orphaning expense references — same integrity rule the
// client already enforces, duplicated server-side because the client can't
// be trusted as the sole gatekeeper.
export function removeMember(tripId, memberId) {
  const trip = db.prepare(`SELECT admin_member_id FROM trips WHERE id = ?`).get(tripId);
  if (!trip) return { ok: false, reason: "Seyahat bulunamadı" };
  if (trip.admin_member_id === memberId) return { ok: false, reason: "Seyahat admini çıkarılamaz" };
  const referenced = db.prepare(`SELECT id, split_among, paid_by FROM expenses WHERE trip_id = ?`).all(tripId)
    .some(e => e.paid_by === memberId || JSON.parse(e.split_among).includes(memberId));
  if (referenced) return { ok: false, reason: "Bu kişi harcamalarda kayıtlı, önce ilgili harcamaları düzenleyin" };
  db.prepare(`DELETE FROM trip_members WHERE id = ? AND trip_id = ?`).run(memberId, tripId);
  return { ok: true };
}

/* --------------------------- expenses ---------------------------- */
export function addExpense(tripId, { desc, amount, category, paidBy, splitAmong, isSettlement = false }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO expenses (id, trip_id, description, amount, category, paid_by, split_among, is_settlement, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tripId, desc, amount, category || "diger", paidBy, JSON.stringify(splitAmong), isSettlement ? 1 : 0, now());
  return id;
}
export function deleteExpense(tripId, expenseId) {
  db.prepare(`DELETE FROM expenses WHERE id = ? AND trip_id = ?`).run(expenseId, tripId);
}

/* --------------------------- hazards ---------------------------- */
export function addHazard(tripId, text, addedBy) {
  const id = randomUUID();
  db.prepare(`INSERT INTO hazards (id, trip_id, text, added_by, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, tripId, text, addedBy || null, now());
  return id;
}
export function deleteHazard(tripId, hazardId) {
  db.prepare(`DELETE FROM hazards WHERE id = ? AND trip_id = ?`).run(hazardId, tripId);
}

export default db;
