// Lapisan data: catatan (realtime), lampiran (dipecah per chunk di Firestore), live pad.
import {
  db, collection, doc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy,
  serverTimestamp, Bytes, writeBatch
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
