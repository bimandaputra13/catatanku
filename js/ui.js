// Utilitas UI: templating aman (auto-escape), toast, modal, format, dll.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);

function renderVal(v) {
  if (v == null || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join("");
  return esc(v);
}

/** Tagged template: semua nilai interpolasi di-escape kecuali dibungkus raw()/html``. */
export function html(strings, ...vals) {
  let out = "";
  strings.forEach((str, i) => { out += str + (i < vals.length ? renderVal(vals[i]) : ""); });
  return new Raw(out);
}

export function setHTML(el, content) { el.innerHTML = content instanceof Raw ? content.s : esc(content); }

export const icon = (name, cls = "") => raw(`<svg class="i ${esc(cls)}" aria-hidden="true"><use href="#i-${esc(name)}"></use></svg>`);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ---------- Toast ----------
export function toast(msg, type = "info", ms = 3200) {
  const root = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  const ic = type === "error" ? "x" : type === "success" ? "check" : "note";
  setHTML(el, html`${icon(ic)}<span></span>`);
  el.querySelector("span").textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const close = () => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); };
  const timer = setTimeout(close, ms);
  el.addEventListener("click", () => { clearTimeout(timer); close(); });
  return { close, set: (m) => { el.querySelector("span").textContent = m; } };
}

// ---------- Modal ----------
let modalOpen = null;
export function openModal(content, { onClose, wide = false, sheet = false } = {}) {
  closeModal();
  const root = document.getElementById("modal-root");
  const wrap = document.createElement("div");
  wrap.className = `modal-backdrop${sheet ? " is-sheet" : ""}`;
  wrap.innerHTML = `<div class="modal ${wide ? "modal-wide" : ""} ${sheet ? "sheet" : ""}" role="dialog" aria-modal="true"></div>`;
  const box = wrap.firstElementChild;
  setHTML(box, content);
  root.appendChild(wrap);
  const prevFocus = document.activeElement;
  requestAnimationFrame(() => wrap.classList.add("show"));
  const close = (result) => {
    if (modalOpen !== api) return;
    modalOpen = null;
    document.removeEventListener("keydown", onKey, true);
    wrap.classList.remove("show");
    setTimeout(() => wrap.remove(), 200);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch {}
    onClose && onClose(result);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
  document.addEventListener("keydown", onKey, true);
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(null); });
  const api = { el: box, close };
  modalOpen = api;
  const first = box.querySelector("[autofocus], input, textarea, button");
  setTimeout(() => first && first.focus(), 50);
  return api;
}
export function closeModal() { if (modalOpen) modalOpen.close(null); }

export function confirmDialog({ title, message, okText = "Ya", cancelText = "Batal", danger = false }) {
  return new Promise((resolve) => {
    const m = openModal(html`
      <h3 class="modal-title">${title}</h3>
      <p class="modal-text">${message}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="cancel">${cancelText}</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok" autofocus>${okText}</button>
      </div>`, { onClose: (r) => resolve(r === true) });
    m.el.querySelector('[data-act="cancel"]').onclick = () => m.close(false);
    m.el.querySelector('[data-act="ok"]').onclick = () => m.close(true);
  });
}

/**
 * Dialog password. mode: "unlock" | "set" | "change".
 * Mengembalikan {password, newPassword?} atau null jika dibatalkan.
 */
export function passwordDialog({ title, message = "", mode = "unlock", okText = "Lanjut", onSubmit = null }) {
  return new Promise((resolve) => {
    const needCurrent = mode === "unlock" || mode === "change";
    const needNew = mode === "set" || mode === "change";
    const m = openModal(html`
      <form class="stack" novalidate>
        <h3 class="modal-title">${icon("lock")} ${title}</h3>
        ${message ? html`<p class="modal-text">${message}</p>` : ""}
        ${needCurrent ? html`<label class="field"><span>${mode === "change" ? "Password saat ini" : "Password catatan"}</span>
          <input type="password" name="cur" autocomplete="off" required autofocus></label>` : ""}
        ${needNew ? html`<label class="field"><span>Password baru (min. 6 karakter)</span>
          <input type="password" name="new1" autocomplete="new-password" minlength="6" required ${mode === "set" ? raw("autofocus") : ""}></label>
          <label class="field"><span>Ulangi password baru</span>
          <input type="password" name="new2" autocomplete="new-password" required></label>` : ""}
        <p class="form-error" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-act="cancel">Batal</button>
          <button type="submit" class="btn btn-primary">${okText}</button>
        </div>
      </form>`, { onClose: (r) => resolve(r || null) });
    const form = m.el.querySelector("form");
    const err = form.querySelector(".form-error");
    const showErr = (t) => { err.textContent = t; err.hidden = false; };
    form.querySelector('[data-act="cancel"]').onclick = () => m.close(null);
    const submitBtn = form.querySelector('button[type="submit"]');
    let busy = false;
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const cur = form.cur?.value ?? "";
      const n1 = form.new1?.value ?? "";
      const n2 = form.new2?.value ?? "";
      if (needCurrent && !cur) return showErr("Masukkan password.");
      if (needNew) {
        if (n1.length < 6) return showErr("Password baru minimal 6 karakter.");
        if (n1 !== n2) return showErr("Konfirmasi password tidak sama.");
        if (mode === "change" && n1 === cur) return showErr("Password baru harus berbeda.");
      }
      const values = { password: cur, newPassword: n1 };
      if (!onSubmit) return m.close(values);
      busy = true; err.hidden = true;
      submitBtn.disabled = true; submitBtn.classList.add("loading");
      try {
        const result = await onSubmit(values);
        m.close({ ...values, result });
      } catch (ex) {
        showErr(ex?.message || "Terjadi kesalahan.");
        const f = form.cur || form.new1;
        if (f) { f.select(); f.focus(); }
      } finally {
        busy = false; submitBtn.disabled = false; submitBtn.classList.remove("loading");
      }
    };
  });
}

// ---------- Format ----------
export function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds != null) return ts.seconds * 1000;
  return 0;
}

const rtf = typeof Intl !== "undefined" && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat("id", { numeric: "auto" }) : null;
export function timeAgo(ms) {
  if (!ms) return "";
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "baru saja";
  if (!rtf) return new Date(ms).toLocaleString("id-ID");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(ms).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

export function formatBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function normalize(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Hapus sintaks markdown sederhana untuk cuplikan kartu. */
export function plainText(md) {
  return String(md || "")
    .replace(/```[\w+-]*/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "Perangkat";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} · ${os}`;
}

/** Terapkan teks dari perangkat lain ke textarea tanpa melompatkan kursor. */
export function applyRemoteText(ta, next) {
  const prev = ta.value;
  if (prev === next) return;
  const focused = document.activeElement === ta;
  const s = ta.selectionStart, e = ta.selectionEnd, scroll = ta.scrollTop;
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev[p] === next[p]) p++;
  let q = 0;
  while (q < max - p && prev[prev.length - 1 - q] === next[next.length - 1 - q]) q++;
  const map = (pos) => {
    if (pos <= p) return pos;
    if (pos >= prev.length - q) return pos + (next.length - prev.length);
    return next.length - q;
  };
  ta.value = next;
  if (focused) ta.setSelectionRange(map(s), map(e));
  ta.scrollTop = scroll;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

export function autoGrow(ta, min = 0) {
  ta.style.height = "auto";
  ta.style.height = Math.max(min, ta.scrollHeight + 2) + "px";
}

export function byteLength(str) { return new TextEncoder().encode(str).length; }
