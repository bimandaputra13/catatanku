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
