// Komponen bersama: kartu catatan, highlight pencarian, skeleton.
import { html, raw, esc, icon, timeAgo, plainText, normalize } from "../ui.js";

const SAFE_COLORS = new Set(["default", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]);
export const colorClass = (c) => `c-${SAFE_COLORS.has(c) ? c : "default"}`;

/** Normalisasi string sambil menyimpan peta indeks ke string asli. */
function normMap(str) {
  let n = "";
  const map = [];
  for (let i = 0; i < str.length; i++) {
    const c = normalize(str[i]);
    for (let k = 0; k < c.length; k++) { n += c[k]; map.push(i); }
  }
  map.push(str.length);
  return { n, map };
}

/** Kembalikan HTML aman dengan <mark> pada kata yang cocok. */
export function highlight(text, terms, { window: win = 0 } = {}) {
  text = String(text || "");
  if (!terms.length) return esc(win ? text.slice(0, win) + (text.length > win ? "…" : "") : text);
  const { n, map } = normMap(text);
  const ranges = [];
  for (const t of terms) {
    if (!t) continue;
    let idx = n.indexOf(t);
    while (idx !== -1 && ranges.length < 200) {
      ranges.push([map[idx], map[idx + t.length - 1] + 1]);
      idx = n.indexOf(t, idx + t.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let start = 0, end = text.length;
  if (win && text.length > win) {
    const first = ranges.length ? ranges[0][0] : 0;
    start = Math.max(0, first - Math.floor(win / 3));
    end = Math.min(text.length, start + win);
  }
  let out = start > 0 ? "…" : "";
  let pos = start;
  for (const [a, b] of ranges) {
    if (b <= pos || a >= end) continue;
    const s = Math.max(a, pos);
    out += esc(text.slice(pos, s)) + "<mark>" + esc(text.slice(s, Math.min(b, end))) + "</mark>";
    pos = Math.min(b, end);
  }
  out += esc(text.slice(pos, end)) + (end < text.length ? "…" : "");
  return out;
}

export function noteCard(n, terms = []) {
  const title = n.title?.trim() || "Tanpa judul";
  const body = n.locked
    ? html`<p class="snippet locked">${icon("lock")} Konten terkunci</p>`
    : html`<p class="snippet">${raw(highlight(plainText(n.content), terms, { window: 220 }))}</p>`;
  const tags = (n.tags || []).slice(0, 4);
  return html`
    <a class="note-card ${colorClass(n.color)}" href="#/note/${encodeURIComponent(n.id)}">
      <div class="card-top">
        <h3>${raw(highlight(title, terms))}</h3>
        ${n.pinned ? html`<span class="pin-badge" title="Disematkan">${icon("pin")}</span>` : ""}
      </div>
      ${body}
      ${tags.length ? html`<div class="tags">${tags.map((t) => html`<span class="tag">#${t}</span>`)}</div>` : ""}
      <div class="card-foot">
        <span>${timeAgo(n._updated)}</span>
        <span class="badges">
          ${n.locked ? html`<span title="Terkunci">${icon("lock")}</span>` : ""}
          ${n.fileCount ? html`<span title="${n.fileCount} lampiran">${icon("clip")}${n.fileCount}</span>` : ""}
        </span>
      </div>
    </a>`;
}

export const skeletonCards = (count = 6) =>
  html`${Array.from({ length: count }, () => html`<div class="note-card skeleton"><i></i><i></i><i></i><i></i></div>`)}`;

export function emptyState({ iconName = "note", title, text, action = "" }) {
  return html`<div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h3>${title}</h3>
    <p class="muted">${text}</p>
    ${action}
  </div>`;
}

export function errorState(err) {
  const perm = err?.code === "permission-denied";
  return emptyState({
    iconName: "x",
    title: perm ? "Akses ditolak" : "Gagal memuat data",
    text: perm ? "Periksa Firestore Security Rules sudah dipublikasikan sesuai file firestore.rules."
      : "Periksa koneksi internet Anda lalu muat ulang halaman.",
  });
}
