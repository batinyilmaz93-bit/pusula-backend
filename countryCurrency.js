// db.js — Postgres-backed persistence layer.
//
// Earlier this project used Node's built-in node:sqlite for zero-config
// local dev. That turned out to be the wrong call for this app specifically:
// Render's free web service tier wipes the local filesystem on every
// redeploy AND every time the service spins down after 15 minutes of
// inactivity — which is constant on a free instance. That silently deleted
// every user/trip and left saved logins pointing at users that no longer
// existed ("Geçersiz oturum"). Postgres on a free host (Neon/Supabase) does
// not have that problem — the database is a separate, always-on service.
//
// Every function below keeps its exact name/signature from the SQLite
// version, but is now async (returns a Promise) since `pg` is async. Route
// handlers await these calls.

import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add a free Postgres (Neon/Supabase) connection string as an environment variable.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

const now = () => new Date().toISOString();
const shortCode = () => randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

export async function initSchema() {
  await pool.query(`
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
      amount DOUBLE PRECISION NOT NULL,
      category TEXT NOT NULL DEFAULT 'diger',
      paid_by TEXT NOT NULL,
      split_among TEXT NOT NULL,
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
}

/* ---------------------------- users ---------------------------- */
export async function createUser(name) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, name, created_at) VALUES ($1, $2, $3)`, [id, name, now()]);
  return { id, name };
}
export async function getUser(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

/* ---------------------------- trips ---------------------------- */
export async function createTrip({ name, country, city, adminUserId, adminName }) {
  const tripId = randomUUID();
  const adminMemberId = randomUUID();
  const inviteCode = shortCode();
  const ts = now();
  await pool.query(`
    INSERT INTO trips (id, name, country, city, currency_code, admin_member_id, invite_code, created_at)
    VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
  `, [tripId, name, country, city, adminMemberId, inviteCode, ts]);
  await pool.query(`INSERT INTO trip_members (id, trip_id, user_id, name, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [adminMemberId, tripId, adminUserId, adminName, ts]);
  return getTripFull(tripId);
}

export async function getTripFull(tripId) {
  const { rows: tripRows } = await pool.query(`SELECT * FROM trips WHERE id = $1`, [tripId]);
  const trip = tripRows[0];
  if (!trip) return null;
  const { rows: members } = await pool.query(
    `SELECT id, user_id as "userId", name FROM trip_members WHERE trip_id = $1 ORDER BY created_at ASC`, [tripId]);
  const { rows: expensesRaw } = await pool.query(
    `SELECT * FROM expenses WHERE trip_id = $1 ORDER BY created_at DESC`, [tripId]);
  const expenses = expensesRaw.map(e => ({
    id: e.id, desc: e.description, amount: e.amount, category: e.category,
    paidBy: e.paid_by, splitAmong: JSON.parse(e.split_among),
    isSettlement: !!e.is_settlement, date: e.created_at,
  }));
  const { rows: hazards } = await pool.query(
    `SELECT id, text, created_at as date FROM hazards WHERE trip_id = $1 ORDER BY created_at DESC`, [tripId]);
  return {
    id: trip.id, name: trip.name, country: trip.country, city: trip.city,
    currencyCode: trip.currency_code, admin: trip.admin_member_id, inviteCode: trip.invite_code,
    members, expenses, hazards, createdAt: trip.created_at,
  };
}

export async function listTripsForUser(userId) {
  const { rows } = await pool.query(`
    SELECT DISTINCT t.id, t.created_at FROM trips t
    JOIN trip_members m ON m.trip_id = t.id
    WHERE m.user_id = $1
    ORDER BY t.created_at DESC
  `, [userId]);
  return Promise.all(rows.map(r => getTripFull(r.id)));
}

export async function setTripCurrency(tripId, code) {
  await pool.query(`UPDATE trips SET currency_code = $1 WHERE id = $2`, [code, tripId]);
}

export async function deleteTrip(tripId) {
  await pool.query(`DELETE FROM trips WHERE id = $1`, [tripId]);
}

export async function findTripByInvite(code) {
  const { rows } = await pool.query(`SELECT id FROM trips WHERE invite_code = $1`, [code]);
  return rows[0] || null;
}

export async function isTripMember(tripId, userId) {
  const { rows } = await pool.query(`SELECT 1 FROM trip_members WHERE trip_id = $1 AND user_id = $2`, [tripId, userId]);
  return rows.length > 0;
}

/* --------------------------- members ---------------------------- */
export async function addMember(tripId, { userId = null, name }) {
  const id = randomUUID();
  await pool.query(`INSERT INTO trip_members (id, trip_id, user_id, name, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, tripId, userId, name, now()]);
  return { id, userId, name };
}

export async function removeMember(tripId, memberId) {
  const { rows } = await pool.query(`SELECT admin_member_id FROM trips WHERE id = $1`, [tripId]);
  const trip = rows[0];
  if (!trip) return { ok: false, reason: "Seyahat bulunamadı" };
  if (trip.admin_member_id === memberId) return { ok: false, reason: "Seyahat admini çıkarılamaz" };
  const { rows: exps } = await pool.query(`SELECT split_among, paid_by FROM expenses WHERE trip_id = $1`, [tripId]);
  const referenced = exps.some(e => e.paid_by === memberId || JSON.parse(e.split_among).includes(memberId));
  if (referenced) return { ok: false, reason: "Bu kişi harcamalarda kayıtlı, önce ilgili harcamaları düzenleyin" };
  await pool.query(`DELETE FROM trip_members WHERE id = $1 AND trip_id = $2`, [memberId, tripId]);
  return { ok: true };
}

/* --------------------------- expenses ---------------------------- */
export async function addExpense(tripId, { desc, amount, category, paidBy, splitAmong, isSettlement = false }) {
  const id = randomUUID();
  await pool.query(`
    INSERT INTO expenses (id, trip_id, description, amount, category, paid_by, split_among, is_settlement, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [id, tripId, desc, amount, category || "diger", paidBy, JSON.stringify(splitAmong), isSettlement ? 1 : 0, now()]);
  return id;
}
export async function deleteExpense(tripId, expenseId) {
  await pool.query(`DELETE FROM expenses WHERE id = $1 AND trip_id = $2`, [expenseId, tripId]);
}

/* --------------------------- hazards ---------------------------- */
export async function addHazard(tripId, text, addedBy) {
  const id = randomUUID();
  await pool.query(`INSERT INTO hazards (id, trip_id, text, added_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, tripId, text, addedBy || null, now()]);
  return id;
}
export async function deleteHazard(tripId, hazardId) {
  await pool.query(`DELETE FROM hazards WHERE id = $1 AND trip_id = $2`, [hazardId, tripId]);
}

export default pool;
