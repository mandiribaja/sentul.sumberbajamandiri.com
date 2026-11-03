(function () {
  'use strict';

  // Menu mobile
  var toggle = document.querySelector('.navbar-toggle');
  var list = document.getElementById('nav-list');
  if (toggle && list) {
    toggle.addEventListener('click', function () {
      var open = list.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Submenu di layar sentuh: ketuk sekali membuka, ketuk kedua mengikuti tautan
  document.querySelectorAll('.nav-list .has-children > a').forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (window.matchMedia('(max-width: 900px)').matches) {
        var li = a.parentElement;
        if (!li.classList.contains('expanded')) { e.preventDefault(); li.classList.add('expanded'); }
      }
    });
  });

  // Pencarian di navbar (layar kecil): tampil sebagai ikon; ketuk ikon untuk membuka kolom input.
  // Ketuk lagi dengan kolom kosong (atau tekan Esc / ketuk di luar) untuk menutup; jika ada isi, pencarian dikirim.
  var ns = document.querySelector('.nav-search');
  if (ns) {
    var nsInput = ns.querySelector('input');
    var nsBtn = ns.querySelector('button');
    var mq = window.matchMedia('(max-width: 900px)');
    nsBtn.addEventListener('click', function (e) {
      if (!mq.matches) return;
      if (!ns.classList.contains('open')) {
        e.preventDefault();
        ns.classList.add('open');
        nsInput.focus();
      } else if (!nsInput.value.trim()) {
        e.preventDefault();
        ns.classList.remove('open');
      }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') ns.classList.remove('open'); });
    document.addEventListener('click', function (e) { if (!ns.contains(e.target)) ns.classList.remove('open'); });
  }

  // Tabel di artikel dibungkus agar bisa digeser di layar kecil
  document.querySelectorAll('.entry-content table').forEach(function (t) {
    if (t.parentElement.classList.contains('table-wrap')) return;
    var w = document.createElement('div');
    w.className = 'table-wrap';
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  });
})();
