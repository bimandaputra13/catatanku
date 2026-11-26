// Entry point: setup, router, shell aplikasi, halaman autentikasi.
import { firebaseConfig } from "./firebase-config.js";
import { html, setHTML, icon, $, $$, toast, confirmDialog, closeModal, esc } from "./ui.js";

const app = document.getElementById("app");
const isConfigured = firebaseConfig.apiKey && !/^GANTI/.test(firebaseConfig.apiKey);

// ---------------------------------------------------------------------------
// Tema (light / dark)
// ---------------------------------------------------------------------------
const THEME_KEY = "catatku-theme";
const mql = window.matchMedia("(prefers-color-scheme: dark)");
function getPref() { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } }
function applyTheme() {
  const pref = getPref();
  const dark = pref === "dark" || (pref === "system" && mql.matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  $$("[data-theme-icon]").forEach((u) => u.setAttribute("href", dark ? "#i-sun" : "#i-moon"));
}
export function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  try { localStorage.setItem(THEME_KEY, dark ? "light" : "dark"); } catch {}
  document.documentElement.classList.add("theme-anim");
  applyTheme();
  setTimeout(() => document.documentElement.classList.remove("theme-anim"), 400);
}
mql.addEventListener?.("change", applyTheme);

const themeBtn = () => html`<button class="icon-btn" data-action="theme" title="Ganti tema (terang/gelap)" aria-label="Ganti tema">
  <svg class="i" aria-hidden="true"><use data-theme-icon href="${document.documentElement.getAttribute("data-theme") === "dark" ? "#i-sun" : "#i-moon"}"></use></svg></button>`;

document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="theme"]')) toggleTheme();
});

// ---------------------------------------------------------------------------
// Belum dikonfigurasi → tampilkan panduan
// ---------------------------------------------------------------------------
function renderSetup() {
  setHTML(app, html`
    <div class="auth-wrap"><div class="auth-card setup">
      <div class="brand big">${icon("logo")} <span>Catatku</span></div>
      <h2>Konfigurasi Firebase belum diisi</h2>
      <ol>
        <li>Buat project di <b>console.firebase.google.com</b> (paket Spark / gratis).</li>
        <li>Aktifkan <b>Authentication → Email/Password</b>.</li>
        <li>Buat <b>Firestore Database</b>, lalu publikasikan isi file <code>firestore.rules</code>.</li>
        <li>Tambahkan Web App, salin config ke <code>js/firebase-config.js</code>.</li>
        <li>Tambahkan domain GitHub Pages Anda di <b>Authentication → Settings → Authorized domains</b>.</li>
      </ol>
      <p class="muted">Panduan lengkap ada di README.md.</p>
    </div></div>`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let fb, store;
let currentUser = null;
let authResolved = false;
let cleanup = null;
let routeToken = 0;

async function boot() {
  try {
    fb = await import("./firebase.js");
    store = await import("./store.js");
  } catch (e) {
    console.error(e);
    setHTML(app, html`<div class="auth-wrap"><div class="auth-card"><h2>Gagal memuat aplikasi</h2>
      <p class="muted">Periksa koneksi internet Anda lalu muat ulang halaman.</p>
      <button class="btn btn-primary">Muat ulang</button></div></div>`);
    $(".auth-card .btn", app).onclick = () => location.reload();
    return;
  }
  fb.onAuthStateChanged(fb.auth, (user) => {
    const changed = (user?.uid || null) !== (currentUser?.uid || null);
    currentUser = user;
    authResolved = true;
    if (changed) {
      if (user) store.startStore(user.uid);
      else store.stopStore();
      shellMounted = false;
    }
    route();
  });
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", globalKeys);
}

function globalKeys(e) {
  if (!currentUser) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); go("#/search"); return; }
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === "/") { e.preventDefault(); go("#/search"); }
    else if (e.key.toLowerCase() === "n" && document.getElementById("modal-root").childElementCount === 0) { e.preventDefault(); go("#/note/new"); }
  }
}

export function go(hash, replace = false) {
  if (replace) { history.replaceState(null, "", hash); route(); }
  else if (location.hash === hash) route();
  else location.hash = hash;
}
export const getUser = () => currentUser;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { path, params: new URLSearchParams(qs || "") };
}

let shellMounted = false;

async function route() {
  if (!authResolved) return;
  const token = ++routeToken;
  const { path, params } = parseHash();
  const publicPaths = ["/login", "/register", "/forgot"];

  if (!currentUser) {
    if (!publicPaths.includes(path)) { history.replaceState(null, "", "#/login"); return renderAuth("/login"); }
    return renderAuth(path);
  }
  if (publicPaths.includes(path)) { history.replaceState(null, "", "#/"); return route(); }

  closeModal();
  // Cleanup halaman sebelumnya (mis. simpan catatan yang belum tersimpan)
  if (cleanup) { const c = cleanup; cleanup = null; try { await c(); } catch (e) { console.error(e); } }
  if (token !== routeToken) return;

  mountShell();
  const view = $("#view");
  const navKey = path.startsWith("/note") ? "" : path === "/" ? "home" : path.slice(1);
  $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));

  let mod, name;
  const m = path.match(/^\/note\/([\w-]+)$/);
  try {
    if (path === "/") { mod = await import("./views/dashboard.js"); name = "dashboard"; }
    else if (path === "/search") { mod = await import("./views/search.js"); name = "search"; }
    else if (path === "/live") { mod = await import("./views/live.js"); name = "live"; }
    else if (m) { mod = await import("./views/note.js"); name = "note"; }
    else { history.replaceState(null, "", "#/"); return route(); }
  } catch (e) {
    console.error(e);
    toast("Gagal memuat halaman. Periksa koneksi.", "error");
    return;
  }
  if (token !== routeToken) return;

  const swap = () => {
    view.replaceChildren();
    view.className = `view view-${name}`;
    cleanup = mod.mount(view, { params, id: m?.[1], user: currentUser, store, fb, go }) || null;
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(swap);
  } else swap();
}

// ---------------------------------------------------------------------------
// Shell (header + navigasi)
// ---------------------------------------------------------------------------
function initials(u) {
  const n = (u.displayName || u.email || "?").trim();
  return n.split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function mountShell() {
  if (shellMounted && $("#view")) return;
  shellMounted = true;
  const u = currentUser;
  setHTML(app, html`
    <header class="topbar">
      <div class="topbar-inner">
        <a href="#/" class="brand">${icon("logo")} <span>Catatku</span></a>
        <nav class="nav-desktop">
          <a href="#/" data-nav="home">${icon("home")} Beranda</a>
          <a href="#/live" data-nav="live">${icon("live")} Live Pad</a>
        </nav>
        <button class="search-trigger" data-go="#/search">${icon("search")} <span>Cari catatan…</span> <kbd>Ctrl K</kbd></button>
        <div class="topbar-actions">
          <button class="icon-btn only-mobile" data-go="#/search" aria-label="Cari">${icon("search")}</button>
          ${themeBtn()}
          <button class="btn btn-primary only-desktop" data-go="#/note/new">${icon("plus")} Catatan baru</button>
          <div class="menu-wrap">
            <button class="avatar" id="avatar-btn" aria-haspopup="menu" aria-expanded="false" title="Akun">${initials(u)}</button>
            <div class="menu" id="user-menu" role="menu" hidden>
              <div class="menu-head"><b>${u.displayName || "Pengguna"}</b><span>${u.email}</span></div>
              ${!u.emailVerified ? html`<button role="menuitem" data-action="verify">${icon("mail")} Kirim email verifikasi</button>` : ""}
              <button role="menuitem" data-action="reset">${icon("key")} Ganti password akun</button>
              <button role="menuitem" data-action="logout" class="danger">${icon("logout")} Keluar</button>
            </div>
          </div>
        </div>
      </div>
    </header>
    ${!u.emailVerified ? html`<div class="banner" id="verify-banner">${icon("mail")} <span>Email belum terverifikasi. Cek inbox Anda untuk mengamankan akun.</span>
      <button class="link" data-action="verify">Kirim ulang</button><button class="icon-btn sm" data-action="hide-banner" aria-label="Tutup">${icon("x")}</button></div>` : ""}
    <main id="view" class="view"></main>
    <nav class="nav-mobile">
      <a href="#/" data-nav="home">${icon("home")}<span>Beranda</span></a>
      <a href="#/search" data-nav="search">${icon("search")}<span>Cari</span></a>
      <a href="#/note/new" class="fab" aria-label="Catatan baru">${icon("plus")}</a>
      <a href="#/live" data-nav="live">${icon("live")}<span>Live</span></a>
      <button data-action="menu-mobile">${icon("more")}<span>Akun</span></button>
    </nav>`);

  $("#avatar-btn").onclick = (e) => { e.stopPropagation(); toggleMenu(); };
}

function toggleMenu(show) {
  const menu = $("#user-menu");
  if (!menu) return;
  const open = show ?? menu.hidden;
  menu.hidden = !open;
  $("#avatar-btn")?.setAttribute("aria-expanded", String(open));
}

// Event delegation shell (didaftarkan sekali saja)
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap") && !e.target.closest('[data-action="menu-mobile"]')) toggleMenu(false);
});
app.addEventListener("click", async (e) => {
    if (!currentUser) return;
    const goEl = e.target.closest("[data-go]");
    if (goEl) { go(goEl.dataset.go); return; }
    const act = e.target.closest("[data-action]")?.dataset.action;
    if (!act) return;
    if (act === "menu-mobile") { e.stopPropagation(); toggleMenu(); }
    if (act === "hide-banner") $("#verify-banner")?.remove();
    if (act === "verify") {
      toggleMenu(false);
      try { await fb.sendEmailVerification(fb.auth.currentUser); toast("Email verifikasi terkirim.", "success"); }
      catch (err) { toast(authError(err), "error"); }
    }
    if (act === "reset") {
      toggleMenu(false);
      const ok = await confirmDialog({ title: "Ganti password akun", message: `Link untuk mengganti password akan dikirim ke ${currentUser.email}.`, okText: "Kirim link" });
      if (!ok) return;
      try { await fb.sendPasswordResetEmail(fb.auth, currentUser.email); toast("Link ganti password terkirim. Cek email Anda.", "success"); }
      catch (err) { toast(authError(err), "error"); }
    }
    if (act === "logout") { toggleMenu(false); logout(); }
});

async function logout() {
  const ok = await confirmDialog({ title: "Keluar?", message: "Data cache di perangkat ini akan dibersihkan.", okText: "Keluar" });
  if (!ok) return;
  try { if (cleanup) { const c = cleanup; cleanup = null; await c(); } } catch {}
  try {
    store.stopStore();
    await fb.signOut(fb.auth);
    await fb.terminate(fb.db);
    await fb.clearIndexedDbPersistence(fb.db);
  } catch (e) { console.warn(e); }
  location.replace(location.pathname + "#/login");
  location.reload();
}

// ---------------------------------------------------------------------------
// Halaman autentikasi
// ---------------------------------------------------------------------------
export function authError(err) {
  const code = err?.code || "";
  const map = {
    "auth/invalid-email": "Format email tidak valid.",
    "auth/missing-password": "Masukkan password.",
    "auth/invalid-credential": "Email atau password salah.",
    "auth/wrong-password": "Email atau password salah.",
    "auth/user-not-found": "Email atau password salah.",
    "auth/user-disabled": "Akun ini dinonaktifkan.",
    "auth/email-already-in-use": "Email sudah terdaftar. Silakan masuk.",
    "auth/weak-password": "Password terlalu lemah (minimal 8 karakter).",
    "auth/password-does-not-meet-requirements": "Password belum memenuhi syarat keamanan.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi beberapa saat lagi.",
    "auth/network-request-failed": "Koneksi bermasalah. Periksa internet Anda.",
    "auth/operation-not-allowed": "Login Email/Password belum diaktifkan di Firebase Console.",
    "auth/unauthorized-domain": "Domain ini belum diizinkan di Firebase (Authorized domains).",
    "auth/missing-email": "Masukkan email.",
  };
  return map[code] || "Terjadi kesalahan. Silakan coba lagi.";
}

function passwordScore(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}

function renderAuth(path) {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  shellMounted = false;
  const mode = path === "/register" ? "register" : path === "/forgot" ? "forgot" : "login";
  const titles = {
    login: ["Selamat datang kembali", "Masuk untuk melanjutkan catatan Anda."],
    register: ["Buat akun baru", "Gratis. Catatan Anda tersinkron di semua perangkat."],
    forgot: ["Lupa password", "Kami akan mengirim link reset ke email Anda."],
  };
  setHTML(app, html`
    <div class="auth-wrap">
      <div class="auth-corner">${themeBtn()}</div>
      <section class="auth-hero">
        <div class="brand big">${icon("logo")} <span>Catatku</span></div>
        <h1>Semua catatan,<br><span class="grad">satu tempat.</span></h1>
        <ul class="hero-points">
          <li>${icon("sync")} Sinkron realtime antar perangkat</li>
          <li>${icon("shield")} Kunci catatan dengan enkripsi end-to-end</li>
          <li>${icon("clip")} Simpan gambar, dokumen &amp; zip</li>
          <li>${icon("live")} Live Pad untuk copy–paste antar device</li>
        </ul>
      </section>
      <section class="auth-card">
        <div class="brand only-mobile">${icon("logo")} <span>Catatku</span></div>
        <h2>${titles[mode][0]}</h2>
        <p class="muted">${titles[mode][1]}</p>
        <form id="auth-form" class="stack" novalidate>
          ${mode === "register" ? html`<label class="field"><span>Nama</span>
            <input name="name" autocomplete="name" maxlength="60" required placeholder="Nama Anda"></label>` : ""}
          <label class="field"><span>Email</span>
            <input name="email" type="email" autocomplete="email" required placeholder="nama@email.com" autofocus></label>
          ${mode !== "forgot" ? html`<label class="field"><span>Password</span>
            <div class="pw-wrap"><input name="password" type="password" required minlength="${mode === "register" ? 8 : 1}"
              autocomplete="${mode === "register" ? "new-password" : "current-password"}" placeholder="${mode === "register" ? "Minimal 8 karakter" : "Password"}">
            <button type="button" class="icon-btn sm" data-pw-toggle aria-label="Tampilkan password">${icon("eye")}</button></div></label>` : ""}
          ${mode === "register" ? html`
            <div class="strength" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <label class="field"><span>Ulangi password</span>
              <input name="password2" type="password" autocomplete="new-password" required></label>` : ""}
          ${mode === "login" ? html`<a class="link right" href="#/forgot">Lupa password?</a>` : ""}
          <p class="form-error" hidden></p>
          <button class="btn btn-primary btn-block btn-lg" type="submit">
            ${mode === "login" ? "Masuk" : mode === "register" ? "Daftar" : "Kirim link reset"}</button>
        </form>
        <p class="auth-switch">
          ${mode === "login" ? html`Belum punya akun? <a href="#/register">Daftar sekarang</a>`
            : html`Sudah punya akun? <a href="#/login">Masuk</a>`}
        </p>
      </section>
    </div>`);

  const form = $("#auth-form");
  const err = $(".form-error", form);
  const btn = $('button[type="submit"]', form);
  const showErr = (m) => { err.textContent = m; err.hidden = !m; };

  $("[data-pw-toggle]", form)?.addEventListener("click", () => {
    const inp = form.password;
    inp.type = inp.type === "password" ? "text" : "password";
  });
  if (mode === "register") {
    const bars = $$(".strength i", form);
    form.password.addEventListener("input", () => {
      const s = form.password.value ? passwordScore(form.password.value) : 0;
      bars.forEach((b, i) => { b.className = i < s ? `on s${s}` : ""; });
    });
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    showErr("");
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr("Format email tidak valid.");
    btn.disabled = true; btn.classList.add("loading");
    try {
      if (mode === "login") {
        await fb.signInWithEmailAndPassword(fb.auth, email, form.password.value);
        location.hash = "#/";
      } else if (mode === "register") {
        const name = form.name.value.trim();
        const pw = form.password.value;
        if (!name) throw { message: "Masukkan nama Anda." };
        if (pw.length < 8) throw { message: "Password minimal 8 karakter." };
        if (passwordScore(pw) < 2) throw { message: "Password terlalu lemah. Kombinasikan huruf besar/kecil, angka, atau simbol." };
        if (pw !== form.password2.value) throw { message: "Konfirmasi password tidak sama." };
        const cred = await fb.createUserWithEmailAndPassword(fb.auth, email, pw);
        await fb.updateProfile(cred.user, { displayName: name.slice(0, 60) });
        try { await fb.sendEmailVerification(cred.user); } catch {}
        toast(`Akun dibuat. Selamat datang, ${name}!`, "success");
        shellMounted = false;
        location.hash = "#/";
        route();
      } else {
        await fb.sendPasswordResetEmail(fb.auth, email);
        toast("Jika email terdaftar, link reset telah dikirim.", "success", 5000);
        location.hash = "#/login";
      }
    } catch (ex) {
      showErr(ex?.code ? authError(ex) : ex?.message || "Terjadi kesalahan.");
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  };
}

// Peringatan jika menutup tab saat ada perubahan yang belum tersimpan
window.addEventListener("beforeunload", (e) => {
  if (window.__catatkuDirty) { e.preventDefault(); e.returnValue = ""; }
});

export { esc };

// Mulai aplikasi
if (isConfigured) boot();
else renderSetup();
