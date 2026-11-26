// Renderer Markdown ringan & aman.
// Semua teks pengguna di-escape terlebih dahulu; hanya tag yang kita buat sendiri yang
// masuk ke HTML, dan link dibatasi ke http(s)/mailto. Tidak ada HTML mentah yang diizinkan.
import { esc } from "./ui.js";

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function inline(src) {
  const tokens = [];
  const stash = (h) => `\u0000${tokens.push(h) - 1}\u0000`;
  let s = src.replace(/\u0000/g, "");

  // kode inline
  s = s.replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${esc(c)}</code>`));
  // link [teks](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s"'<>`]+)\)/g, (m, t, u) =>
    SAFE_URL.test(u) ? stash(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${emphasis(esc(t))}</a>`) : m);
  // autolink
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,:;!?)\]]/g, (u) =>
    stash(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(u)}</a>`));

  s = emphasis(esc(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i]);
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([^_]+?)__/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([^~]+?)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
}

/**
 * Render markdown menjadi string HTML aman.
 * Checkbox tugas diberi data-line (indeks baris sumber) agar bisa di-toggle dari preview.
 */
export function renderMarkdown(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', items: [] }

  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const flushList = () => {
    if (!list) return;
    const cls = list.task ? ' class="task-list"' : "";
    out.push(`<${list.type}${cls}>${list.items.join("")}</${list.type}>`);
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // blok kode
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); continue; }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); continue; }

    if (/^\s{0,3}>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      i--;
      out.push(`<blockquote>${buf.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const type = /\d/.test(li[2]) ? "ol" : "ul";
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [], task: false };
      const indent = Math.min(Math.floor(li[1].replace(/\t/g, "  ").length / 2), 4);
      const style = indent ? ` class="indent-${indent}"` : "";
      const task = li[3].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        list.task = true;
        const checked = task[1] !== " ";
        list.items.push(`<li${style} data-task="1"><label><input type="checkbox" data-line="${i}"${checked ? " checked" : ""}> <span${checked ? ' class="done"' : ""}>${inline(task[2])}</span></label></li>`);
      } else {
        list.items.push(`<li${style}>${inline(li[3])}</li>`);
      }
      continue;
    }

    flushList();
    para.push(line);
  }
  flush();
  return out.join("\n");
}

/** Toggle checkbox tugas di baris tertentu pada sumber markdown. */
export function toggleTaskLine(md, lineIndex) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const l = lines[lineIndex];
  if (l == null) return md;
  lines[lineIndex] = l.replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/, (_, p, c) => `${p}[${c === " " ? "x" : " "}]`);
  return lines.join("\n");
}
