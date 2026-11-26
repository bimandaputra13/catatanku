// Enkripsi end-to-end untuk catatan terkunci (Web Crypto API).
//
// Desain:
//  - Setiap catatan terkunci punya Data Encryption Key (DEK) acak AES-256-GCM.
//  - DEK dibungkus (di-enkripsi) memakai Key Encryption Key (KEK) yang diturunkan
//    dari password catatan dengan PBKDF2-SHA256 (600.000 iterasi, salt acak 16 byte).
//  - Konten & lampiran dienkripsi dengan DEK. Server/Firestore hanya menyimpan ciphertext.
//  - Ganti password cukup membungkus ulang DEK, tanpa mengenkripsi ulang file.
//  - Password salah terdeteksi lewat kegagalan autentikasi AES-GCM.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const PBKDF2_ITER = 600000;

export function b64encode(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
export function b64decode(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function deriveKek(password, salt, iter) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
const importDek = (raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

/** Buat kunci baru untuk catatan. Mengembalikan { lock (untuk disimpan), key (DEK CryptoKey) }. */
export async function createLock(password) {
  const salt = rand(16);
  const dekRaw = rand(32);
  const kek = await deriveKek(password, salt, PBKDF2_ITER);
  const iv = rand(12);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, dekRaw));
  const key = await importDek(dekRaw);
  dekRaw.fill(0);
  return { lock: { v: 1, salt: b64encode(salt), iter: PBKDF2_ITER, iv: b64encode(iv), w: b64encode(wrapped) }, key };
}

async function unwrapRaw(lock, password) {
  const kek = await deriveKek(password, b64decode(lock.salt), lock.iter || PBKDF2_ITER);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(lock.iv) }, kek, b64decode(lock.w)));
  } catch {
    const e = new Error("Password salah.");
    e.code = "bad-password";
    throw e;
  }
}

/** Buka kunci catatan → DEK CryptoKey. Melempar error code "bad-password" jika salah. */
export async function unlockKey(lock, password) {
  const raw = await unwrapRaw(lock, password);
  const key = await importDek(raw);
  raw.fill(0);
  return key;
}

/** Ganti password: bungkus ulang DEK yang sama dengan password baru. */
export async function rewrapLock(lock, oldPassword, newPassword) {
  const raw = await unwrapRaw(lock, oldPassword);
  const salt = rand(16);
  const kek = await deriveKek(newPassword, salt, PBKDF2_ITER);
  const iv = rand(12);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw));
  raw.fill(0);
  return { v: 1, salt: b64encode(salt), iter: PBKDF2_ITER, iv: b64encode(iv), w: b64encode(wrapped) };
}

export async function encryptText(key, text) {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text)));
  return { iv: b64encode(iv), d: b64encode(ct) };
}
export async function decryptText(key, payload) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(payload.iv) }, key, b64decode(payload.d));
  return dec.decode(pt);
}
export async function encryptBytes(key, u8) {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, u8));
  return { iv: b64encode(iv), data: ct };
}
export async function decryptBytes(key, ivB64, u8) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivB64) }, key, u8));
}
