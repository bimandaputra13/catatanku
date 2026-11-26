// Live Pad: satu area teks yang tersinkron realtime di semua perangkat yang login
// dengan akun yang sama — praktis untuk copy–paste antar device.
import { html, setHTML, icon, $, toast, confirmDialog, debounce, timeAgo, toMillis, deviceLabel, applyRemoteText, copyText } from "../ui.js";
import { liveTabs } from "./rooms.js";

export function mount(root, { store, go }) {
  const session = crypto.getRandomValues(new Uint32Array(2)).join("-");
  const device = deviceLabel();
  let dirty = false;
  let last = null;
  let alive = true;

  setHTML(root, html`
    ${liveTabs("live")}
    <div class="live-page">
      <div class="live-head">
        <div>
          <h1 class="page-title">${icon("live")} Live Pad</h1>
          <p class="muted">Buka halaman ini di perangkat lain dengan akun yang sama — teks tersinkron otomatis secara realtime.</p>
        </div>
        <span class="live-pill" id="lp-pill"><i></i><span>Menghubungkan…</span></span>
      </div>
      <div class="live-card">
        <textarea id="lp-text" class="live-text" placeholder="Ketik atau tempel teks di sini… langsung muncul di perangkat lain." spellcheck="false" aria-label="Teks live"></textarea>
        <div class="live-bar">
          <div class="live-actions">
            <button class="btn btn-primary" data-lp="copy">${icon("copy")} Salin semua</button>
            <button class="btn btn-ghost" data-lp="paste">${icon("paste")} Tempel</button>
            <button class="btn btn-ghost" data-lp="save">${icon("note")} Simpan jadi catatan</button>
            <button class="btn btn-ghost danger-text" data-lp="clear">${icon("trash")} Bersihkan</button>
          </div>
          <small class="muted" id="lp-info"></small>
        </div>
      </div>
      <p class="muted small">Tips: data Live Pad tersimpan di akun Anda (bukan publik). Jangan simpan password di sini — gunakan catatan terkunci.</p>
    </div>`);

  const ta = $("#lp-text", root);
  const pill = $("#lp-pill", root);
  const info = $("#lp-info", root);
  const max = store.LIMITS.maxLiveChars;

  const setPill = (state, text) => { pill.className = `live-pill ${state}`; pill.querySelector("span").textContent = text; };
  const updateInfo = () => {
    const parts = [`${ta.value.length.toLocaleString("id-ID")} karakter`];
    if (last?.updatedAt) {
      const who = last.session === session ? "perangkat ini" : (last.device || "perangkat lain");
      parts.push(`diperbarui ${timeAgo(toMillis(last.updatedAt))} dari ${who}`);
    }
    info.textContent = parts.join(" · ");
  };

  const push = debounce(async () => {
    if (!alive) return;
    dirty = false;
    let text = ta.value;
    if (text.length > max) { text = text.slice(0, max); ta.value = text; toast(`Live Pad dibatasi ${max.toLocaleString("id-ID")} karakter.`, "error"); }
    try { await store.writeLive(text, device, session); }
    catch (e) { console.error(e); setPill("err", "Gagal sinkron"); toast(e.code === "permission-denied" ? "Akses ditolak oleh rules." : "Gagal sinkron.", "error"); }
  }, 250);

  ta.addEventListener("input", () => { dirty = true; setPill("busy", "Mengirim…"); push(); updateInfo(); });

  const unsub = store.watchLive((snap) => {
    if (!alive) return;
    const offline = snap.metadata.fromCache && !navigator.onLine;
    if (snap.metadata.hasPendingWrites) { setPill("busy", offline ? "Offline · tersimpan lokal" : "Mengirim…"); return; }
    setPill(snap.metadata.fromCache ? "warn" : "ok", snap.metadata.fromCache ? (offline ? "Offline" : "Menghubungkan…") : "Live · tersinkron");
    if (!snap.exists()) { last = null; updateInfo(); return; }
    const d = snap.data({ serverTimestamps: "estimate" });
    last = d;
    if (!dirty && typeof d.text === "string" && d.text !== ta.value) {
      applyRemoteText(ta, d.text);
      if (d.session !== session) { ta.classList.remove("flash"); void ta.offsetWidth; ta.classList.add("flash"); }
    }
    updateInfo();
  }, (err) => {
    console.error(err);
    setPill("err", err.code === "permission-denied" ? "Akses ditolak" : "Terputus");
  });

  root.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-lp]")?.dataset.lp;
    if (!a) return;
    if (a === "copy") {
      if (!ta.value) return toast("Live Pad masih kosong.");
      (await copyText(ta.value)) ? toast("Disalin ke clipboard.", "success", 1500) : toast("Gagal menyalin.", "error");
    } else if (a === "paste") {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return toast("Clipboard kosong.");
        ta.focus();
        let ok = false;
        try { ok = document.execCommand("insertText", false, text); } catch {}
        if (!ok) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
      } catch {
        toast("Browser tidak mengizinkan akses clipboard. Gunakan Ctrl+V / tekan lama → Tempel.", "info", 4500);
        ta.focus();
      }
    } else if (a === "clear") {
      if (!ta.value) return;
      const ok = await confirmDialog({ title: "Bersihkan Live Pad?", message: "Teks akan terhapus di semua perangkat.", okText: "Bersihkan", danger: true });
      if (!ok) return;
      ta.value = ""; dirty = true; push(); updateInfo();
    } else if (a === "save") {
      const text = ta.value.trim();
      if (!text) return toast("Live Pad masih kosong.");
      const id = store.newNoteId();
      const title = `Live Pad · ${new Date().toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}`;
      store.createNote(id, { title, content: text.slice(0, max) }).catch(() => toast("Gagal menyimpan catatan.", "error"));
      toast("Disimpan sebagai catatan baru.", "success");
      go(`#/note/${id}`);
    }
  });

  const timer = setInterval(updateInfo, 30000);
  setTimeout(() => ta.focus(), 60);

  return () => {
    alive = false;
    unsub();
    clearInterval(timer);
    // kirim perubahan terakhir bila masih tertunda
    if (dirty) { push.cancel(); store.writeLive(ta.value.slice(0, max), device, session).catch(() => {}); }
  };
}
