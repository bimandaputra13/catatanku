// Dashboard: sapaan, statistik, catatan disematkan & terbaru dalam bentuk kartu.
import { html, setHTML, icon, $ } from "../ui.js";
import { noteCard, skeletonCards, emptyState, errorState } from "./components.js";

const RECENT_LIMIT = 24;

function greeting() {
  const h = new Date().getHours();
  if (h < 11) return "Selamat pagi";
  if (h < 15) return "Selamat siang";
  if (h < 18) return "Selamat sore";
  return "Selamat malam";
}

export function mount(root, { store, user }) {
  const firstName = (user.displayName || "").split(/\s+/)[0] || "";
  setHTML(root, html`
    <section class="hero-row">
      <div>
        <h1 class="page-title">${greeting()}${firstName ? html`, <span class="grad">${firstName}</span>` : ""} 👋</h1>
        <p class="muted" id="dash-sub">Memuat catatan…</p>
      </div>
      <div class="quick">
        <a class="quick-card" href="#/note/new">${icon("plus")}<span><b>Catatan baru</b><small>Tekan N</small></span></a>
        <a class="quick-card" href="#/live">${icon("live")}<span><b>Live Pad</b><small>Salin antar device</small></span></a>
        <a class="quick-card" href="#/search">${icon("search")}<span><b>Cari</b><small>Ctrl K</small></span></a>
      </div>
    </section>
    <div id="dash-body"><div class="section"><div class="grid">${skeletonCards(6)}</div></div></div>`);

  const body = $("#dash-body", root);
  let first = true;
  const sub = $("#dash-sub", root);

  const render = (s) => {
    if (!s.ready) return;
    if (s.error) { setHTML(body, errorState(s.error)); sub.textContent = ""; return; }
    const notes = s.notes;
    const locked = notes.filter((n) => n.locked).length;
    const files = notes.reduce((a, n) => a + (n.fileCount || 0), 0);
    sub.textContent = notes.length
      ? `${notes.length} catatan · ${locked} terkunci · ${files} lampiran`
      : "Belum ada catatan. Yuk mulai menulis!";

    if (!notes.length) {
      setHTML(body, emptyState({
        title: "Mulai catatan pertama Anda",
        text: "Tulis ide, daftar tugas, simpan file, atau kunci catatan rahasia.",
        action: html`<a class="btn btn-primary" href="#/note/new">${icon("plus")} Buat catatan</a>`,
      }));
      return;
    }
    const pinned = notes.filter((n) => n.pinned);
    const recent = notes.filter((n) => !n.pinned).slice(0, RECENT_LIMIT);
    // Animasi masuk hanya saat render pertama (bukan setiap update realtime)
    const anim = first ? "anim" : "";
    first = false;
    setHTML(body, html`
      ${pinned.length ? html`<section class="section">
        <h2 class="section-title">${icon("pin")} Disematkan</h2>
        <div class="grid ${anim}">${pinned.map((n) => noteCard(n))}</div></section>` : ""}
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">Terbaru</h2>
          ${notes.length - pinned.length > RECENT_LIMIT ? html`<a class="link" href="#/search">Lihat semua →</a>` : ""}
        </div>
        ${recent.length ? html`<div class="grid ${anim}">${recent.map((n) => noteCard(n))}</div>` : html`<p class="muted">Semua catatan sedang disematkan.</p>`}
      </section>`);
  };

  const unsub = store.subscribe(render);
  render(store.getState());
  // Perbarui label waktu relatif tiap menit
  const timer = setInterval(() => render(store.getState()), 60000);
  return () => { unsub(); clearInterval(timer); };
}
