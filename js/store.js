// Lapisan data: catatan (realtime), lampiran (dipecah per chunk di Firestore), live pad.
import {
  db, collection, doc, getDocs, getDocFromServer, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy,
  limit, serverTimestamp, Bytes, writeBatch
} from "./firebase.js";
import { encryptBytes, decryptBytes, encryptText, decryptText } from "./crypto.js";
import { toMillis } from "./ui.js";

// ----------------------------------------------------------------------------
// Batasan (disesuaikan dengan Firestore free tier & limit 1 MiB per dokumen)
// ----------------------------------------------------------------------------
export const LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,     // 10 MB per file
  chunkBytes: 900 * 1024,             // 900 KB per dokumen chunk
  maxContentBytes: 600 * 1024,        // isi catatan (aman untuk enkripsi + base64)
  maxTitle: 200,
  maxTags: 20,
  maxLiveChars: 200000,
};

export const ALLOWED_EXT = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"],
  doc: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "md", "rtf", "odt", "ods", "odp", "json", "xml", "log"],
  archive: ["zip", "rar", "7z", "tar", "gz"],
};
const ALL_EXT = new Set([...ALLOWED_EXT.image, ...ALLOWED_EXT.doc, ...ALLOWED_EXT.archive]);
export const ACCEPT_ATTR = [...ALL_EXT].map((e) => "." + e).join(",");
const PREVIEWABLE_IMG = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"]);

export const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
export function fileKind(name) {
  const e = extOf(name);
  if (ALLOWED_EXT.image.includes(e)) return "image";
  if (ALLOWED_EXT.archive.includes(e)) return "archive";
  return "doc";
}
export const isPreviewableImage = (name) => PREVIEWABLE_IMG.has(extOf(name));

export const COLORS = ["default", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

// ----------------------------------------------------------------------------
// Referensi
// ----------------------------------------------------------------------------
let uid = null;
const notesCol = () => collection(db, "users", uid, "notes");
export const noteRef = (id) => doc(db, "users", uid, "notes", id);
const filesCol = (noteId) => collection(db, "users", uid, "notes", noteId, "files");
const chunksCol = (noteId, fileId) => collection(db, "users", uid, "notes", noteId, "files", fileId, "chunks");
export const liveRef = () => doc(db, "users", uid, "live", "pad");
export const newNoteId = () => doc(notesCol()).id;

// ----------------------------------------------------------------------------
// Catatan (satu listener realtime untuk dashboard + pencarian)
// ----------------------------------------------------------------------------
const state = { notes: [], ready: false, error: null };
const subs = new Set();
let unsubNotes = null;

export function startStore(userId) {
  stopStore();
  uid = userId;
  const q = query(notesCol(), orderBy("updatedAt", "desc"));
  unsubNotes = onSnapshot(q, { includeMetadataChanges: false }, (snap) => {
    state.notes = snap.docs.map((d) => {
      const data = d.data({ serverTimestamps: "estimate" });
      return { id: d.id, ...data, _updated: toMillis(data.updatedAt), _created: toMillis(data.createdAt) };
    });
    state.ready = true;
    state.error = null;
    emit();
  }, (err) => {
    console.error(err);
    state.error = err;
    state.ready = true;
    emit();
  });
}
export function stopStore() {
  if (unsubNotes) unsubNotes();
  unsubNotes = null;
  state.notes = []; state.ready = false; state.error = null;
  uid = null;
}
export const getState = () => state;
export const getNote = (id) => state.notes.find((n) => n.id === id) || null;
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit() { subs.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }

export function watchNote(id, cb, onErr) {
  return onSnapshot(noteRef(id), { includeMetadataChanges: false }, (snap) => {
    cb(snap.exists() ? { id: snap.id, ...snap.data({ serverTimestamps: "estimate" }) } : null, snap);
  }, onErr);
}

export async function createNote(id, data) {
  await setDoc(noteRef(id), {
    title: data.title || "",
    content: data.content || "",
    tags: data.tags || [],
    color: data.color || "default",
    pinned: !!data.pinned,
    locked: false,
    lock: null,
    enc: null,
    fileCount: 0,
    fileNames: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function updateNote(id, patch) {
  return updateDoc(noteRef(id), { ...patch, updatedAt: serverTimestamp() });
}

export async function deleteNote(id) {
  const files = await getDocs(filesCol(id));
  for (const f of files.docs) await deleteFileDocs(id, f.id);
  await deleteDoc(noteRef(id));
}

// ----------------------------------------------------------------------------
// Lampiran
// Firebase Storage tidak tersedia di paket gratis, jadi file disimpan langsung
// di Firestore: 1 dokumen metadata + N dokumen chunk berisi Bytes (≤ 900 KB).
// File di catatan terkunci dienkripsi (isi + nama) sebelum diunggah.
// ----------------------------------------------------------------------------
export function validateFile(file) {
  const e = extOf(file.name);
  if (!ALL_EXT.has(e)) return `Tipe file .${e || "?"} tidak didukung. Gunakan gambar, dokumen, atau arsip (zip/rar/7z).`;
  if (file.size > LIMITS.maxFileBytes) return `"${file.name}" melebihi batas ${LIMITS.maxFileBytes / 1024 / 1024} MB.`;
  if (file.size === 0) return `"${file.name}" kosong.`;
  return null;
}

export function watchFiles(noteId, cb, onErr) {
  return onSnapshot(query(filesCol(noteId), orderBy("createdAt", "asc")), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })));
  }, onErr);
}

/** Dekripsi metadata file (nama & tipe) bila terenkripsi. */
export async function fileMeta(f, key) {
  if (!f.enc) return { name: f.name, type: f.type };
  if (!key) return { name: "File terenkripsi", type: "" };
  try { return JSON.parse(await decryptText(key, f.m)); } catch { return { name: "File (gagal didekripsi)", type: "" }; }
}

async function writeFile(noteId, bytes, name, type, key, onProgress) {
  const fileRef = doc(filesCol(noteId));
  let payload = bytes;
  let meta = { name: name.slice(0, 255), type: (type || "").slice(0, 120), enc: false, iv: "", m: null };
  if (key) {
    const e = await encryptBytes(key, bytes);
    payload = e.data;
    meta = { name: "", type: "", enc: true, iv: e.iv, m: await encryptText(key, JSON.stringify({ name, type })) };
  }
  const chunks = Math.max(1, Math.ceil(payload.length / LIMITS.chunkBytes));
  await setDoc(fileRef, { ...meta, size: bytes.length, chunks, status: "uploading", createdAt: serverTimestamp() });
  for (let i = 0; i < chunks; i++) {
    const part = payload.subarray(i * LIMITS.chunkBytes, (i + 1) * LIMITS.chunkBytes);
    await setDoc(doc(chunksCol(noteId, fileRef.id), String(i)), { i, d: Bytes.fromUint8Array(part) });
    onProgress && onProgress((i + 1) / chunks);
  }
  await updateDoc(fileRef, { status: "ready" });
  return fileRef.id;
}

export async function uploadFile(noteId, file, key, onProgress) {
  const err = validateFile(file);
  if (err) throw new Error(err);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = await writeFile(noteId, bytes, file.name, file.type, key, onProgress);
  await syncFileSummary(noteId);
  return id;
}

/** Unduh & gabungkan chunk → Uint8Array (didekripsi bila perlu). */
export async function readFileBytes(noteId, f, key) {
  const snap = await getDocs(query(chunksCol(noteId, f.id), orderBy("i", "asc")));
  if (snap.size < f.chunks) throw new Error("File belum lengkap atau rusak.");
  const parts = snap.docs.slice(0, f.chunks).map((d) => d.get("d").toUint8Array());
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  if (!f.enc) return out;
  if (!key) throw new Error("Catatan terkunci. Buka kunci dulu.");
  return decryptBytes(key, f.iv, out);
}

async function deleteFileDocs(noteId, fileId) {
  const chunks = await getDocs(chunksCol(noteId, fileId));
  const batch = writeBatch(db);
  chunks.docs.forEach((c) => batch.delete(c.ref));
  batch.delete(doc(filesCol(noteId), fileId));
  await batch.commit();
}

export async function deleteFile(noteId, fileId) {
  await deleteFileDocs(noteId, fileId);
  await syncFileSummary(noteId);
}

/** Simpan ringkasan lampiran di dokumen catatan (untuk kartu & pencarian). */
export async function syncFileSummary(noteId) {
  const snap = await getDocs(filesCol(noteId));
  const files = snap.docs.map((d) => d.data());
  const names = files.filter((f) => !f.enc && f.name).map((f) => f.name).slice(0, 100);
  await updateNote(noteId, { fileCount: files.length, fileNames: names });
}

/**
 * Enkripsi ulang (atau dekripsi) semua lampiran sebuah catatan.
 * Aman terhadap kegagalan di tengah jalan: file baru ditulis dulu, lalu yang lama dihapus.
 * fromKey: kunci untuk membaca file terenkripsi; toKey: null = simpan polos.
 */
export async function reencryptFiles(noteId, fromKey, toKey, onProgress) {
  const snap = await getDocs(filesCol(noteId));
  const files = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const targets = files.filter((f) => f.status === "ready" && (toKey ? !f.enc : f.enc));
  let done = 0;
  for (const f of targets) {
    const bytes = await readFileBytes(noteId, f, fromKey);
    const meta = await fileMeta(f, fromKey);
    await writeFile(noteId, bytes, meta.name, meta.type, toKey, null);
    await deleteFileDocs(noteId, f.id);
    onProgress && onProgress(++done, targets.length);
  }
  if (targets.length) await syncFileSummary(noteId);
  return targets.length;
}

/** Jumlah file polos di catatan (untuk migrasi otomatis setelah kunci dibuka). */
export async function countPlainFiles(noteId) {
  const snap = await getDocs(filesCol(noteId));
  return snap.docs.filter((d) => !d.get("enc") && d.get("status") === "ready").length;
}

// ----------------------------------------------------------------------------
// Live pad
// ----------------------------------------------------------------------------
export function watchLive(cb, onErr) {
  return onSnapshot(liveRef(), { includeMetadataChanges: true }, (snap) => cb(snap), onErr);
}
export function writeLive(text, device, session) {
  return setDoc(liveRef(), { text, device, session, updatedAt: serverTimestamp() });
}

// ----------------------------------------------------------------------------
// Room bersama (berbagi teks antar akun dengan kode undangan)
//
//  rooms/{roomId}                 name, ownerId, code, createdAt, updatedAt
//  rooms/{roomId}/members/{uid}   name, code, role, joinedAt   (keanggotaan)
//  rooms/{roomId}/items/{itemId}  text, uid, name, createdAt   (feed kiriman)
//  invites/{code}                 roomId, createdAt            (kode → room)
//  users/{uid}/rooms/{roomId}     name, role, joinedAt         (daftar room saya)
//
//  Keamanan ditegakkan oleh firestore.rules: hanya anggota yang bisa membaca room,
//  bergabung wajib menyertakan kode undangan yang sedang berlaku.
// ----------------------------------------------------------------------------
export const ROOM_LIMITS = { name: 60, text: 20000, feed: 100 };
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // tanpa 0/O/1/I agar tidak tertukar
export function genCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(r, (b) => CODE_ALPHABET[b & 31]).join("");
}
export const normalizeCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
export const formatCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c || "");
export const getUid = () => uid;

const roomRef = (id) => doc(db, "rooms", id);
const inviteRef = (code) => doc(db, "invites", code);
const memberRef = (roomId, u) => doc(db, "rooms", roomId, "members", u);
const itemsCol = (roomId) => collection(db, "rooms", roomId, "items");
const myRoomRef = (roomId) => doc(db, "users", uid, "rooms", roomId);
const cleanName = (s, fb = "Pengguna") => (String(s || "").trim() || fb).slice(0, ROOM_LIMITS.name);

export function watchMyRooms(cb, onErr) {
  return onSnapshot(query(collection(db, "users", uid, "rooms"), orderBy("joinedAt", "desc")),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))), onErr);
}

export async function createRoom(name, displayName) {
  name = cleanName(name, "Room");
  for (let attempt = 0; ; attempt++) {
    const id = doc(collection(db, "rooms")).id;
    const code = genCode();
    const b = writeBatch(db);
    b.set(roomRef(id), { name, ownerId: uid, code, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b.set(memberRef(id, uid), { name: cleanName(displayName), code, role: "owner", joinedAt: serverTimestamp() });
    b.set(inviteRef(code), { roomId: id, createdAt: serverTimestamp() });
    b.set(myRoomRef(id), { name, role: "owner", joinedAt: serverTimestamp() });
    try { await b.commit(); return id; }
    catch (e) { if (e.code !== "permission-denied" || attempt >= 3) throw e; } // kode bentrok → coba kode lain
  }
}

export async function joinRoom(rawCode, displayName) {
  const code = normalizeCode(rawCode);
  if (code.length !== 8) throw new Error("Kode undangan harus 8 karakter.");
  const inv = await getDocFromServer(inviteRef(code));
  if (!inv.exists()) throw new Error("Kode undangan tidak valid atau sudah diganti pemilik room.");
  const roomId = inv.get("roomId");

  // Sudah anggota? (hanya anggota yang bisa membaca room)
  try {
    const r = await getDocFromServer(roomRef(roomId));
    if (r.exists()) {
      await setDoc(myRoomRef(roomId), { name: r.get("name"), role: r.get("ownerId") === uid ? "owner" : "member", joinedAt: serverTimestamp() });
      return roomId;
    }
  } catch (e) { if (e.code !== "permission-denied") throw e; }

  const b = writeBatch(db);
  b.set(memberRef(roomId, uid), { name: cleanName(displayName), code, role: "member", joinedAt: serverTimestamp() });
  b.set(myRoomRef(roomId), { name: "Room", role: "member", joinedAt: serverTimestamp() });
  try { await b.commit(); }
  catch (e) { if (e.code === "permission-denied") throw new Error("Kode undangan tidak valid atau sudah diganti pemilik room."); throw e; }
  try { const r = await getDocFromServer(roomRef(roomId)); await updateDoc(myRoomRef(roomId), { name: r.get("name") }); } catch {}
  return roomId;
}

export const watchRoom = (id, cb, onErr) =>
  onSnapshot(roomRef(id), (s) => cb(s.exists() ? { id: s.id, ...s.data({ serverTimestamps: "estimate" }) } : null), onErr);

export const watchMembers = (id, cb, onErr) =>
  onSnapshot(query(collection(db, "rooms", id, "members"), orderBy("joinedAt", "asc")),
    (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data({ serverTimestamps: "estimate" }) }))), onErr);

export const watchItems = (id, cb, onErr) =>
  onSnapshot(query(itemsCol(id), orderBy("createdAt", "desc"), limit(ROOM_LIMITS.feed)),
    (s) => cb(s.docs.map((d) => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: "estimate" }) }))), onErr);

/**
 * Kirim ke feed room. Untuk pesan terenkripsi: text = "" dan enc = hasil encryptWithPassword,
 * plus hint (petunjuk password, opsional, terlihat semua anggota).
 * Mengembalikan { id, done } — id tersedia langsung, done selesai saat server mengonfirmasi.
 */
export function sendItem(roomId, text, displayName, { enc = null, hint = "" } = {}) {
  if (!enc && text.length > ROOM_LIMITS.text) throw new Error(`Maksimal ${ROOM_LIMITS.text.toLocaleString("id-ID")} karakter per kiriman.`);
  const ref = doc(itemsCol(roomId));
  const data = enc
    ? { text: "", enc, hint: String(hint || "").slice(0, 100), uid, name: cleanName(displayName), createdAt: serverTimestamp() }
    : { text, uid, name: cleanName(displayName), createdAt: serverTimestamp() };
  return { id: ref.id, done: setDoc(ref, data) };
}
export const deleteItem = (roomId, itemId) => deleteDoc(doc(itemsCol(roomId), itemId));

export async function leaveRoom(roomId) {
  const b = writeBatch(db);
  b.delete(memberRef(roomId, uid));
  b.delete(myRoomRef(roomId));
  await b.commit();
}
/** Hapus room dari daftar saya (mis. setelah dikeluarkan / room dihapus). */
export const forgetRoom = (roomId) => deleteDoc(myRoomRef(roomId)).catch(() => {});

export async function rotateCode(roomId, oldCode) {
  for (let attempt = 0; ; attempt++) {
    const code = genCode();
    const b = writeBatch(db);
    b.update(roomRef(roomId), { code, updatedAt: serverTimestamp() });
    b.set(inviteRef(code), { roomId, createdAt: serverTimestamp() });
    if (oldCode) b.delete(inviteRef(oldCode));
    try { await b.commit(); return code; }
    catch (e) { if (e.code !== "permission-denied" || attempt >= 3) throw e; }
  }
}

/** Keluarkan anggota lalu ganti kode undangan agar tidak bisa masuk lagi dengan kode lama. */
export async function kickMember(roomId, memberUid, oldCode) {
  await deleteDoc(memberRef(roomId, memberUid));
  return rotateCode(roomId, oldCode);
}

export async function renameRoom(roomId, name) {
  name = cleanName(name, "Room");
  await updateDoc(roomRef(roomId), { name, updatedAt: serverTimestamp() });
  await setDoc(myRoomRef(roomId), { name }, { merge: true });
  return name;
}

export async function deleteRoom(roomId, code) {
  // Hapus feed dalam beberapa batch (maks 500 operasi per batch)
  for (;;) {
    const s = await getDocs(query(itemsCol(roomId), limit(400)));
    if (s.empty) break;
    const b = writeBatch(db);
    s.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  const mem = await getDocs(collection(db, "rooms", roomId, "members"));
  const b = writeBatch(db);
  if (code) b.delete(inviteRef(code));
  mem.docs.forEach((d) => { if (d.id !== uid) b.delete(d.ref); });
  b.delete(memberRef(roomId, uid));
  b.delete(roomRef(roomId));
  b.delete(myRoomRef(roomId));
  await b.commit();
}
