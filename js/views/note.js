// Editor catatan: autosave, sinkron realtime antar perangkat, markdown, lampiran, kunci (E2E).
import {
  html, raw, setHTML, icon, $, $$, toast, confirmDialog, passwordDialog, openModal, debounce,
  timeAgo, formatBytes, autoGrow, applyRemoteText, byteLength, copyText, toMillis, esc
} from "../ui.js";
import { renderMarkdown, toggleTaskLine } from "../markdown.js";
import { createLock, unlockKey, rewrapLock, encryptText, decryptText } from "../crypto.js";
import { colorClass } from "./components.js";

const RELOCK_MS = 10 * 60 * 1000;
const MODE_KEY = "catatku-editor-mode";
const IMG_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif" };
const COLOR_LABEL = { default: "Default", red: "Merah", orange: "Oranye", yellow: "Kuning", green: "Hijau", teal: "Toska", blue: "Biru", purple: "Ungu", pink: "Merah muda" };

export function mount(root, ctx) {
  const { store, go } = ctx;
  const isNew = ctx.id === "new";
  const noteId = isNew ? store.newNoteId() : ctx.id;

  let created = !isNew;
  let alive = true;
  let deleting = false;
  let note = null;          // data terakhir dari server
  let key = null;           // DEK (hanya di memori) bila catatan terkunci & sudah dibuka
  let lastEnc = null;       // ciphertext terakhir yang sudah didekripsi
  let local = { title: "", content: "", tags: [], color: "default", pinned: false };
  let dirty = false;
  let pendingAcks = 0;
  let writeSeq = 0;
  let prepChain = Promise.resolve();
  let lastStatus = "";
  let editorMounted = false;
  let unsubNote = null, unsubFiles = null;
  let files = [];
  const uploads = new Map();
  const metaCache = new Map();
  const blobUrls = new Map();
  let thumbObserver = null;
  let relockTimer = null;
  let snapSeq = 0;
  let mode = (() => { try { return localStorage.getItem(MODE_KEY) || "edit"; } catch { return "edit"; } })();
  const docListeners = [];
  const onDoc = (type, fn, opts) => { document.addEventListener(type, fn, opts); docListeners.push([type, fn, opts]); };
  const onWin = (type, fn) => { window.addEventListener(type, fn); docListeners.push([type, fn, null, window]); };

  // ---------------------------------------------------------------- Awal
  if (isNew) {
    note = { locked: false };
    renderEditor();
  } else {
    const cached = store.getNote(noteId);
    if (cached && !cached.locked) { note = cached; local = pick(cached); renderEditor(); }
    else if (cached && cached.locked) { note = cached; renderLockScreen(); }
    else setHTML(root, html`<div class="note-loading"><div class="spinner"></div></div>`);
    startWatch();
  }

  function pick(d, content) {
    return {
      title: d.title || "", content: content ?? d.content ?? "", tags: Array.isArray(d.tags) ? [...d.tags] : [],
      color: d.color || "default", pinned: !!d.pinned,
    };
  }

  // ---------------------------------------------------------------- Realtime
  function startWatch() {
    if (unsubNote) return;
    unsubNote = store.watchNote(noteId, async (data, snap) => {
      if (!alive || deleting) return;
      const seq = ++snapSeq;
      if (!data) {
        if (created) renderMissing();
        return;
      }
      note = data;
      const pending = snap.metadata.hasPendingWrites;
      if (data.locked) {
        if (!key) { if (editorMounted || !$(".lock-screen", root)) renderLockScreen(); else updateLockTitle(); return; }
        if (pending) { updateChrome(); return; }
        let content = local.content;
        if (data.enc && data.enc.d !== lastEnc) {
          try { content = await decryptText(key, data.enc); }
          catch { key = null; renderLockScreen(); toast("Kunci catatan berubah. Masukkan password lagi.", "info"); return; }
          if (seq !== snapSeq || !alive) return;
          lastEnc = data.enc.d;
        }
        if (!editorMounted) { local = pick(data, content); renderEditor(); return; }
        applyRemote(pick(data, content));
      } else {
        if (key) { key = null; lastEnc = null; }
        if (!editorMounted) { local = pick(data); renderEditor(); return; }
        if (pending) { updateChrome(); return; }
        applyRemote(pick(data));
      }
    }, (err) => {
      console.error(err);
      if (err.code === "permission-denied") renderMissing();
      else toast("Gagal sinkron catatan. Periksa koneksi.", "error");
    });
  }

  function startFilesWatch() {
    if (unsubFiles || !created) return;
    unsubFiles = store.watchFiles(noteId, (list) => { files = list; renderFiles(); }, (e) => console.error(e));
  }
  function stopFilesWatch() { if (unsubFiles) unsubFiles(); unsubFiles = null; }

  /** Terapkan perubahan dari perangkat lain (jika kita tidak sedang mengetik). */
  function applyRemote(r) {
    if (dirty) { updateChrome(); return; }
    const titleEl = $("#n-title", root), ta = $("#n-content", root);
    if (r.title !== local.title && titleEl) applyRemoteText(titleEl, r.title);
    if (r.content !== local.content && ta) {
      applyRemoteText(ta, r.content);
      autoGrow(ta);
      if (mode === "preview") renderPreview(r.content);
    }
    local = r;
    renderTags();
    updateChrome();
    updateMetaLine();
  }

  // ---------------------------------------------------------------- Simpan
  const scheduleSave = debounce(() => save(), 700);

  function markDirty() {
    dirty = true;
    window.__catatkuDirty = true;
    setStatus("dirty");
    scheduleSave();
    resetRelock();
  }

  async function send(snap) {
    if (byteLength(snap.content) > store.LIMITS.maxContentBytes) {
      throw new Error(`Isi catatan terlalu panjang (maks ${Math.round(store.LIMITS.maxContentBytes / 1024)} KB). Simpan teks panjang sebagai lampiran.`);
    }
    if (!created) {
      created = true;
      const ack = store.createNote(noteId, snap);
      history.replaceState(null, "", `#/note/${noteId}`);
      startWatch();
      startFilesWatch();
      return { ack };
    }
    if (note?.locked) {
      if (!key) throw new Error("Catatan terkunci.");
      const enc = await encryptText(key, snap.content);
      lastEnc = enc.d;
      return { ack: store.updateNote(noteId, { title: snap.title, tags: snap.tags, color: snap.color, pinned: snap.pinned, enc, content: "" }) };
    }
    return { ack: store.updateNote(noteId, { title: snap.title, content: snap.content, tags: snap.tags, color: snap.color, pinned: snap.pinned }) };
  }

  /**
   * Kirim perubahan. Mengembalikan { issued, acked }:
   * - issued: selesai saat write sudah masuk antrean Firestore (urutan terjaga)
   * - acked : selesai saat server mengonfirmasi
   */
  function save({ force = false } = {}) {
    scheduleSave.cancel();
    if (!dirty && !force) return { issued: prepChain, acked: prepChain };
    const snap = { ...local, tags: [...local.tags] };
    if (!created && !force && !snap.title.trim() && !snap.content.trim()) {
      dirty = false; window.__catatkuDirty = pendingAcks > 0; setStatus("new");
      return { issued: Promise.resolve(), acked: Promise.resolve() };
    }
    dirty = false;
    const seq = ++writeSeq;
    pendingAcks++;
    window.__catatkuDirty = true;
    setStatus("saving");
    const prep = prepChain.then(() => send(snap));
    prepChain = prep.then(() => {}, () => {});
    const acked = prep.then(({ ack }) => ack).then(() => {
      pendingAcks--;
      if (seq === writeSeq && !dirty) setStatus("saved");
    }, (e) => {
      pendingAcks--;
      console.error(e);
      dirty = true;
      setStatus("error");
      toast(e?.code === "permission-denied" ? "Gagal menyimpan: akses ditolak." : (e?.message || "Gagal menyimpan."), "error", 5000);
    }).finally(() => { window.__catatkuDirty = dirty || pendingAcks > 0; });
    return { issued: prep.then(() => {}, () => {}), acked };
  }

  async function flushIssued() { await save().issued; }

  async function ensureCreated() {
    if (created) return;
    await save({ force: true }).issued;
  }

  function setStatus(s) {
    lastStatus = s;
    const el = $("#n-status", root);
    if (!el) return;
    const offline = !navigator.onLine;
    const map = {
      new: ["Catatan baru", ""],
      dirty: ["Belum tersimpan", "warn"],
      saving: [offline ? "Offline · tersimpan lokal" : "Menyimpan…", offline ? "warn" : "busy"],
      saved: ["Tersimpan", "ok"],
      error: ["Gagal menyimpan", "err"],
    };
    const [text, cls] = map[s] || ["", ""];
    el.className = `save-status ${cls}`;
    el.textContent = text;
  }
  onWin("online", () => setStatus(lastStatus));
  onWin("offline", () => setStatus(lastStatus));

  // ---------------------------------------------------------------- Kunci otomatis
  function resetRelock() {
    clearTimeout(relockTimer);
    if (key && note?.locked) relockTimer = setTimeout(async () => {
      if (!alive || !key) return;
      await flushIssued();
      relock();
      toast("Catatan dikunci otomatis karena tidak ada aktivitas.");
    }, RELOCK_MS);
  }
  function relock() {
    key = null; lastEnc = null;
    clearTimeout(relockTimer);
    renderLockScreen();
  }

  // ---------------------------------------------------------------- Layar terkunci
  function renderLockScreen() {
    editorMounted = false;
    stopFilesWatch();
    revokeBlobs();
    metaCache.clear();
    document.title = "Catatan terkunci · Catatku";
    setHTML(root, html`
      <div class="lock-screen">
        <form class="lock-card" novalidate>
          <div class="lock-icon">${icon("lock")}</div>
          <h2 id="lock-title"></h2>
          <p class="muted">Catatan ini terkunci & terenkripsi end-to-end. Masukkan password untuk membukanya.</p>
          <div class="pw-wrap">
            <input type="password" name="pw" placeholder="Password catatan" autocomplete="off" required>
            <button type="button" class="icon-btn sm" data-pw-toggle aria-label="Tampilkan password">${icon("eye")}</button>
          </div>
          <p class="form-error" hidden></p>
          <button class="btn btn-primary btn-block" type="submit">${icon("unlock")} Buka kunci</button>
          <a href="#/" class="link">← Kembali ke beranda</a>
        </form>
      </div>`);
    updateLockTitle();
    const form = $(".lock-card", root);
    const err = $(".form-error", form);
    const btn = $('button[type="submit"]', form);
    $("[data-pw-toggle]", form).onclick = () => { form.pw.type = form.pw.type === "password" ? "text" : "password"; };
    setTimeout(() => form.pw?.focus(), 60);
    let attempts = 0;
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const pw = form.pw.value;
      if (!pw) { err.textContent = "Masukkan password."; err.hidden = false; return; }
      btn.disabled = true; btn.classList.add("loading"); err.hidden = true;
      try {
        if (!note?.lock || !note?.enc) throw new Error("Data kunci tidak valid.");
        const k = await unlockKey(note.lock, pw);
        const content = await decryptText(k, note.enc);
        if (!alive) return;
        key = k; lastEnc = note.enc.d;
        local = pick(note, content);
        renderEditor();
        resetRelock();
        migratePlainFiles();
      } catch (ex) {
        attempts++;
        // Jeda bertahap untuk memperlambat tebakan berulang
        await new Promise((r) => setTimeout(r, Math.min(4000, 300 * attempts)));
        err.textContent = ex.code === "bad-password" ? "Password salah." : (ex.message || "Gagal membuka kunci.");
        err.hidden = false;
        form.pw.select();
      } finally {
        btn.disabled = false; btn.classList.remove("loading");
      }
    };
  }
  function updateLockTitle() {
    const t = $("#lock-title", root);
    if (t) t.textContent = note?.title?.trim() || "Catatan terkunci";
  }

  async function migratePlainFiles() {
    try {
      if (key && note?.locked && await store.countPlainFiles(noteId)) await reencrypt(null, key, "Mengenkripsi lampiran");
    } catch (e) { console.error(e); }
  }

  async function reencrypt(fromKey, toKey, label) {
    const t = toast(`${label}…`, "info", 10 * 60 * 1000);
    try {
      const n = await store.reencryptFiles(noteId, fromKey, toKey, (d, total) => t.set(`${label}… ${d}/${total}`));
      t.close();
      if (n) toast(`${label} selesai (${n} file).`, "success");
    } catch (e) {
      t.close();
      console.error(e);
      toast(`${label} gagal: ${e.message || e}`, "error", 6000);
      throw e;
    }
  }

  function renderMissing() {
    editorMounted = false;
    stopFilesWatch();
    setHTML(root, html`<div class="empty">
      <div class="empty-icon">${icon("note")}</div>
      <h3>Catatan tidak ditemukan</h3>
      <p class="muted">Catatan mungkin sudah dihapus dari perangkat lain.</p>
      <a class="btn btn-primary" href="#/">Kembali ke beranda</a></div>`);
  }

  // ---------------------------------------------------------------- Editor
  function renderEditor() {
    editorMounted = true;
    setHTML(root, html`
      <div class="note-page ${colorClass(local.color)}" id="n-page">
        <div class="note-toolbar">
          <button class="icon-btn" data-a="back" title="Kembali" aria-label="Kembali">${icon("back")}</button>
          <span id="n-status" class="save-status"></span>
          <span class="spacer"></span>
          <div class="seg" role="tablist" aria-label="Mode">
            <button data-a="mode" data-mode="edit" role="tab">${icon("edit")}<span>Edit</span></button>
            <button data-a="mode" data-mode="preview" role="tab">${icon("eye")}<span>Pratinjau</span></button>
          </div>
          <button class="icon-btn" data-a="pin" id="n-pin" title="Sematkan" aria-label="Sematkan">${icon("pin")}</button>
          <div class="menu-wrap">
            <button class="icon-btn" data-menu="m-color" title="Warna" aria-label="Warna">${icon("palette")}</button>
            <div class="menu menu-right palette" id="m-color" hidden>
              ${Object.keys(COLOR_LABEL).map((c) => html`<button class="swatch ${colorClass(c)}" data-color="${c}" title="${COLOR_LABEL[c]}" aria-label="${COLOR_LABEL[c]}"></button>`)}
            </div>
          </div>
          <div class="menu-wrap">
            <button class="icon-btn" data-menu="m-lock" id="n-lockbtn" title="Kunci" aria-label="Kunci">${icon("unlock")}</button>
            <div class="menu menu-right" id="m-lock" hidden></div>
          </div>
          <div class="menu-wrap">
            <button class="icon-btn" data-menu="m-more" title="Lainnya" aria-label="Lainnya">${icon("more")}</button>
            <div class="menu menu-right" id="m-more" hidden>
              <button data-a="copy">${icon("copy")} Salin isi</button>
              <button data-a="export">${icon("download")} Unduh sebagai .md</button>
              <button data-a="delete" class="danger">${icon("trash")} Hapus catatan</button>
            </div>
          </div>
        </div>

        <article class="note-sheet">
          <input id="n-title" class="note-title" placeholder="Judul" maxlength="${store.LIMITS.maxTitle}" autocomplete="off" aria-label="Judul">
          <div class="tag-editor" id="n-tags">
            <span id="n-tag-list"></span>
            <span class="tag-input-wrap">${icon("tag")}<input id="n-tag-input" placeholder="Tambah tag" maxlength="30" aria-label="Tambah tag"></span>
          </div>
          <div class="md-toolbar" id="n-mdbar">
            <button data-md="bold" title="Tebal (Ctrl+B)">${icon("bold")}</button>
            <button data-md="italic" title="Miring (Ctrl+I)">${icon("italic")}</button>
            <button data-md="heading" title="Judul">${icon("heading")}</button>
            <button data-md="list" title="Daftar">${icon("list")}</button>
            <button data-md="task" title="Checklist">${icon("checklist")}</button>
            <button data-md="code" title="Kode">${icon("code")}</button>
            <button data-md="link" title="Tautan">${icon("link")}</button>
            <span class="spacer"></span>
            <button data-a="attach" title="Lampirkan file">${icon("clip")}</button>
          </div>
          <textarea id="n-content" class="note-content" placeholder="Mulai menulis… (mendukung Markdown, tempel gambar langsung di sini)" spellcheck="true" aria-label="Isi catatan"></textarea>
          <div id="n-preview" class="md" hidden></div>

          <section class="attachments" id="n-files-sec">
            <div class="section-head">
              <h3 class="section-title sm">${icon("clip")} Lampiran <span id="n-files-count" class="muted"></span></h3>
              <button class="btn btn-ghost btn-sm" data-a="attach">${icon("upload")} Tambah file</button>
            </div>
            <div id="n-files" class="files-grid"></div>
            <p class="muted small">Gambar, dokumen (PDF/Office/teks), dan arsip (zip/rar/7z). Maks ${store.LIMITS.maxFileBytes / 1024 / 1024} MB per file. Seret & lepas atau tempel dari clipboard.</p>
          </section>
          <p class="note-meta muted small" id="n-meta"></p>
        </article>
        <input type="file" id="n-file-input" multiple accept="${store.ACCEPT_ATTR}" hidden>
        <div class="drop-overlay" id="n-drop" hidden><div>${icon("upload")}<b>Lepaskan untuk melampirkan</b></div></div>
      </div>`);

    const titleEl = $("#n-title", root);
    const ta = $("#n-content", root);
    titleEl.value = local.title;
    ta.value = local.content;
    renderTags();
    setMode(mode, false);
    updateChrome();
    updateMetaLine();
    setStatus(created ? "saved" : "new");
    requestAnimationFrame(() => autoGrow(ta));
    if (isNew && !created) setTimeout(() => titleEl.focus(), 80);
    if (created) startFilesWatch();
    renderFiles();
    bindEditor();
  }

  function updateChrome() {
    const page = $("#n-page", root);
    if (!page) return;
    page.className = `note-page ${colorClass(local.color)}`;
    const pin = $("#n-pin", root);
    pin.classList.toggle("on", local.pinned);
    pin.setAttribute("aria-pressed", String(local.pinned));
    pin.title = local.pinned ? "Lepas sematan" : "Sematkan";
    const lockBtn = $("#n-lockbtn", root);
    setHTML(lockBtn, icon(note?.locked ? "lock" : "unlock"));
    lockBtn.classList.toggle("on", !!note?.locked);
    $$("[data-color]", root).forEach((s) => s.classList.toggle("active", s.dataset.color === local.color));
    document.title = `${local.title?.trim() || "Tanpa judul"} · Catatku`;
  }

  function updateMetaLine() {
    const el = $("#n-meta", root);
    if (!el) return;
    const parts = [];
    if (note?.createdAt) parts.push(`Dibuat ${timeAgo(toMillis(note.createdAt))}`);
    if (note?.updatedAt) parts.push(`Diubah ${timeAgo(toMillis(note.updatedAt))}`);
    parts.push(`${local.content.length.toLocaleString("id-ID")} karakter`);
    if (note?.locked) parts.push("🔒 Terenkripsi end-to-end");
    el.textContent = parts.join(" · ");
  }

  function setMode(m, persist = true) {
    mode = m === "preview" ? "preview" : "edit";
    if (persist) try { localStorage.setItem(MODE_KEY, mode); } catch {}
    const ta = $("#n-content", root), pv = $("#n-preview", root), bar = $("#n-mdbar", root);
    if (!ta) return;
    $$('[data-a="mode"]', root).forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on));
    });
    if (mode === "preview") {
      renderPreview(local.content);
      ta.hidden = true; pv.hidden = false; bar.classList.add("dim");
    } else {
      ta.hidden = false; pv.hidden = true; bar.classList.remove("dim");
      requestAnimationFrame(() => autoGrow(ta));
    }
  }

  function renderPreview(content) {
    const pv = $("#n-preview", root);
    if (!pv) return;
    const out = renderMarkdown(content);
    pv.innerHTML = out || `<p class="muted">Belum ada isi. Klik Edit untuk mulai menulis.</p>`;
  }

  function renderTags() {
    const list = $("#n-tag-list", root);
    if (!list) return;
    setHTML(list, html`${local.tags.map((t, i) => html`<span class="tag tag-edit">#${t}<button data-rmtag="${i}" aria-label="Hapus tag ${t}">${icon("x")}</button></span>`)}`);
  }

  function addTag(raw) {
    const t = raw.trim().replace(/^#+/, "").replace(/\s+/g, "-").slice(0, 30);
    if (!t) return;
    if (local.tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    if (local.tags.length >= store.LIMITS.maxTags) { toast(`Maksimal ${store.LIMITS.maxTags} tag.`, "error"); return; }
    local.tags.push(t);
    renderTags();
    markDirty();
  }

  // ---------------------------------------------------------------- Bantuan markdown
  function replaceRange(ta, s, e, text) {
    ta.focus();
    ta.setSelectionRange(s, e);
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch {}
    if (!ok) { ta.setRangeText(text, s, e, "end"); ta.dispatchEvent(new Event("input", { bubbles: true })); }
  }
  function wrapSel(ta, before, after, placeholder) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder;
    replaceRange(ta, s, e, before + sel + after);
    ta.setSelectionRange(s + before.length, s + before.length + sel.length);
  }
  function prefixLines(ta, prefix) {
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", e); if (le === -1) le = v.length;
    const lines = v.slice(ls, le).split("\n");
    const all = lines.every((l) => l.startsWith(prefix));
    const block = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join("\n");
    replaceRange(ta, ls, le, block);
    ta.setSelectionRange(ls, ls + block.length);
  }
  function mdAction(kind) {
    if (mode !== "edit") setMode("edit");
    const ta = $("#n-content", root);
    if (kind === "bold") wrapSel(ta, "**", "**", "teks tebal");
    else if (kind === "italic") wrapSel(ta, "_", "_", "teks miring");
    else if (kind === "code") {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel.includes("\n")) wrapSel(ta, "```\n", "\n```", "");
      else wrapSel(ta, "`", "`", "kode");
    }
    else if (kind === "link") wrapSel(ta, "[", "](https://)", "teks tautan");
    else if (kind === "heading") prefixLines(ta, "## ");
    else if (kind === "list") prefixLines(ta, "- ");
    else if (kind === "task") prefixLines(ta, "- [ ] ");
  }

  // ---------------------------------------------------------------- Event editor
  function bindEditor() {
    const page = $("#n-page", root);
    const titleEl = $("#n-title", root);
    const ta = $("#n-content", root);
    const tagInput = $("#n-tag-input", root);
    const fileInput = $("#n-file-input", root);

    titleEl.addEventListener("input", () => { local.title = titleEl.value; updateChrome(); markDirty(); });
    titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (mode === "preview") setMode("edit"); ta.focus(); } });

    ta.addEventListener("input", () => { local.content = ta.value; autoGrow(ta); markDirty(); updateMetaLine(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const v = ta.value, s = ta.selectionStart;
      if (s !== ta.selectionEnd) return;
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      const line = v.slice(ls, s);
      const m = line.match(/^(\s*)(?:([-*+]\s+\[[ xX]\]\s+)|([-*+]\s+)|(\d{1,9})([.)])\s+)/);
      if (!m) return;
      e.preventDefault();
      if (line.trim() === m[0].trim()) { replaceRange(ta, ls, s, ""); return; }
      const marker = m[2] ? "- [ ] " : m[3] ? m[3] : `${Number(m[4]) + 1}${m[5]} `;
      replaceRange(ta, s, s, "\n" + m[1] + marker);
    });
    ta.addEventListener("paste", (e) => {
      const fl = e.clipboardData?.files;
      if (fl && fl.length) { e.preventDefault(); addFiles(fl); }
    });

    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagInput.value); tagInput.value = ""; }
      else if (e.key === "Backspace" && !tagInput.value && local.tags.length) { local.tags.pop(); renderTags(); markDirty(); }
    });
    tagInput.addEventListener("blur", () => { if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ""; } });

    fileInput.addEventListener("change", () => { if (fileInput.files.length) addFiles(fileInput.files); fileInput.value = ""; });

    $("#n-preview", root).addEventListener("change", (e) => {
      const cb = e.target.closest('input[type="checkbox"][data-line]');
      if (!cb) return;
      local.content = toggleTaskLine(local.content, Number(cb.dataset.line));
      ta.value = local.content;
      renderPreview(local.content);
      markDirty();
    });

    page.addEventListener("click", async (e) => {
      const menuBtn = e.target.closest("[data-menu]");
      if (menuBtn) {
        e.stopPropagation();
        const m = $("#" + menuBtn.dataset.menu, root);
        const open = m.hidden;
        closeMenus();
        if (open) { if (m.id === "m-lock") fillLockMenu(m); m.hidden = false; }
        return;
      }
      const sw = e.target.closest("[data-color]");
      if (sw) { local.color = sw.dataset.color; updateChrome(); closeMenus(); markDirty(); save(); return; }
      const rm = e.target.closest("[data-rmtag]");
      if (rm) { local.tags.splice(Number(rm.dataset.rmtag), 1); renderTags(); markDirty(); return; }
      const md = e.target.closest("[data-md]");
      if (md) { mdAction(md.dataset.md); return; }
      const fa = e.target.closest("[data-fa]");
      if (fa) { fileAction(fa.dataset.fa, fa.closest("[data-fid]")?.dataset.fid); return; }
      const thumb = e.target.closest("[data-preview]");
      if (thumb) { openLightbox(thumb.closest("[data-fid]").dataset.fid); return; }
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      closeMenus();
      if (a === "back") go("#/");
      else if (a === "mode") setMode(e.target.closest("[data-a]").dataset.mode);
      else if (a === "pin") { local.pinned = !local.pinned; updateChrome(); markDirty(); save(); }
      else if (a === "attach") fileInput.click();
      else if (a === "copy") { (await copyText(local.content)) ? toast("Isi catatan disalin.", "success") : toast("Gagal menyalin.", "error"); }
      else if (a === "export") exportMd();
      else if (a === "delete") deleteThis();
      else if (a === "lock") doLock();
      else if (a === "relock") { await flushIssued(); relock(); }
      else if (a === "changepw") changePassword();
      else if (a === "unlockperm") removeLock();
    });

    // Drag & drop file
    let dragDepth = 0;
    const overlay = $("#n-drop", root);
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    page.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
    page.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    page.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
    page.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; overlay.hidden = true;
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
  }

  function closeMenus() { $$(".note-page .menu", root).forEach((m) => { m.hidden = true; }); }

  // Event tingkat dokumen (dibersihkan saat keluar halaman)
  onDoc("click", (e) => { if (!e.target.closest(".note-page .menu-wrap")) closeMenus(); });
  onDoc("keydown", (e) => {
    if (!editorMounted) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    else if (mod && e.key.toLowerCase() === "b" && document.activeElement?.id === "n-content") { e.preventDefault(); mdAction("bold"); }
    else if (mod && e.key.toLowerCase() === "i" && document.activeElement?.id === "n-content") { e.preventDefault(); mdAction("italic"); }
    else if (e.key === "Escape") closeMenus();
  });
  ["pointerdown", "keydown"].forEach((t) => onDoc(t, () => { if (key) resetRelock(); }, { passive: true }));

  // ---------------------------------------------------------------- Menu kunci
  function fillLockMenu(m) {
    if (!note?.locked) {
      setHTML(m, html`<div class="menu-note">${icon("shield")} Enkripsi isi & lampiran dengan password. Password tidak bisa dipulihkan.</div>
        <button data-a="lock">${icon("lock")} Kunci catatan…</button>`);
    } else {
      setHTML(m, html`<div class="menu-note">${icon("shield")} Catatan terenkripsi end-to-end.</div>
        <button data-a="relock">${icon("lock")} Kunci sekarang</button>
        <button data-a="changepw">${icon("key")} Ganti password…</button>
        <button data-a="unlockperm" class="danger">${icon("unlock")} Hapus kunci…</button>`);
    }
  }

  async function doLock() {
    if (!created && !local.title.trim() && !local.content.trim()) { toast("Tulis sesuatu dulu sebelum mengunci.", "info"); return; }
    await ensureCreated();
    await flushIssued();
    const res = await passwordDialog({
      title: "Kunci catatan",
      message: "Isi catatan & lampiran akan dienkripsi di perangkat Anda sebelum disimpan. Judul & tag tetap terlihat. Jika password lupa, catatan TIDAK BISA dipulihkan.",
      mode: "set", okText: "Kunci",
      onSubmit: async ({ newPassword }) => {
        const { lock, key: k } = await createLock(newPassword);
        const enc = await encryptText(k, local.content);
        const prevKey = key, prevEnc = lastEnc;
        key = k; lastEnc = enc.d;
        try {
          await store.updateNote(noteId, { locked: true, lock, enc, content: "", title: local.title, tags: local.tags });
        } catch (e) { key = prevKey; lastEnc = prevEnc; throw new Error(e.code === "permission-denied" ? "Akses ditolak." : "Gagal mengunci. Periksa koneksi."); }
      },
    });
    if (!res || !alive) return;
    note = { ...note, locked: true };
    updateChrome(); updateMetaLine(); resetRelock();
    toast("Catatan terkunci.", "success");
    try { await reencrypt(null, key, "Mengenkripsi lampiran"); } catch {}
  }

  async function changePassword() {
    await flushIssued();
    const res = await passwordDialog({
      title: "Ganti password catatan", mode: "change", okText: "Simpan",
      onSubmit: async ({ password, newPassword }) => {
        let lock;
        try { lock = await rewrapLock(note.lock, password, newPassword); }
        catch (e) { throw new Error(e.code === "bad-password" ? "Password saat ini salah." : "Gagal mengganti password."); }
        await store.updateNote(noteId, { lock });
      },
    });
    if (res) toast("Password catatan diganti.", "success");
  }

  async function removeLock() {
    const res = await passwordDialog({
      title: "Hapus kunci", mode: "unlock", okText: "Hapus kunci",
      message: "Isi & lampiran akan disimpan tanpa enkripsi. Masukkan password untuk konfirmasi.",
      onSubmit: async ({ password }) => {
        try { await unlockKey(note.lock, password); }
        catch (e) { throw new Error(e.code === "bad-password" ? "Password salah." : "Gagal memverifikasi password."); }
      },
    });
    if (!res || !alive) return;
    await flushIssued();
    try {
      await reencrypt(key, null, "Mendekripsi lampiran");
      const content = local.content;
      await store.updateNote(noteId, { locked: false, lock: null, enc: null, content });
      key = null; lastEnc = null;
      note = { ...note, locked: false };
      clearTimeout(relockTimer);
      updateChrome(); updateMetaLine();
      toast("Kunci dihapus.", "success");
    } catch (e) {
      console.error(e);
      toast("Gagal menghapus kunci. Coba lagi.", "error");
    }
  }

  // ---------------------------------------------------------------- Lampiran
  async function addFiles(fileList) {
    const valid = [];
    for (const f of fileList) {
      const err = store.validateFile(f);
      if (err) toast(err, "error", 5000); else valid.push(f);
    }
    if (!valid.length) return;
    if (note?.locked && !key) return;
    try { await ensureCreated(); } catch { return; }
    for (const f of valid) {
      const tmp = "u" + Math.random().toString(36).slice(2);
      uploads.set(tmp, { name: f.name, size: f.size, progress: 0 });
      renderFiles();
      try {
        await store.uploadFile(noteId, f, note?.locked ? key : null, (p) => {
          const u = uploads.get(tmp); if (u) u.progress = p;
          const bar = $(`[data-up="${tmp}"] .progress i`, root);
          if (bar) bar.style.width = Math.round(p * 100) + "%";
        });
        toast(`"${f.name}" terlampir.`, "success", 1800);
      } catch (e) {
        console.error(e);
        toast(`Gagal mengunggah "${f.name}": ${e.code === "permission-denied" ? "akses ditolak" : e.message || "error"}`, "error", 5000);
      } finally {
        uploads.delete(tmp);
        renderFiles();
      }
    }
  }

  async function ensureMeta(f) {
    const cacheKey = f.id + (f.enc ? ":e" : "");
    if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);
    const m = await store.fileMeta(f, key);
    metaCache.set(cacheKey, m);
    return m;
  }

  let filesSeq = 0;
  async function renderFiles() {
    const grid = $("#n-files", root);
    if (!grid) return;
    const seq = ++filesSeq;
    const metas = await Promise.all(files.map(ensureMeta));
    if (seq !== filesSeq || !$("#n-files", root)) return;
    const now = Date.now();
    const tiles = files.map((f, i) => {
      const m = metas[i];
      const ext = store.extOf(m.name);
      const kind = store.fileKind(m.name);
      const age = now - toMillis(f.createdAt);
      if (f.status !== "ready") {
        const stale = age > 10 * 60 * 1000;
        return html`<div class="file-tile ${stale ? "failed" : ""}" data-fid="${f.id}">
          <div class="thumb">${icon(stale ? "x" : "upload")}</div>
          <div class="file-info"><span class="file-name" title="${m.name}">${m.name}</span>
            <small>${stale ? "Unggahan gagal" : "Sedang diunggah…"}</small></div>
          <div class="file-actions">${stale ? html`<button class="icon-btn sm" data-fa="delete" title="Hapus" aria-label="Hapus">${icon("trash")}</button>` : ""}</div>
        </div>`;
      }
      const img = store.isPreviewableImage(m.name);
      return html`<div class="file-tile" data-fid="${f.id}">
        <div class="thumb ${img ? "is-img" : ""}" ${img ? raw('data-preview="1" data-lazy="1" role="button" tabindex="0"') : ""} title="${m.name}">
          ${icon(kind === "image" ? "image" : kind === "archive" ? "zip" : "file")}
          ${!img ? html`<span class="ext">${ext || "file"}</span>` : ""}
        </div>
        <div class="file-info"><span class="file-name" title="${m.name}">${m.name}</span>
          <small>${formatBytes(f.size)}${f.enc ? " · 🔒" : ""}</small></div>
        <div class="file-actions">
          <button class="icon-btn sm" data-fa="download" title="Unduh" aria-label="Unduh ${m.name}">${icon("download")}</button>
          <button class="icon-btn sm" data-fa="delete" title="Hapus" aria-label="Hapus ${m.name}">${icon("trash")}</button>
        </div>
      </div>`;
    });
    const ups = [...uploads.entries()].map(([id, u]) => html`<div class="file-tile uploading" data-up="${id}">
      <div class="thumb">${icon("upload")}</div>
      <div class="file-info"><span class="file-name">${u.name}</span><small>Mengunggah · ${formatBytes(u.size)}</small>
        <div class="progress"><i style="width:${Math.round(u.progress * 100)}%"></i></div></div></div>`);
    setHTML(grid, html`${tiles}${ups}`);
    const countEl = $("#n-files-count", root);
    if (countEl) countEl.textContent = files.length ? `(${files.length})` : "";
    $("#n-files-sec", root).classList.toggle("empty-files", !files.length && !uploads.size);
    observeThumbs();
  }

  function observeThumbs() {
    if (thumbObserver) thumbObserver.disconnect();
    const els = $$("[data-lazy]", root);
    if (!els.length) return;
    const load = (el) => {
      const fid = el.closest("[data-fid]")?.dataset.fid;
      el.removeAttribute("data-lazy");
      if (fid) loadThumb(el, fid);
    };
    if (!("IntersectionObserver" in window)) { els.forEach(load); return; }
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { thumbObserver.unobserve(en.target); load(en.target); } });
    }, { rootMargin: "200px" });
    els.forEach((el) => thumbObserver.observe(el));
  }

  async function getBlobUrl(f) {
    if (blobUrls.has(f.id)) return blobUrls.get(f.id);
    const m = await ensureMeta(f);
    const bytes = await store.readFileBytes(noteId, f, key);
    const url = URL.createObjectURL(new Blob([bytes], { type: IMG_MIME[store.extOf(m.name)] || "application/octet-stream" }));
    if (!alive) { URL.revokeObjectURL(url); throw new Error("closed"); }
    blobUrls.set(f.id, url);
    return url;
  }

  async function loadThumb(el, fid) {
    const f = files.find((x) => x.id === fid);
    if (!f) return;
    el.classList.add("loading-thumb");
    try {
      const url = await getBlobUrl(f);
      const img = new Image();
      img.alt = "";
      img.decoding = "async";
      img.src = url;
      img.onload = () => { el.replaceChildren(img); el.classList.remove("loading-thumb"); };
      img.onerror = () => el.classList.remove("loading-thumb");
    } catch (e) {
      el.classList.remove("loading-thumb");
      if (e.message !== "closed") console.warn(e);
    }
  }

  async function openLightbox(fid) {
    const f = files.find((x) => x.id === fid);
    if (!f) return;
    const m = await ensureMeta(f);
    const mdl = openModal(html`<div class="lightbox">
        <div class="lightbox-img"><div class="spinner"></div></div>
        <div class="lightbox-bar"><span class="file-name"></span>
          <button class="btn btn-ghost btn-sm" data-dl>${icon("download")} Unduh</button>
          <button class="icon-btn" data-close aria-label="Tutup">${icon("x")}</button></div>
      </div>`, { wide: true });
    $(".file-name", mdl.el).textContent = m.name;
    $("[data-close]", mdl.el).onclick = () => mdl.close();
    $("[data-dl]", mdl.el).onclick = () => fileAction("download", fid);
    try {
      const url = await getBlobUrl(f);
      const img = new Image(); img.src = url; img.alt = m.name;
      $(".lightbox-img", mdl.el).replaceChildren(img);
    } catch (e) {
      $(".lightbox-img", mdl.el).textContent = "Gagal memuat gambar.";
    }
  }

  async function fileAction(action, fid) {
    const f = files.find((x) => x.id === fid);
    if (!f) return;
    const m = await ensureMeta(f);
    if (action === "download") {
      const t = toast(`Mengunduh "${m.name}"…`, "info", 60000);
      try {
        const bytes = await store.readFileBytes(noteId, f, key);
        // Selalu application/octet-stream agar file tidak pernah dirender di origin aplikasi
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url; a.download = m.name || "file"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
        t.close();
      } catch (e) {
        t.close();
        toast(`Gagal mengunduh: ${e.message || e}`, "error");
      }
    } else if (action === "delete") {
      const ok = await confirmDialog({ title: "Hapus lampiran?", message: `"${m.name}" akan dihapus permanen.`, okText: "Hapus", danger: true });
      if (!ok) return;
      try {
        await store.deleteFile(noteId, fid);
        const u = blobUrls.get(fid); if (u) { URL.revokeObjectURL(u); blobUrls.delete(fid); }
        toast("Lampiran dihapus.", "success");
      } catch (e) { toast("Gagal menghapus lampiran.", "error"); }
    }
  }

  function revokeBlobs() { blobUrls.forEach((u) => URL.revokeObjectURL(u)); blobUrls.clear(); }

  // ---------------------------------------------------------------- Lainnya
  function exportMd() {
    const name = (local.title.trim() || "catatan").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 80);
    const body = (local.title ? `# ${local.title}\n\n` : "") + local.content;
    const url = URL.createObjectURL(new Blob([body], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${name}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function deleteThis() {
    const ok = await confirmDialog({
      title: "Hapus catatan?", message: "Catatan beserta seluruh lampirannya akan dihapus permanen dan tidak bisa dikembalikan.",
      okText: "Hapus", danger: true,
    });
    if (!ok) return;
    scheduleSave.cancel();
    dirty = false;
    if (!created) { window.__catatkuDirty = false; go("#/"); return; }
    deleting = true;
    if (unsubNote) { unsubNote(); unsubNote = null; }
    stopFilesWatch();
    const t = toast("Menghapus…", "info", 60000);
    try {
      await prepChain;
      await store.deleteNote(noteId);
      t.close();
      toast("Catatan dihapus.", "success");
      window.__catatkuDirty = false;
      go("#/");
    } catch (e) {
      t.close();
      console.error(e);
      deleting = false;
      startWatch(); startFilesWatch();
      toast("Gagal menghapus catatan.", "error");
    }
  }

  // ---------------------------------------------------------------- Cleanup
  return async () => {
    try {
      if (!deleting && editorMounted) {
        // Jangan tahan navigasi lama-lama saat offline; write tetap ada di antrean lokal Firestore.
        await Promise.race([save().issued, new Promise((r) => setTimeout(r, 1500))]);
      }
    } catch {}
    alive = false;
    key = null; lastEnc = null;
    clearTimeout(relockTimer);
    scheduleSave.cancel();
    if (unsubNote) unsubNote();
    stopFilesWatch();
    if (thumbObserver) thumbObserver.disconnect();
    revokeBlobs();
    docListeners.forEach(([t, fn, opts, target]) => (target || document).removeEventListener(t, fn, opts));
    window.__catatkuDirty = false;
    document.title = "Catatku";
  };
}

export { esc };
