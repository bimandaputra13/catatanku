# Catatku — Catatan Serbaguna

Aplikasi web catatan yang modern, cepat, dan aman. Berupa situs statis (HTML/CSS/JS murni, tanpa build step) sehingga bisa di-host **gratis di GitHub Pages**, dengan backend **Firebase Authentication + Cloud Firestore (paket gratis Spark)**.

## Fitur

| Fitur | Keterangan |
|---|---|
| 🔐 Login & daftar | Email + password (Firebase Auth), lupa password, verifikasi email, indikator kekuatan password |
| 🗂️ Dashboard | Kartu catatan terbaru + catatan disematkan, warna kartu, tag, jumlah lampiran |
| 🔎 Pencarian | Cari di seluruh catatan (judul, isi, tag, nama file), filter (disematkan/terkunci/berlampiran), filter tag, urutan, highlight hasil. Shortcut `Ctrl K` atau `/` |
| ✍️ Editor | Autosave, Markdown (judul, tebal, miring, daftar, checklist yang bisa dicentang, kode, tautan, kutipan), mode Edit/Pratinjau, sinkron realtime antar perangkat |
| 📡 Live Pad | Satu area teks yang tersinkron realtime di semua perangkat yang login dengan akun sama, untuk copy–paste antar device |
| 📎 Lampiran | Gambar (jpg, png, gif, webp, svg, heic, …), dokumen (pdf, doc/x, xls/x, ppt/x, txt, csv, …), arsip (zip, rar, 7z, tar, gz). Maks 10 MB/file. Seret & lepas atau tempel dari clipboard |
| 🔒 Kunci catatan | Enkripsi **end-to-end** isi + lampiran memakai password per catatan (AES-256-GCM, PBKDF2-SHA256 600.000 iterasi). Terkunci otomatis setelah 10 menit tidak aktif |
| 🌗 Tema | Terang / gelap (ikut sistem secara default), transisi halus |
| 📱 Responsif | Desktop, tablet, ponsel (navigasi bawah + tombol tambah) |

## Keamanan

- **Isolasi data per pengguna**: `firestore.rules` hanya mengizinkan pengguna membaca/menulis `users/{uid}/…` miliknya sendiri. Semua path lain ditolak, dan setiap dokumen divalidasi bentuk & ukurannya.
- **Catatan terkunci terenkripsi di perangkat** sebelum dikirim. Firestore hanya menyimpan ciphertext, jadi admin project atau siapa pun yang mendapat akses database tetap tidak bisa membacanya. Password tidak pernah dikirim atau disimpan. Konsekuensinya, **password yang lupa tidak bisa dipulihkan**.
  - Setiap catatan punya kunci data acak (DEK) yang dibungkus oleh kunci turunan password (KEK). Ganti password cukup membungkus ulang DEK.
  - Judul & tag tetap terlihat (agar bisa dikenali di dashboard). Isi, nama file, dan isi file lampiran dienkripsi.
- **Anti-XSS**: semua teks pengguna di-escape; renderer Markdown buatan sendiri tidak mengizinkan HTML mentah dan hanya menerima link `http(s)`/`mailto`. Content-Security-Policy ketat di `index.html`.
- **Lampiran** selalu diunduh sebagai `application/octet-stream` dan tidak pernah dirender di origin aplikasi (mencegah serangan lewat file HTML/SVG).
- **Logout membersihkan cache lokal** (IndexedDB) di perangkat.
- Konfigurasi Firebase (`apiKey`, dll.) **memang publik** dan aman berada di frontend. Yang melindungi data adalah Security Rules.

## Setup (±10 menit)

### 1. Buat project Firebase
1. Buka https://console.firebase.google.com → **Add project** (Google Analytics tidak perlu).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable**.
3. **Build → Firestore Database → Create database** → pilih lokasi (mis. `asia-southeast2` Jakarta) → mode **production**.
4. Tab **Rules** di Firestore → hapus isinya, tempel seluruh isi file [`firestore.rules`](firestore.rules) → **Publish**.
5. **Project settings (ikon gear) → General → Your apps → Web (`</>`)** → daftarkan app (tanpa Hosting) → salin objek `firebaseConfig`.

### 2. Isi konfigurasi
Buka [`js/firebase-config.js`](js/firebase-config.js) dan ganti nilainya dengan config dari langkah 1.5.

### 3. Deploy ke GitHub Pages
```bash
git init
git add .
git commit -m "Catatku"
git branch -M main
git remote add origin https://github.com/USERNAME/catatku.git
git push -u origin main
```
Lalu di GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**. Situs akan aktif di `https://USERNAME.github.io/catatku/`.

### 4. Izinkan domain GitHub Pages di Firebase
**Authentication → Settings → Authorized domains → Add domain** → `USERNAME.github.io`.

Selesai. Buka situsnya, buat akun, dan mulai menulis.

### Hardening tambahan (disarankan)
- **Batasi API key**: Google Cloud Console → *APIs & Services → Credentials* → pilih *Browser key* → *Application restrictions: Websites* → tambahkan `https://USERNAME.github.io/*` (dan `http://localhost:*` untuk uji lokal).
- **Kebijakan password**: Authentication → Settings → *Password policy* (mis. minimal 8 karakter, wajib huruf & angka).
- **Proteksi enumerasi email** (aktif default di project baru): Authentication → Settings → *User actions*.
- Opsional: aktifkan **App Check** untuk mencegah penyalahgunaan kuota oleh bot (perlu menambahkan domain reCAPTCHA ke CSP).

## Uji lokal
Modul ES perlu disajikan lewat HTTP (bukan `file://`):
```bash
python -m http.server 8080
# buka http://localhost:8080
```
Tambahkan `localhost` di Authorized domains jika belum ada (biasanya sudah default).

## Batas paket gratis (Spark)
| Sumber daya | Kuota gratis | Catatan |
|---|---|---|
| Penyimpanan Firestore | 1 GiB | Termasuk lampiran |
| Baca dokumen | 50.000 / hari | Cache lokal mengurangi pembacaan berulang |
| Tulis dokumen | 20.000 / hari | Autosave memakai debounce (≈0,7 detik), Live Pad ≈0,25 detik |
| Hapus dokumen | 20.000 / hari | |

> **Kenapa lampiran disimpan di Firestore, bukan Firebase Storage?** Sejak Oktober 2024, Firebase Storage wajib memakai paket Blaze (berbayar). Agar tetap 100% gratis, file dipecah menjadi potongan ≤900 KB dan disimpan sebagai dokumen Firestore. Satu file 10 MB = ±12 dokumen tulis/baca.

## Struktur
```
index.html              Halaman utama, CSP, ikon SVG
assets/style.css        Tampilan (light/dark, responsif)
assets/icon.svg         Favicon
firestore.rules         Security rules (WAJIB dipublikasikan)
js/firebase-config.js   Konfigurasi project Firebase Anda
js/firebase.js          Inisialisasi Firebase SDK (CDN resmi gstatic)
js/app.js               Router, shell, halaman login/daftar
js/store.js             Akses data: catatan, lampiran, live pad
js/crypto.js            Enkripsi catatan terkunci (Web Crypto)
js/markdown.js          Renderer Markdown aman
js/ui.js                Utilitas UI (template aman, toast, modal)
js/views/*.js           Halaman: dashboard, pencarian, editor, live pad
```

## Model data Firestore
```
users/{uid}/notes/{noteId}                         title, content, tags, color, pinned, locked, lock, enc, fileCount, fileNames, createdAt, updatedAt
users/{uid}/notes/{noteId}/files/{fileId}          name, type, size, chunks, status, enc, iv, m, createdAt
users/{uid}/notes/{noteId}/files/{fileId}/chunks/{i}   i, d (bytes)
users/{uid}/live/pad                               text, device, session, updatedAt
```

## Catatan perilaku
- Sinkron realtime memakai strategi *last write wins*: jika dua perangkat mengetik di catatan yang sama **bersamaan**, simpanan terakhir yang dipakai. Perangkat yang sedang mengetik tidak tertimpa sampai berhenti mengetik.
- Catatan terkunci hanya bisa dicari lewat judul & tag (isinya terenkripsi).
- Saat offline, perubahan disimpan lokal dan dikirim otomatis begitu online.
