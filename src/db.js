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
      email TEXT UNIQUE,
      phone TEXT,
      avatar_photo TEXT,
      password_hash TEXT,
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
      email TEXT,
      role TEXT NOT NULL DEFAULT 'editor',
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
      split_amounts TEXT,
      is_settlement INTEGER NOT NULL DEFAULT 0,
      receipt_photo TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hazards (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      added_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trip_photos (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      photo TEXT NOT NULL,
      uploaded_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trip_polls (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      created_by TEXT,
      closed BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trip_poll_votes (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL REFERENCES trip_polls(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(poll_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS trip_packing_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      assigned_to TEXT,
      done BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trip_documents (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      uploaded_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trip_itinerary_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_number INTEGER NOT NULL DEFAULT 1,
      time TEXT,
      title TEXT NOT NULL,
      notes TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trip_messages (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      sender_member_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      live BOOLEAN NOT NULL DEFAULT false,
      photo TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_trip ON trip_messages(trip_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      prefs TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

    CREATE INDEX IF NOT EXISTS idx_members_trip ON trip_members(trip_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);
    CREATE INDEX IF NOT EXISTS idx_hazards_trip ON hazards(trip_id);
  `);
  // Migration-safe: adds these columns if the table already existed from a
  // deploy before login support was added, without touching existing rows.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TEXT;
    ALTER TABLE trip_members ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE trip_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor';
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_photo TEXT;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS split_amounts TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_photo TEXT;
    ALTER TABLE trip_messages ADD COLUMN IF NOT EXISTS photo TEXT;
    ALTER TABLE trip_messages ADD COLUMN IF NOT EXISTS live BOOLEAN NOT NULL DEFAULT false;
  `);
  try {
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)`);
  } catch { /* constraint already exists — fine, this is the idempotent path */ }
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
export async function createUserWithPassword(email, passwordHash, name) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, name, email.toLowerCase(), passwordHash, now()]
  );
  return { id, name, email: email.toLowerCase() };
}
export async function getUserByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  return rows[0] || null;
}

export async function setResetToken(userId, token, expiresAt) {
  await pool.query(`UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`, [token, expiresAt, userId]);
}
export async function getUserByResetToken(token) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE reset_token = $1`, [token]);
  return rows[0] || null;
}
export async function updatePassword(userId, passwordHash) {
  await pool.query(
    `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2`,
    [passwordHash, userId]
  );
}
export async function updateUserProfile(userId, { name, phone, email, avatarPhoto }) {
  const sets = []; const vals = []; let i = 1;
  if (name !== undefined) { sets.push(`name = $${i++}`); vals.push(name); }
  if (phone !== undefined) { sets.push(`phone = $${i++}`); vals.push(phone || null); }
  if (email !== undefined) { sets.push(`email = $${i++}`); vals.push(email || null); }
  if (avatarPhoto !== undefined) { sets.push(`avatar_photo = $${i++}`); vals.push(avatarPhoto || null); }
  if (sets.length === 0) return getUser(userId);
  vals.push(userId);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  return getUser(userId);
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
    `SELECT tm.id, tm.user_id as "userId", tm.name, tm.email, tm.role, u.avatar_photo as "avatarPhoto"
     FROM trip_members tm LEFT JOIN users u ON u.id = tm.user_id
     WHERE tm.trip_id = $1 ORDER BY tm.created_at ASC`, [tripId]);
  const { rows: expensesRaw } = await pool.query(
    `SELECT * FROM expenses WHERE trip_id = $1 ORDER BY created_at DESC`, [tripId]);
  const expenses = expensesRaw.map(e => ({
    id: e.id, desc: e.description, amount: e.amount, category: e.category,
    paidBy: e.paid_by, splitAmong: JSON.parse(e.split_among),
    splitAmounts: e.split_amounts ? JSON.parse(e.split_amounts) : null,
    isSettlement: !!e.is_settlement, receiptPhoto: e.receipt_photo || null, date: e.created_at,
  }));
  const { rows: hazards } = await pool.query(
    `SELECT id, text, created_at as date FROM hazards WHERE trip_id = $1 ORDER BY created_at DESC`, [tripId]);
  const { rows: photos } = await pool.query(
    `SELECT id, photo, uploaded_by as "uploadedBy", created_at as date FROM trip_photos WHERE trip_id = $1 ORDER BY created_at ASC`, [tripId]);
  return {
    id: trip.id, name: trip.name, country: trip.country, city: trip.city,
    currencyCode: trip.currency_code, admin: trip.admin_member_id, inviteCode: trip.invite_code,
    members, expenses, hazards, photos, createdAt: trip.created_at,
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

/* --------------------------- account deletion / export ---------------------------- */
// Deleting an account shouldn't corrupt other members' shared expense
// history — if this user is the sole member of a trip, the whole trip goes
// with them; otherwise their membership is detached (name kept, marked as
// a deleted account) so past expenses/messages still make sense to the
// people who stay. Admin duties get handed to the next-oldest member first.
export async function deleteUserAccount(userId) {
  const { rows: memberships } = await pool.query(
    `SELECT tm.id as member_id, tm.trip_id, t.admin_member_id
     FROM trip_members tm JOIN trips t ON t.id = tm.trip_id WHERE tm.user_id = $1`,
    [userId]
  );
  for (const m of memberships) {
    const { rows: others } = await pool.query(
      `SELECT id FROM trip_members WHERE trip_id = $1 AND id != $2 ORDER BY created_at ASC`,
      [m.trip_id, m.member_id]
    );
    if (others.length === 0) {
      await pool.query(`DELETE FROM trips WHERE id = $1`, [m.trip_id]); // cascades members/expenses/messages/photos/hazards
    } else {
      if (m.admin_member_id === m.member_id) {
        await pool.query(`UPDATE trips SET admin_member_id = $1 WHERE id = $2`, [others[0].id, m.trip_id]);
      }
      await pool.query(
        `UPDATE trip_members SET user_id = NULL, name = name || ' (hesap silindi)' WHERE id = $1`,
        [m.member_id]
      );
    }
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

export async function exportUserData(userId) {
  const user = await getUser(userId);
  const { rows: trips } = await pool.query(
    `SELECT t.id, t.name, t.country, t.city, t.currency_code as "currencyCode", t.created_at as "createdAt"
     FROM trips t JOIN trip_members tm ON tm.trip_id = t.id WHERE tm.user_id = $1`,
    [userId]
  );
  const { rows: messages } = await pool.query(
    `SELECT tmsg.text, tmsg.kind, tmsg.lat, tmsg.lon, tmsg.created_at as "createdAt", tmsg.trip_id as "tripId"
     FROM trip_messages tmsg JOIN trip_members m ON m.id = tmsg.sender_member_id WHERE m.user_id = $1
     ORDER BY tmsg.created_at ASC`,
    [userId]
  );
  return {
    profile: { name: user.name, email: user.email, phone: user.phone, createdAt: user.created_at },
    trips, messages,
    exportedAt: now(),
  };
}

/* --------------------------- members ---------------------------- */
export async function addMember(tripId, { userId = null, name, email = null, role = "editor" }) {
  const id = randomUUID();
  await pool.query(`INSERT INTO trip_members (id, trip_id, user_id, name, email, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, tripId, userId, name, email, role, now()]);
  return { id, userId, name, email, role };
}
export async function setMemberRole(tripId, memberId, role) {
  if (!["editor", "viewer"].includes(role)) throw new Error("Geçersiz rol");
  await pool.query(`UPDATE trip_members SET role = $1 WHERE id = $2 AND trip_id = $3`, [role, memberId, tripId]);
}
export async function getMemberRole(tripId, userId) {
  const { rows } = await pool.query(`SELECT role FROM trip_members WHERE trip_id = $1 AND user_id = $2`, [tripId, userId]);
  return rows[0]?.role || null;
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
export async function addExpense(tripId, { desc, amount, category, paidBy, splitAmong, isSettlement = false, receiptPhoto = null, splitAmounts = null }) {
  const id = randomUUID();
  await pool.query(`
    INSERT INTO expenses (id, trip_id, description, amount, category, paid_by, split_among, split_amounts, is_settlement, receipt_photo, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [id, tripId, desc, amount, category || "diger", paidBy, JSON.stringify(splitAmong), splitAmounts ? JSON.stringify(splitAmounts) : null, isSettlement ? 1 : 0, receiptPhoto, now()]);
  return id;
}
export async function deleteExpense(tripId, expenseId) {
  await pool.query(`DELETE FROM expenses WHERE id = $1 AND trip_id = $2`, [expenseId, tripId]);
}

/* --------------------------- trip photos ---------------------------- */
export async function countTripPhotos(tripId) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM trip_photos WHERE trip_id = $1`, [tripId]);
  return rows[0].count;
}
export async function addTripPhoto(tripId, { photo, uploadedBy }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trip_photos (id, trip_id, photo, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, tripId, photo, uploadedBy || null, now()]
  );
  return id;
}
export async function deleteTripPhoto(tripId, photoId) {
  await pool.query(`DELETE FROM trip_photos WHERE id = $1 AND trip_id = $2`, [photoId, tripId]);
}

/* --------------------------- polls ---------------------------- */
export async function getPolls(tripId) {
  const { rows: polls } = await pool.query(
    `SELECT id, question, options, created_by as "createdBy", closed, created_at as "createdAt"
     FROM trip_polls WHERE trip_id = $1 ORDER BY created_at DESC`, [tripId]);
  const { rows: votes } = await pool.query(
    `SELECT pv.poll_id as "pollId", pv.member_id as "memberId", pv.option_index as "optionIndex"
     FROM trip_poll_votes pv JOIN trip_polls p ON p.id = pv.poll_id WHERE p.trip_id = $1`, [tripId]);
  return polls.map(p => ({
    ...p, options: JSON.parse(p.options),
    votes: votes.filter(v => v.pollId === p.id).map(v => ({ memberId: v.memberId, optionIndex: v.optionIndex })),
  }));
}
export async function addPoll(tripId, { question, options, createdBy }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trip_polls (id, trip_id, question, options, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tripId, question, JSON.stringify(options), createdBy, now()]);
  return id;
}
export async function voteOnPoll(pollId, memberId, optionIndex) {
  await pool.query(
    `INSERT INTO trip_poll_votes (id, poll_id, member_id, option_index, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (poll_id, member_id) DO UPDATE SET option_index = $4`,
    [randomUUID(), pollId, memberId, optionIndex, now()]);
}
export async function closePoll(tripId, pollId) {
  await pool.query(`UPDATE trip_polls SET closed = true WHERE id = $1 AND trip_id = $2`, [pollId, tripId]);
}
export async function deletePoll(tripId, pollId) {
  await pool.query(`DELETE FROM trip_polls WHERE id = $1 AND trip_id = $2`, [pollId, tripId]);
}

/* --------------------------- packing list ---------------------------- */
export async function getPackingItems(tripId) {
  const { rows } = await pool.query(
    `SELECT id, text, assigned_to as "assignedTo", done, created_at as "createdAt"
     FROM trip_packing_items WHERE trip_id = $1 ORDER BY created_at ASC`, [tripId]);
  return rows;
}
export async function addPackingItem(tripId, { text, assignedTo }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trip_packing_items (id, trip_id, text, assigned_to, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, tripId, text, assignedTo || null, now()]);
  return id;
}
export async function togglePackingItem(tripId, itemId, done) {
  await pool.query(`UPDATE trip_packing_items SET done = $1 WHERE id = $2 AND trip_id = $3`, [done, itemId, tripId]);
}
export async function deletePackingItem(tripId, itemId) {
  await pool.query(`DELETE FROM trip_packing_items WHERE id = $1 AND trip_id = $2`, [itemId, tripId]);
}

/* --------------------------- documents ---------------------------- */
export async function getDocuments(tripId) {
  const { rows } = await pool.query(
    `SELECT id, name, file, uploaded_by as "uploadedBy", created_at as "createdAt"
     FROM trip_documents WHERE trip_id = $1 ORDER BY created_at DESC`, [tripId]);
  return rows;
}
export async function addDocument(tripId, { name, file, uploadedBy }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trip_documents (id, trip_id, name, file, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tripId, name, file, uploadedBy || null, now()]);
  return id;
}
export async function deleteDocument(tripId, docId) {
  await pool.query(`DELETE FROM trip_documents WHERE id = $1 AND trip_id = $2`, [docId, tripId]);
}

/* --------------------------- itinerary ---------------------------- */
export async function getItinerary(tripId) {
  const { rows } = await pool.query(
    `SELECT id, day_number as "dayNumber", time, title, notes, created_by as "createdBy", created_at as "createdAt"
     FROM trip_itinerary_items WHERE trip_id = $1 ORDER BY day_number ASC, time ASC NULLS LAST, created_at ASC`, [tripId]);
  return rows;
}
export async function addItineraryItem(tripId, { dayNumber, time, title, notes, createdBy }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trip_itinerary_items (id, trip_id, day_number, time, title, notes, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, tripId, dayNumber || 1, time || null, title, notes || null, createdBy || null, now()]);
  return id;
}
export async function deleteItineraryItem(tripId, itemId) {
  await pool.query(`DELETE FROM trip_itinerary_items WHERE id = $1 AND trip_id = $2`, [itemId, tripId]);
}

/* --------------------------- chat messages ---------------------------- */
export async function getMessages(tripId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, sender_member_id as "senderMemberId", sender_name as "senderName",
            kind, text, lat, lon, live, photo, created_at as "createdAt"
     FROM trip_messages WHERE trip_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [tripId, limit]
  );
  return rows;
}
export async function addMessage(tripId, { senderMemberId, senderName, kind, text, lat, lon, live, photo }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trip_messages (id, trip_id, sender_member_id, sender_name, kind, text, lat, lon, live, photo, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, tripId, senderMemberId, senderName, kind, text || null, lat ?? null, lon ?? null, !!live, photo || null, now()]
  );
  return { id, tripId, senderMemberId, senderName, kind, text: text || null, lat: lat ?? null, lon: lon ?? null, live: !!live, photo: photo || null, createdAt: now() };
}

/* --------------------------- push subscriptions ---------------------------- */
export async function upsertPushSubscription(userId, { endpoint, p256dh, auth, prefs }) {
  await pool.query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, prefs, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $4, auth = $5, prefs = $6`,
    [randomUUID(), userId, endpoint, p256dh, auth, JSON.stringify(prefs || {}), now()]
  );
}
export async function removePushSubscription(endpoint) {
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}
export async function updatePushPrefs(endpoint, prefs) {
  await pool.query(`UPDATE push_subscriptions SET prefs = $1 WHERE endpoint = $2`, [JSON.stringify(prefs || {}), endpoint]);
}
export async function getPushSubscriptionsForUsers(userIds) {
  if (!userIds.length) return [];
  const { rows } = await pool.query(
    `SELECT id, user_id as "userId", endpoint, p256dh, auth, prefs FROM push_subscriptions WHERE user_id = ANY($1)`,
    [userIds]
  );
  return rows.map(r => ({ ...r, prefs: JSON.parse(r.prefs || "{}") }));
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
