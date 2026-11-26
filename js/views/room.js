// Isi room bersama: feed kiriman teks realtime antar akun, undangan, anggota.
import {
  html, setHTML, icon, $, $$, toast, confirmDialog, openModal, passwordDialog, timeAgo, toMillis, copyText, autoGrow
} from "../ui.js";
import { encryptWithPassword, decryptWithPassword } from "../crypto.js";
import { liveTabs } from "./rooms.js";

const COLLAPSE_LINES = 12;
const SOUND_KEY = "catatku-room-sound";

// ------------------------------------------------------------ Suara notifikasi
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}
/** Satu nada lembut (sine) dengan fade-out, seperti bunyi notifikasi pada umumnya. */
function tone(freq, start, dur, vol) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(start); o.stop(start + dur + 0.02);
}
/** Bunyi notifikasi "ding-dong" dua nada (E6 → C6). */
function playNotif() {
  try { navigator.vibrate?.([70, 50, 70]); } catch {}
  if (!audioCtx || audioCtx.state !== "running") return;
  const t = audioCtx.currentTime;
  tone(1318.5, t, 0.35, 0.18);
  tone(1046.5, t + 0.13, 0.5, 0.16);
}

export function mount(root, { store, go, id: roomId, fb }) {
  const me = store.getUid();
  const displayName = () => fb.auth.currentUser?.displayName || "Pengguna";
  let alive = true;
  let room = null;
  let members = [];
  let items = [];
  let firstItems = true;
  const seen = new Set();
  const expanded = new Set();
  const unsubs = [];
  let gone = false;

  setHTML(root, html`
    ${liveTabs("rooms")}
    <div class="room-head">
      <a href="#/rooms" class="icon-btn" aria-label="Kembali ke daftar room">${icon("back")}</a>
      <div class="room-title">
        <h1 id="r-name">Memuat…</h1>
        <button class="link small" id="r-members-btn">${icon("users")} <span id="r-count">–</span></button>
      </div>
      <button class="icon-btn" id="r-sound" aria-pressed="true"></button>
      <button class="btn btn-primary btn-sm" id="r-invite">${icon("share")} <span>Undang</span></button>
      <div class="menu-wrap">
        <button class="icon-btn" id="r-menu-btn" aria-label="Lainnya">${icon("more")}</button>
        <div class="menu menu-right" id="r-menu" hidden></div>
      </div>
    </div>

    <form class="composer" id="r-form" novalidate>
      <textarea id="r-text" rows="3" placeholder="Tulis atau tempel teks untuk dibagikan ke semua anggota…" maxlength="${store.ROOM_LIMITS.text}" aria-label="Teks untuk dikirim"></textarea>
      <div class="enc-row" id="r-enc" hidden>
        <div class="enc-note">${icon("shield")} <span>Pesan dienkripsi di perangkat Anda. Hanya yang tahu password bisa membukanya. Sampaikan password lewat jalur lain.</span></div>
        <div class="enc-fields">
          <div class="pw-wrap"><input type="password" id="r-pw" placeholder="Password pesan (min. 6)" autocomplete="new-password" aria-label="Password pesan">
            <button type="button" class="icon-btn sm" id="r-pw-eye" aria-label="Tampilkan password">${icon("eye")}</button></div>
          <input id="r-hint" maxlength="100" placeholder="Petunjuk (opsional, terlihat semua)" autocomplete="off" aria-label="Petunjuk password">
        </div>
      </div>
      <div class="composer-bar">
        <button type="button" class="btn btn-ghost btn-sm" id="r-lock" aria-pressed="false" title="Kirim sebagai pesan terenkripsi">${icon("lock")} <span>Enkripsi</span></button>
        <small class="muted only-desktop">Ctrl + Enter untuk kirim</small>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" id="r-paste">${icon("paste")} Tempel &amp; kirim</button>
        <button type="submit" class="btn btn-primary btn-sm">${icon("send")} Kirim</button>
      </div>
    </form>

    <div id="r-feed" class="feed"><div class="feed-item skeleton"><i></i><i></i></div><div class="feed-item skeleton"><i></i><i></i></div></div>`);

  const nameEl = $("#r-name", root);
  const countEl = $("#r-count", root);
  const feed = $("#r-feed", root);
  const form = $("#r-form", root);
  const ta = $("#r-text", root);
  const menu = $("#r-menu", root);
  const isOwner = () => room && room.ownerId === me;

  // Pesan terenkripsi: teks hasil dekripsi hanya disimpan di memori halaman ini
  const decrypted = new Map(); // itemId -> plaintext
  let encMode = false;
  const encRow = $("#r-enc", root);
  const lockBtn = $("#r-lock", root);
  const pwInput = $("#r-pw", root);
  const hintInput = $("#r-hint", root);
  const setEncMode = (on) => {
    encMode = on;
    encRow.hidden = !on;
    lockBtn.classList.toggle("on", on);
    lockBtn.setAttribute("aria-pressed", String(on));
    form.classList.toggle("encrypting", on);
    ta.placeholder = on ? "Tulis pesan rahasia… (akan dienkripsi sebelum dikirim)" : "Tulis atau tempel teks untuk dibagikan ke semua anggota…";
    if (on) setTimeout(() => (pwInput.value ? ta : pwInput).focus(), 30);
  };
  lockBtn.onclick = () => setEncMode(!encMode);
  $("#r-pw-eye", root).onclick = () => { pwInput.type = pwInput.type === "password" ? "text" : "password"; };

  // Tombol suara (disimpan per perangkat)
  let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } })();
  const soundBtn = $("#r-sound", root);
  const renderSoundBtn = () => {
    setHTML(soundBtn, icon(soundOn ? "bell" : "bell-off"));
    soundBtn.classList.toggle("on", soundOn);
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.title = soundOn ? "Suara notifikasi: aktif (klik untuk matikan)" : "Suara notifikasi: mati (klik untuk aktifkan)";
    soundBtn.setAttribute("aria-label", soundBtn.title);
  };
  renderSoundBtn();
  soundBtn.onclick = () => {
    soundOn = !soundOn;
    try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch {}
    renderSoundBtn();
    if (soundOn) { unlockAudio(); playNotif(); toast("Suara notifikasi aktif.", "success", 1500); }
    else toast("Suara notifikasi dimatikan.", "info", 1500);
  };
  // Browser hanya mengizinkan audio setelah ada interaksi pengguna di halaman
  const onGesture = () => unlockAudio();
  document.addEventListener("pointerdown", onGesture, { passive: true });
  document.addEventListener("keydown", onGesture);

  // ------------------------------------------------------------ Listener
  function lostAccess(msg) {
    if (gone || !alive) return;
    gone = true;
    unsubs.forEach((u) => u());
    store.forgetRoom(roomId);
    setHTML(root, html`${liveTabs("rooms")}<div class="empty">
      <div class="empty-icon">${icon("users")}</div>
      <h3>Tidak bisa membuka room</h3>
      <p class="muted">${msg}</p>
      <a class="btn btn-primary" href="#/rooms">Kembali ke daftar room</a></div>`);
  }
  const onErr = (e) => {
    console.error(e);
    if (e.code === "permission-denied") lostAccess("Anda bukan anggota room ini (mungkin sudah dikeluarkan atau room dihapus).");
    else toast("Koneksi room terputus. Periksa internet.", "error");
  };

  unsubs.push(store.watchRoom(roomId, (r) => {
    if (!alive) return;
    if (!r) return lostAccess("Room ini sudah dihapus oleh pemiliknya.");
    room = r;
    nameEl.textContent = r.name;
    document.title = `${r.name} · Catatku`;
    renderFeed();
  }, onErr));

  unsubs.push(store.watchMembers(roomId, (list) => {
    if (!alive) return;
    members = list;
    countEl.textContent = `${list.length} anggota`;
    if (!list.some((m) => m.uid === me) && list.length) lostAccess("Anda sudah dikeluarkan dari room ini.");
  }, onErr));

  unsubs.push(store.watchItems(roomId, (list) => {
    if (!alive) return;
    items = list;
    renderFeed();
  }, onErr));

  // ------------------------------------------------------------ Feed
  function initials(n) { return String(n || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase(); }

  function renderFeed() {
    if (!room) return;
    if (!items.length) {
      setHTML(feed, html`<div class="empty small-empty">
        <div class="empty-icon">${icon("send")}</div>
        <h3>Belum ada kiriman</h3>
        <p class="muted">Teks yang dikirim akan langsung muncul di semua perangkat anggota.</p></div>`);
      firstItems = false;
      return;
    }
    const fresh = new Set();
    items.forEach((it) => { if (!seen.has(it.id)) { if (!firstItems && it.uid !== me) fresh.add(it.id); seen.add(it.id); } });
    firstItems = false;
    if (fresh.size && soundOn) playNotif(); // satu bunyi walau beberapa pesan datang bersamaan
    setHTML(feed, html`${items.map((it) => {
      const mine = it.uid === me;
      const isEnc = !!it.enc;
      const plain = isEnc ? decrypted.get(it.id) : it.text;
      const locked = isEnc && plain == null;
      const text = plain || "";
      const long = !locked && (text.split("\n").length > COLLAPSE_LINES || text.length > 900);
      const open = expanded.has(it.id);
      const delBtn = mine || isOwner() ? html`<button class="icon-btn sm" data-act="del" title="Hapus" aria-label="Hapus kiriman">${icon("trash")}</button>` : "";
      return html`<article class="feed-item ${mine ? "mine" : ""} ${isEnc ? "enc" : ""} ${fresh.has(it.id) ? "fresh" : ""}" data-id="${it.id}">
        <header>
          <span class="avatar sm" aria-hidden="true">${initials(it.name)}</span>
          <b>${it.name}${mine ? " (Anda)" : ""}</b>
          <span class="muted small" title="${new Date(toMillis(it.createdAt)).toLocaleString("id-ID")}">${it.pending ? "mengirim…" : timeAgo(toMillis(it.createdAt))}</span>
          ${isEnc ? html`<span class="enc-badge" title="Pesan terenkripsi">${icon(locked ? "lock" : "unlock")} ${locked ? "Terenkripsi" : "Terbuka"}</span>` : ""}
        </header>
        ${locked ? html`
          <div class="enc-locked">
            <p>${icon("lock")} Pesan ini terenkripsi. Masukkan password untuk membacanya.</p>
            ${it.hint ? html`<p class="muted small">Petunjuk: <i>${it.hint}</i></p>` : ""}
          </div>
          <footer><span class="spacer"></span>${delBtn}
            <button class="btn btn-primary btn-sm" data-act="decrypt">${icon("unlock")} Buka pesan</button></footer>`
        : html`
          <div class="feed-text ${long && !open ? "collapsed" : ""}">${text}</div>
          <footer>
            ${long ? html`<button class="link small" data-act="toggle">${open ? "Ringkas" : "Tampilkan semua"}</button>` : ""}
            <span class="spacer"></span>
            ${isEnc ? html`<button class="btn btn-ghost btn-sm" data-act="relock" title="Sembunyikan lagi">${icon("lock")} Kunci</button>` : ""}
            ${delBtn}
            <button class="btn btn-ghost btn-sm" data-act="copy">${icon("copy")} Salin</button>
          </footer>`}
      </article>`;
    })}
    ${items.length >= store.ROOM_LIMITS.feed ? html`<p class="muted small center-text">Menampilkan ${store.ROOM_LIMITS.feed} kiriman terbaru.</p>` : ""}`);
  }

  feed.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest("[data-id]")?.dataset.id;
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const act = btn.dataset.act;
    if (act === "copy") {
      const text = it.enc ? decrypted.get(id) : it.text;
      if (text == null) return;
      (await copyText(text)) ? toast("Disalin ke clipboard.", "success", 1400) : toast("Gagal menyalin.", "error");
    } else if (act === "decrypt") {
      let attempts = 0;
      const res = await passwordDialog({
        title: "Buka pesan terenkripsi",
        message: it.hint ? `Petunjuk dari ${it.name}: ${it.hint}` : `Minta password ke ${it.name} jika belum tahu.`,
        mode: "unlock", okText: "Buka",
        onSubmit: async ({ password }) => {
          try { return await decryptWithPassword(password, it.enc); }
          catch (err) {
            // Jeda bertahap untuk memperlambat tebakan berulang
            await new Promise((r) => setTimeout(r, Math.min(4000, 400 * ++attempts)));
            throw new Error(err.code === "bad-password" ? "Password salah." : "Pesan tidak bisa didekripsi.");
          }
        },
      });
      if (res && alive) { decrypted.set(id, res.result); renderFeed(); }
    } else if (act === "relock") {
      decrypted.delete(id);
      expanded.delete(id);
      renderFeed();
    } else if (act === "toggle") {
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      renderFeed();
    } else if (act === "del") {
      const ok = await confirmDialog({ title: "Hapus kiriman?", message: "Kiriman akan hilang dari semua anggota.", okText: "Hapus", danger: true });
      if (!ok) return;
      try { await store.deleteItem(roomId, id); } catch { toast("Gagal menghapus.", "error"); }
    }
  });

  // ------------------------------------------------------------ Kirim
  let sending = false;
  async function send(text) {
    text = text.replace(/\s+$/, "");
    if (!text.trim()) { toast("Teks masih kosong."); return false; }
    if (text.length > store.ROOM_LIMITS.text) { toast(`Maksimal ${store.ROOM_LIMITS.text.toLocaleString("id-ID")} karakter per kiriman.`, "error"); return false; }
    let opts = {};
    if (encMode) {
      const pw = pwInput.value;
      const hint = hintInput.value.trim();
      if (pw.length < 6) { toast("Password pesan minimal 6 karakter.", "error"); pwInput.focus(); return false; }
      if (hint && hint.toLowerCase().includes(pw.toLowerCase())) { toast("Petunjuk tidak boleh berisi password.", "error"); hintInput.focus(); return false; }
      opts = { enc: await encryptWithPassword(pw, text), hint };
    }
    try {
      // Tidak menunggu konfirmasi server: kiriman langsung tampil ("mengirim…") lalu tersinkron.
      const { id, done } = store.sendItem(roomId, text, displayName(), opts);
      if (opts.enc) decrypted.set(id, text); // pengirim langsung bisa membaca pesannya sendiri
      done.catch((err) => {
        console.error(err);
        toast(err.code === "permission-denied" ? "Gagal mengirim: ditolak rules (publish ulang firestore.rules?)." : "Gagal mengirim.", "error", 5000);
      });
      if (opts.enc) toast("Pesan terenkripsi terkirim. Jangan lupa beri tahu password-nya.", "success", 3000);
      return true;
    } catch (err) { toast(err.message, "error"); return false; }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (sending) return;
    sending = true;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; if (encMode) btn.classList.add("loading");
    try { if (await send(ta.value)) { ta.value = ""; autoGrow(ta, 84); ta.focus(); } }
    finally { sending = false; btn.disabled = false; btn.classList.remove("loading"); }
  };
  ta.addEventListener("input", () => autoGrow(ta, 84));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  $("#r-paste", root).onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast("Clipboard kosong.");
      if (await send(text)) toast("Teks dari clipboard terkirim.", "success", 1500);
    } catch {
      toast("Browser tidak mengizinkan akses clipboard. Tempel manual (Ctrl+V / tekan lama) lalu Kirim.", "info", 4500);
      ta.focus();
    }
  };

  // ------------------------------------------------------------ Undangan
  const inviteLink = () => `${location.origin}${location.pathname}#/join/${room.code}`;

  function openInvite() {
    if (!room) return;
    const m = openModal(html`
      <h3 class="modal-title">${icon("share")} Undang ke "${room.name}"</h3>
      <p class="modal-text">Bagikan kode atau link ini. Siapa pun yang punya akun Catatku dan kode ini bisa bergabung.</p>
      <div class="invite-code" id="i-code">${store.formatCode(room.code)}</div>
      <div class="invite-actions">
        <button class="btn btn-ghost" data-i="code">${icon("copy")} Salin kode</button>
        <button class="btn btn-primary" data-i="link">${icon("link")} Salin link</button>
        ${navigator.share ? html`<button class="btn btn-ghost" data-i="share">${icon("share")} Bagikan…</button>` : ""}
      </div>
      ${isOwner() ? html`<p class="muted small">Kode bocor? Ganti kode — kode & link lama langsung tidak berlaku (anggota yang sudah ada tetap di room).</p>
        <button class="btn btn-ghost btn-sm" data-i="rotate">${icon("sync")} Ganti kode undangan</button>` : ""}
      <div class="modal-actions"><button class="btn btn-ghost" data-i="close">Tutup</button></div>`);
    m.el.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-i]")?.dataset.i;
      if (!a) return;
      if (a === "close") m.close();
      else if (a === "code") (await copyText(store.formatCode(room.code))) && toast("Kode disalin.", "success", 1400);
      else if (a === "link") (await copyText(inviteLink())) && toast("Link undangan disalin.", "success", 1400);
      else if (a === "share") { try { await navigator.share({ title: `Gabung room ${room.name}`, text: `Gabung room "${room.name}" di Catatku. Kode: ${store.formatCode(room.code)}`, url: inviteLink() }); } catch {} }
      else if (a === "rotate") {
        const btn = e.target.closest("[data-i]");
        btn.disabled = true; btn.classList.add("loading");
        try {
          const code = await store.rotateCode(roomId, room.code);
          room = { ...room, code };
          $("#i-code", m.el).textContent = store.formatCode(code);
          toast("Kode undangan diganti.", "success");
        } catch { toast("Gagal mengganti kode.", "error"); }
        btn.disabled = false; btn.classList.remove("loading");
      }
    });
  }
  $("#r-invite", root).onclick = openInvite;

  // ------------------------------------------------------------ Anggota
  function openMembers() {
    const m = openModal(html`<h3 class="modal-title">${icon("users")} Anggota (${members.length})</h3><div class="member-list" id="m-list"></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-m="close">Tutup</button></div>`);
    const render = () => setHTML($("#m-list", m.el), html`${members.map((mb) => html`
      <div class="member-row">
        <span class="avatar sm">${initials(mb.name)}</span>
        <div class="member-info"><b>${mb.name}${mb.uid === me ? " (Anda)" : ""}</b>
          <small class="muted">${mb.role === "owner" ? "Pemilik" : "Anggota"} · bergabung ${timeAgo(toMillis(mb.joinedAt))}</small></div>
        ${isOwner() && mb.uid !== me ? html`<button class="btn btn-ghost btn-sm danger-text" data-kick="${mb.uid}">Keluarkan</button>` : ""}
      </div>`)}`);
    render();
    m.el.addEventListener("click", async (e) => {
      if (e.target.closest('[data-m="close"]')) return m.close();
      const k = e.target.closest("[data-kick]");
      if (!k) return;
      const mb = members.find((x) => x.uid === k.dataset.kick);
      if (!mb) return;
      k.disabled = true; k.classList.add("loading");
      try {
        const code = await store.kickMember(roomId, mb.uid, room.code);
        room = { ...room, code };
        members = members.filter((x) => x.uid !== mb.uid);
        render();
        toast(`${mb.name} dikeluarkan. Kode undangan otomatis diganti.`, "success", 4000);
      } catch (err) { console.error(err); toast("Gagal mengeluarkan anggota.", "error"); k.disabled = false; k.classList.remove("loading"); }
    });
  }
  $("#r-members-btn", root).onclick = openMembers;

  // ------------------------------------------------------------ Menu
  $("#r-menu-btn", root).onclick = (e) => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; return; }
    setHTML(menu, isOwner()
      ? html`<button data-r="rename">${icon("edit")} Ganti nama room</button>
             <button data-r="members">${icon("users")} Anggota</button>
             <button data-r="delete" class="danger">${icon("trash")} Hapus room</button>`
      : html`<button data-r="members">${icon("users")} Anggota</button>
             <button data-r="leave" class="danger">${icon("logout")} Keluar dari room</button>`);
    menu.hidden = false;
  };
  const closeMenu = (e) => { if (!e.target.closest("#r-menu") && !e.target.closest("#r-menu-btn")) menu.hidden = true; };
  document.addEventListener("click", closeMenu);

  menu.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-r]")?.dataset.r;
    if (!a) return;
    menu.hidden = true;
    if (a === "members") openMembers();
    else if (a === "rename") renameDialog();
    else if (a === "leave") {
      const ok = await confirmDialog({ title: "Keluar dari room?", message: "Anda perlu kode undangan lagi untuk bergabung kembali.", okText: "Keluar", danger: true });
      if (!ok) return;
      try { gone = true; unsubs.forEach((u) => u()); await store.leaveRoom(roomId); toast("Anda keluar dari room.", "success"); go("#/rooms"); }
      catch { gone = false; toast("Gagal keluar dari room.", "error"); }
    } else if (a === "delete") {
      const ok = await confirmDialog({ title: "Hapus room?", message: `Room "${room.name}" beserta semua kirimannya akan dihapus permanen untuk semua anggota.`, okText: "Hapus room", danger: true });
      if (!ok) return;
      const t = toast("Menghapus room…", "info", 60000);
      try { gone = true; unsubs.forEach((u) => u()); await store.deleteRoom(roomId, room.code); t.close(); toast("Room dihapus.", "success"); go("#/rooms"); }
      catch (err) { console.error(err); t.close(); gone = false; toast("Gagal menghapus room.", "error"); }
    }
  });

  function renameDialog() {
    const m = openModal(html`<form class="stack" novalidate>
      <h3 class="modal-title">${icon("edit")} Ganti nama room</h3>
      <label class="field"><span>Nama room</span><input name="n" maxlength="60" required autofocus></label>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-c>Batal</button><button class="btn btn-primary">Simpan</button></div></form>`);
    const f = $("form", m.el);
    f.n.value = room.name;
    $("[data-c]", f).onclick = () => m.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!f.n.value.trim()) return;
      try { await store.renameRoom(roomId, f.n.value); m.close(); toast("Nama room diganti.", "success"); }
      catch { toast("Gagal mengganti nama.", "error"); }
    };
  }

  const timer = setInterval(() => { if (items.length) renderFeed(); }, 60000);

  return () => {
    alive = false;
    unsubs.forEach((u) => u());
    clearInterval(timer);
    document.removeEventListener("click", closeMenu);
    document.removeEventListener("pointerdown", onGesture);
    document.removeEventListener("keydown", onGesture);
    document.title = "Catatku";
  };
}
