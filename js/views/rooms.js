// Daftar room bersama: buat room, gabung dengan kode/link undangan, daftar room saya.
import { html, setHTML, icon, $, toast, confirmDialog, timeAgo, toMillis } from "../ui.js";
import { emptyState } from "./components.js";

export const liveTabs = (active) => html`
  <div class="tabs-nav" role="tablist">
    <a href="#/live" class="${active === "live" ? "active" : ""}" role="tab">${icon("live")} Live Pad pribadi</a>
    <a href="#/rooms" class="${active === "rooms" ? "active" : ""}" role="tab">${icon("users")} Room bersama</a>
  </div>`;

export function mount(root, { store, go, id: joinCode, fb }) {
  let alive = true;
  const displayName = () => fb.auth.currentUser?.displayName || "Pengguna";

  setHTML(root, html`
    ${liveTabs("rooms")}
    <div class="rooms-head">
      <h1 class="page-title">${icon("users")} Room bersama</h1>
      <p class="muted">Berbagi teks dengan akun lain secara realtime. Hanya orang yang punya kode undangan yang bisa masuk.</p>
    </div>
    <div class="rooms-forms">
      <form class="panel" id="f-join" novalidate>
        <h3>${icon("key")} Gabung room</h3>
        <p class="muted small">Masukkan kode undangan 8 karakter dari pemilik room.</p>
        <div class="row">
          <input name="code" class="code-input" placeholder="ABCD-2345" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Kode undangan" required>
          <button class="btn btn-primary" type="submit">Gabung</button>
        </div>
      </form>
      <form class="panel" id="f-create" novalidate>
        <h3>${icon("plus")} Buat room baru</h3>
        <p class="muted small">Anda menjadi pemilik dan bisa mengundang, mengeluarkan anggota, atau menghapus room.</p>
        <div class="row">
          <input name="name" placeholder="Nama room, mis. Tim Kantor" maxlength="60" autocomplete="off" aria-label="Nama room" required>
          <button class="btn btn-ghost" type="submit">Buat</button>
        </div>
      </form>
    </div>
    <h2 class="section-title">Room saya</h2>
    <div id="room-list"><div class="grid">${Array.from({ length: 3 }, () => html`<div class="note-card skeleton"><i></i><i></i><i></i></div>`)}</div></div>`);

  const list = $("#room-list", root);
  const fJoin = $("#f-join", root);
  const fCreate = $("#f-create", root);

  // Format otomatis kode: ABCD-2345
  fJoin.code.addEventListener("input", () => {
    const c = store.normalizeCode(fJoin.code.value);
    fJoin.code.value = c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  });

  const busy = (form, on) => { const b = form.querySelector('button[type="submit"]'); b.disabled = on; b.classList.toggle("loading", on); };

  async function doJoin(code) {
    busy(fJoin, true);
    try {
      const roomId = await store.joinRoom(code, displayName());
      if (!alive) return;
      toast("Berhasil bergabung ke room.", "success");
      go(`#/room/${roomId}`);
    } catch (e) {
      console.error(e);
      toast(e.code === "unavailable" ? "Sedang offline. Coba lagi saat online." : e.message || "Gagal bergabung.", "error", 5000);
    } finally { if (alive) busy(fJoin, false); }
  }

  fJoin.onsubmit = (e) => {
    e.preventDefault();
    const code = store.normalizeCode(fJoin.code.value);
    if (code.length !== 8) { toast("Kode undangan harus 8 karakter.", "error"); fJoin.code.focus(); return; }
    doJoin(code);
  };

  fCreate.onsubmit = async (e) => {
    e.preventDefault();
    const name = fCreate.name.value.trim();
    if (!name) { toast("Isi nama room dulu.", "error"); fCreate.name.focus(); return; }
    busy(fCreate, true);
    try {
      const roomId = await store.createRoom(name, displayName());
      if (!alive) return;
      toast("Room dibuat. Bagikan kode undangannya!", "success");
      go(`#/room/${roomId}`);
    } catch (err) {
      console.error(err);
      toast(err.code === "permission-denied" ? "Ditolak oleh rules. Pastikan firestore.rules terbaru sudah di-Publish." : "Gagal membuat room.", "error", 6000);
    } finally { if (alive) busy(fCreate, false); }
  };

  const unsub = store.watchMyRooms((rooms) => {
    if (!alive) return;
    if (!rooms.length) {
      setHTML(list, emptyState({ iconName: "users", title: "Belum ada room", text: "Buat room baru lalu bagikan kodenya, atau gabung dengan kode dari teman." }));
      return;
    }
    setHTML(list, html`<div class="grid anim">${rooms.map((r) => html`
      <a class="note-card room-card" href="#/room/${encodeURIComponent(r.id)}">
        <div class="card-top"><span class="room-icon">${icon("users")}</span><h3>${r.name || "Room"}</h3></div>
        <div class="card-foot">
          <span class="role-badge ${r.role === "owner" ? "owner" : ""}">${r.role === "owner" ? "Pemilik" : "Anggota"}</span>
          <span>Bergabung ${timeAgo(toMillis(r.joinedAt))}</span>
        </div>
      </a>`)}</div>`);
  }, (err) => {
    console.error(err);
    setHTML(list, emptyState({ iconName: "x", title: "Gagal memuat room", text: err.code === "permission-denied" ? "Pastikan firestore.rules terbaru sudah di-Publish." : "Periksa koneksi internet Anda." }));
  });

  // Dibuka lewat link undangan: #/join/KODE
  if (joinCode) {
    const code = store.normalizeCode(joinCode);
    fJoin.code.value = store.formatCode(code);
    history.replaceState(null, "", "#/rooms");
    setTimeout(async () => {
      if (!alive || code.length !== 8) return;
      const ok = await confirmDialog({ title: "Gabung room?", message: `Anda diundang ke sebuah room dengan kode ${store.formatCode(code)}. Anggota room bisa melihat nama Anda dan teks yang Anda kirim.`, okText: "Gabung" });
      if (ok && alive) doJoin(code);
    }, 150);
  }

  return () => { alive = false; unsub(); };
}
