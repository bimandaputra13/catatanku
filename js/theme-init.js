// Dijalankan secara sinkron di <head> agar tidak ada kedipan tema saat halaman dimuat.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('catatku-theme') || 'system'; } catch (e) { /* storage diblokir */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
