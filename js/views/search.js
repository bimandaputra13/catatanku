// Pencarian seluruh catatan (judul, isi, tag, nama lampiran). Dilakukan di sisi klien
// karena Firestore tidak punya full-text search — data sudah ada di cache realtime.
import { html, setHTML, icon, $, $$, normalize, plainText, debounce } from "../ui.js";
import { noteCard, skeletonCards, emptyState, errorState } from "./components.js";

const PAGE = 48;

export function mount(root, { store, params }) {
  let q = params.get("q") || "";
  let filter = params.get("f") || "all";
  let tag = params.get("t") || "";
  let sort = "updated";
  let limit = PAGE;
  const index = new Map(); // id -> { key, hay }
  let firstRender = true;

  setHTML(root, html`
    <div class="search-head">
      <div class="search-box">
        ${icon("search")}
        <input id="q" type="search" placeholder="Cari judul, isi, tag, atau nama file…" autocomplete="off" spellcheck="false" aria-label="Cari catatan">
        <kbd class="only-desktop">Esc</kbd>
      </div>
      <div class="filters">
        <div class="chips" id="filters">
          <button class="chip" data-f="all">Semua</button>
          <button class="chip" data-f="pinned">${icon("pin")} Disematkan</button>
          <button class="chip" data-f="locked">${icon("lock")} Terkunci</button>
          <button class="chip" data-f="files">${icon("clip")} Berlampiran</button>
        </div>
        <select id="sort" class="select" aria-label="Urutkan">
          <option value="updated">Terakhir diubah</option>
          <option value="created">Terbaru dibuat</option>
          <option value="oldest">Terlama</option>
          <option value="title">Judul A–Z</option>
        </select>
      </div>
      <div class="chips tag-chips" id="tags"></div>
    </div>
    <p class="muted result-count" id="count"></p>
    <div id="results"><div class="grid">${skeletonCards(6)}</div></div>`);

  const input = $("#q", root);
  const results = $("#results", root);
  const count = $("#count", root);
  input.value = q;
  setTimeout(() => input.focus(), 60);

  const syncUrl = () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (filter !== "all") p.set("f", filter);
    if (tag) p.set("t", tag);
    const s = p.toString();
    history.replaceState(null, "", "#/search" + (s ? "?" + s : ""));
  };

  const hayOf = (n) => {
    const k = `${n._updated}|${n.title}|${n.locked}`;
    const cached = index.get(n.id);
    if (cached && cached.key === k) return cached.hay;
    const hay = normalize([n.title, n.locked ? "" : plainText(n.content), (n.tags || []).join(" "), (n.fileNames || []).join(" ")].join("\n"));
    index.set(n.id, { key: k, hay });
    return hay;
  };

  const render = () => {
    const s = store.getState();
    if (!s.ready) return;
    if (s.error) { setHTML(results, errorState(s.error)); return; }
    $$("#filters .chip", root).forEach((c) => c.classList.toggle("active", c.dataset.f === filter));

    // daftar tag
    const tagCount = new Map();
    s.notes.forEach((n) => (n.tags || []).forEach((t) => tagCount.set(t, (tagCount.get(t) || 0) + 1)));
    const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    setHTML($("#tags", root), html`${tags.map(([t, c]) =>
      html`<button class="chip chip-sm ${t === tag ? "active" : ""}" data-tag="${t}">#${t} <small>${c}</small></button>`)}`);

    const terms = normalize(q).split(/\s+/).filter(Boolean);
    let list = s.notes.filter((n) => {
      if (filter === "pinned" && !n.pinned) return false;
      if (filter === "locked" && !n.locked) return false;
      if (filter === "files" && !n.fileCount) return false;
      if (tag && !(n.tags || []).includes(tag)) return false;
      if (!terms.length) return true;
      const hay = hayOf(n);
      return terms.every((t) => hay.includes(t));
    });

    if (terms.length && sort === "updated") {
      // Relevansi: judul cocok diprioritaskan, lalu terbaru
      const score = (n) => { const t = normalize(n.title); return terms.reduce((a, w) => a + (t.includes(w) ? 2 : 0), 0); };
      list = list.map((n) => [score(n), n]).sort((a, b) => b[0] - a[0] || b[1]._updated - a[1]._updated).map((x) => x[1]);
    } else if (sort === "created") list = [...list].sort((a, b) => b._created - a._created);
    else if (sort === "oldest") list = [...list].sort((a, b) => a._updated - b._updated);
    else if (sort === "title") list = [...list].sort((a, b) => (a.title || "").localeCompare(b.title || "", "id"));

    count.textContent = terms.length || filter !== "all" || tag
      ? `${list.length} hasil ditemukan` : `${list.length} catatan`;

    if (!list.length) {
      setHTML(results, emptyState({
        iconName: "search",
        title: s.notes.length ? "Tidak ada hasil" : "Belum ada catatan",
        text: s.notes.length ? "Coba kata kunci lain atau ubah filter. Catatan terkunci hanya dicari dari judul & tag." : "Buat catatan pertama Anda.",
      }));
      return;
    }
    const shown = list.slice(0, limit);
    const animNext = firstRender;
    firstRender = false;
    setHTML(results, html`<div class="grid ${animNext ? "anim" : ""}">${shown.map((n) => noteCard(n, terms))}</div>
      ${list.length > limit ? html`<div class="center"><button class="btn btn-ghost" id="more">Muat lebih banyak (${list.length - limit})</button></div>` : ""}`);
    $("#more", results)?.addEventListener("click", () => { limit += PAGE; render(); });
  };

  const onInput = debounce(() => { q = input.value.trim(); limit = PAGE; syncUrl(); render(); }, 120);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (input.value) { input.value = ""; onInput(); } else location.hash = "#/"; }
    if (e.key === "Enter") { const first = $(".note-card", results); if (first) first.click(); }
  });
  $("#filters", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]"); if (!b) return;
    filter = b.dataset.f; limit = PAGE; syncUrl(); render();
  });
  $("#tags", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-tag]"); if (!b) return;
    tag = tag === b.dataset.tag ? "" : b.dataset.tag; limit = PAGE; syncUrl(); render();
  });
  $("#sort", root).addEventListener("change", (e) => { sort = e.target.value; render(); });

  const unsub = store.subscribe(render);
  render();
  return () => { unsub(); onInput.cancel(); };
}
