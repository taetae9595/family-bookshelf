(function () {
  'use strict';

  window.__fbReady = false;
  window.addEventListener('error', function (e) {
    window.__fbLastError = String((e && e.message) || e);
  });

  /* ============================================================
     1. 설정 — Supabase (달력과 같은 프로젝트, 같은 가족 비밀번호)
     ============================================================ */
  var CONFIG = {
    SUPABASE_URL: 'https://tuejokazctxejnpjmwwt.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_bjAGvM3zPJvP1xX1dU2QnA_k5HhXIVy',
    FAMILY_ID: 'family',
    // 가족 비밀번호는 여기에 넣지 않습니다. 서버(비밀번호 해시)가 확인합니다.
    FAMILY_PASSCODE: ''
  };

  var KEYS = {
    books: 'fb.v1.books',
    pass: 'fb.v1.pass',
    unlocked: 'fb.v1.unlocked',
    outbox: 'fb.v1.outbox',
    sort: 'fb.v1.sort'
  };

  var GOOGLE_URL = 'https://www.googleapis.com/books/v1/volumes';
  var OPENLIB_URL = 'https://openlibrary.org/search.json';

  var COVER_COLORS = [
    ['#7E5B3F', '#5A3E27'],
    ['#6E7F63', '#49573F'],
    ['#8A6A72', '#5F4550'],
    ['#4F6478', '#334553'],
    ['#A9793F', '#7A5426'],
    ['#6B5A7E', '#493C57'],
    ['#A85F4B', '#7A3E2E'],
    ['#4C6E6A', '#32514E']
  ];

  /* ============================================================
     2. 작은 도구들
     ============================================================ */
  function $(id) { return document.getElementById(id); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayYmd() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) {
      var d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
  }

  function hashOf(text) {
    var h = 0, s = String(text || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
    return h;
  }

  function gradientFor(text) {
    var p = COVER_COLORS[hashOf(text) % COVER_COLORS.length];
    return 'linear-gradient(158deg, ' + p[0] + ' 0%, ' + p[1] + ' 100%)';
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') +
      '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ============================================================
     3. 상태
     ============================================================ */
  var state = {
    books: [],
    sort: localStorage.getItem(KEYS.sort) || 'recent',
    query: '',
    mode: null,       // 'new' | 'edit'
    editId: null,
    editCreatedAt: '',
    tmpCover: '',
    rating: null,
    deleteArmed: false
  };

  function storedPass() { return localStorage.getItem(KEYS.pass) || ''; }

  function isRemote() { return !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY); }

  function apiBase() { return String(CONFIG.SUPABASE_URL).replace(/\/+$/, ''); }

  /* ============================================================
     4. 서버 통신
     ============================================================ */
  function ApiError(status, body) {
    this.name = 'ApiError';
    this.status = status;
    this.body = body || '';
    this.message = 'HTTP ' + status + ' ' + this.body;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function rpc(fn, body) {
    if (!isRemote()) return Promise.reject(new Error('no-server'));
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    return fetch(apiBase() + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body || {}),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        if (timer) clearTimeout(timer);
        if (!res.ok) throw new ApiError(res.status, text);
        if (!text) return null;
        try { return JSON.parse(text); } catch (e) { return text; }
      });
    });
  }

  function isAuthError(err) {
    if (!err || err.name !== 'ApiError') return false;
    if (err.status === 401 || err.status === 403) return true;
    var body = String(err.body);
    return body.indexOf('invalid_passcode') >= 0 ||
      body.indexOf('28000') >= 0 ||
      body.indexOf('가족 비밀번호가 달라요') >= 0;
  }

  function fetchJSON(url) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  /* ============================================================
     5. 책 데이터
     ============================================================ */
  function rowToBook(r) {
    return {
      id: String(r.id),
      title: String(r.title || ''),
      author: String(r.author || ''),
      cover: String(r.cover || ''),
      date: String(r.read_date || '').slice(0, 10),
      rating: (r.rating === null || r.rating === undefined) ? null : Number(r.rating),
      review: String(r.review || ''),
      created_at: String(r.created_at || '')
    };
  }

  function isValidBook(b) {
    return b && typeof b === 'object' && typeof b.id === 'string' && typeof b.title === 'string';
  }

  function readCache() {
    var list = readJSON(KEYS.books, []);
    return Array.isArray(list) ? list.filter(isValidBook) : [];
  }

  function cacheBooks() {
    var slim = state.books.map(function (b) {
      var c = {
        id: b.id, title: b.title, author: b.author, date: b.date,
        rating: b.rating, review: b.review, created_at: b.created_at,
        cover: (b.cover && b.cover.indexOf('data:') === 0) ? '' : b.cover
      };
      return c;
    });
    if (!writeJSON(KEYS.books, slim)) writeJSON(KEYS.books, slim.map(function (b) {
      b.cover = ''; return b;
    }));
  }

  function sortVisible() {
    var q = state.query.trim().toLowerCase();
    var list = state.books.filter(function (b) {
      if (!q) return true;
      return (b.title + ' ' + b.author).toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      if (state.sort === 'rating') {
        var ra = (a.rating === null || a.rating === undefined) ? -1 : a.rating;
        var rb = (b.rating === null || b.rating === undefined) ? -1 : b.rating;
        if (rb !== ra) return rb - ra;
      }
      var da = a.date || '', db = b.date || '';
      if (da !== db) return da < db ? 1 : -1;
      var ca = a.created_at || '', cb = b.created_at || '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      return 0;
    });
    return list;
  }

  /* ============================================================
     6. 표지 그리기
     ============================================================ */
  function showPlaceholder(box, book) {
    box.style.background = gradientFor(book.title || '');
    var ph = document.createElement('div');
    ph.className = 'ph';
    var t = document.createElement('div');
    t.className = 'ph-title';
    t.textContent = book.title || '제목 없음';
    ph.appendChild(t);
    if (book.author) {
      var a = document.createElement('div');
      a.className = 'ph-author';
      a.textContent = book.author;
      ph.appendChild(a);
    }
    box.appendChild(ph);
  }

  function paintCover(box, book) {
    var img = box.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      box.appendChild(img);
    }
    var old = box.querySelector('.ph');
    if (old) old.remove();
    box.style.background = '';
    img.onerror = null;

    if (book.cover) {
      img.hidden = false;
      img.onerror = function () {
        img.hidden = true;
        img.removeAttribute('src');
        showPlaceholder(box, book);
      };
      img.src = book.cover;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      showPlaceholder(box, book);
    }
  }

  function makeDefaultCover(title, author) {
    var W = 480, H = 720;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    var p = COVER_COLORS[hashOf(title) % COVER_COLORS.length];

    var grad = g.createLinearGradient(0, 0, W * 0.6, H);
    grad.addColorStop(0, p[0]);
    grad.addColorStop(1, p[1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    g.globalAlpha = 0.055;
    g.fillStyle = '#ffffff';
    for (var i = 0; i < 46; i++) g.fillRect(0, Math.random() * H, W, 1);
    g.globalAlpha = 1;

    g.strokeStyle = 'rgba(255, 248, 236, .34)';
    g.lineWidth = 2;
    g.strokeRect(24, 24, W - 48, H - 48);

    var size = title.length > 26 ? 32 : title.length > 16 ? 38 : title.length > 8 ? 46 : 54;
    g.font = '700 ' + size + 'px "Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#FDF6E9';

    var lines = wrapLines(g, title, W - 108).slice(0, 5);
    var lh = size * 1.34;
    var startY = H * 0.48 - (lines.length - 1) * lh / 2;
    for (var k = 0; k < lines.length; k++) g.fillText(lines[k], W / 2, startY + k * lh);

    g.fillStyle = 'rgba(253, 246, 233, .72)';
    g.fillRect(W / 2 - 26, H * 0.48 + (lines.length - 1) * lh / 2 + size * 1.05, 52, 2);

    if (author) {
      g.font = '400 22px "Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",serif';
      g.fillStyle = 'rgba(253, 246, 233, .85)';
      var au = String(author);
      while (g.measureText(au).width > W - 120 && au.length > 4) au = au.slice(0, au.length - 2);
      if (au !== String(author)) au = au.slice(0, -1) + '…';
      g.fillText(au, W / 2, H - 64);
    }

    try { return c.toDataURL('image/jpeg', 0.86); }
    catch (e) { return ''; }
  }

  function wrapLines(g, text, maxW) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var t = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(t).width > maxW && line) { lines.push(line); line = words[i]; }
      else line = t;
    }
    if (line) lines.push(line);

    var out = [];
    for (var j = 0; j < lines.length; j++) {
      var l = lines[j];
      if (g.measureText(l).width <= maxW) { out.push(l); continue; }
      var chunk = '';
      for (var c = 0; c < l.length; c++) {
        if (g.measureText(chunk + l[c]).width > maxW && chunk) { out.push(chunk); chunk = l[c]; }
        else chunk += l[c];
      }
      if (chunk) out.push(chunk);
    }
    return out;
  }

  function fileToCover(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var maxW = 520;
          var scale = Math.min(1, maxW / img.width);
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var g = c.getContext('2d');
          g.fillStyle = '#FFFFFF';
          g.fillRect(0, 0, w, h);
          g.drawImage(img, 0, 0, w, h);
          try { resolve(c.toDataURL('image/jpeg', 0.82)); }
          catch (e) { reject(e); }
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ============================================================
     7. 책장 그리기
     ============================================================ */
  function perRow(width) {
    var w = width || 358;
    var n = Math.floor((w + 11) / 112);
    return Math.max(2, Math.min(5, n));
  }

  function render() {
    var shelves = $('shelves');
    var list = sortVisible();

    $('countText').textContent = state.books.length ? '책 ' + state.books.length + '권' : '';
    shelves.innerHTML = '';

    if (!state.books.length) {
      shelves.appendChild(emptyBox('🌱', '아직 책장이 비어 있어요', '오른쪽 위 <strong>+ 책 추가</strong>를 눌러<br />읽은 책을 한 권씩 꽂아 보세요.'));
      return;
    }
    if (!list.length) {
      shelves.appendChild(emptyBox('🔍', '찾는 책이 없어요', '다른 제목이나 저자로 찾아보세요.'));
      return;
    }

    var n = perRow(shelves.clientWidth);
    for (var i = 0; i < list.length; i += n) {
      var row = document.createElement('div');
      row.className = 'shelf-row';

      var booksEl = document.createElement('div');
      booksEl.className = 'shelf-books';
      booksEl.style.gridTemplateColumns = 'repeat(' + n + ', minmax(0, 1fr))';

      var slice = list.slice(i, i + n);
      for (var j = 0; j < slice.length; j++) booksEl.appendChild(bookCard(slice[j]));

      var plank = document.createElement('div');
      plank.className = 'plank';

      row.appendChild(booksEl);
      row.appendChild(plank);
      shelves.appendChild(row);
    }
  }

  function emptyBox(emoji, title, html) {
    var box = document.createElement('div');
    box.className = 'empty';
    var e = document.createElement('span');
    e.className = 'empty-emoji';
    e.textContent = emoji;
    var s = document.createElement('strong');
    s.textContent = title;
    var p = document.createElement('p');
    p.innerHTML = html;
    box.appendChild(e); box.appendChild(s); box.appendChild(p);
    return box;
  }

  function bookCard(book) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'book';
    btn.setAttribute('aria-label', (book.title || '제목 없음') + (book.author ? ' · ' + book.author : '') + ' 기록 열기');

    var cover = document.createElement('span');
    cover.className = 'book-cover';

    paintCover(cover, book);

    if (book.rating !== null && book.rating !== undefined && book.rating > 0) {
      var badge = document.createElement('span');
      badge.className = 'book-badge';
      badge.textContent = '★ ' + (book.rating % 1 === 0 ? String(book.rating) : book.rating.toFixed(1));
      cover.appendChild(badge);
    }

    btn.appendChild(cover);
    btn.addEventListener('click', function () { openBook('edit', book); });
    return btn;
  }

  /* ============================================================
     8. 시트 열고 닫기
     ============================================================ */
  function openSheet(name) {
    $(name === 'add' ? 'addSheet' : 'bookSheet').hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closeSheet(name) {
    $(name === 'add' ? 'addSheet' : 'bookSheet').hidden = true;
    document.body.classList.remove('sheet-open');
    if (name === 'book') {
      // 삭제 확인(두 번 누르기) 상태는 창을 닫으면 풀립니다.
      state.deleteArmed = false;
      var del = $('dDelete');
      del.classList.remove('armed');
      del.textContent = '삭제';
    }
  }

  function closeAllSheets() {
    closeSheet('add');
    closeSheet('book');
  }

  /* ============================================================
     9. 상세 / 기록
     ============================================================ */
  function openBook(mode, book) {
    state.mode = mode;
    state.editId = mode === 'edit' ? book.id : null;
    state.editCreatedAt = book.created_at || '';
    state.tmpCover = book.cover || '';
    state.rating = (book.rating === null || book.rating === undefined) ? null : Number(book.rating);
    state.deleteArmed = false;

    $('bookSheetTitle').textContent = mode === 'edit' ? '책 기록' : '새 책';
    $('dTitle').value = book.title || '';
    $('dAuthor').value = book.author || '';
    $('dDate').value = book.date || todayYmd();
    $('dReview').value = book.review || '';
    $('dCoverUrl').value = /^https?:/i.test(book.cover || '') ? book.cover : '';
    $('coverTools').hidden = true;

    var del = $('dDelete');
    del.hidden = mode !== 'edit';
    del.classList.remove('armed');
    del.textContent = '삭제';

    $('dSave').textContent = mode === 'edit' ? '저장' : '책장에 꽂기';

    updateReviewCount();
    paintDetailCover();
    paintStars();
    openSheet('book');
  }

  function paintDetailCover() {
    paintCover($('dCoverBox'), {
      cover: state.tmpCover,
      title: $('dTitle').value.trim(),
      author: $('dAuthor').value.trim()
    });
  }

  function updateReviewCount() {
    var n = $('dReview').value.length;
    $('dReviewCount').textContent = n + '/200';
  }

  function saveBook() {
    var title = $('dTitle').value.trim();
    if (!title) {
      toast('책 제목을 먼저 넣어 주세요');
      $('dTitle').focus();
      return;
    }
    var author = $('dAuthor').value.trim();
    var review = $('dReview').value.trim();
    var cover = state.tmpCover || makeDefaultCover(title, author);
    var isNew = state.mode !== 'edit';

    var book = {
      id: state.editId || uuid(),
      title: title,
      author: author,
      cover: cover,
      date: $('dDate').value || todayYmd(),
      rating: state.rating,
      review: review,
      created_at: isNew ? new Date().toISOString() : (state.editCreatedAt || new Date().toISOString())
    };

    upsertLocal(book);
    render();
    closeSheet('book');
    toast(isNew ? '책장에 꽂았어요' : '저장했어요');
    pushBook(book);
  }

  function upsertLocal(book) {
    var found = false;
    for (var i = 0; i < state.books.length; i++) {
      if (state.books[i].id === book.id) { state.books[i] = book; found = true; break; }
    }
    if (!found) state.books.unshift(book);
    cacheBooks();
  }

  function removeLocal(id) {
    state.books = state.books.filter(function (b) { return b.id !== id; });
    cacheBooks();
  }

  function deleteBook() {
    var btn = $('dDelete');
    if (!state.deleteArmed) {
      state.deleteArmed = true;
      btn.classList.add('armed');
      btn.textContent = '정말 삭제할까요?';
      return;
    }

    var id = state.editId;
    state.deleteArmed = false;
    removeLocal(id);
    render();
    closeSheet('book');
    toast('책장에서 뺐어요');
    if (!isRemote()) return;

    rpc('family_delete_book', { p_passcode: storedPass(), p_id: id, p_family_id: CONFIG.FAMILY_ID })
      .then(function () { setStatus('online'); })
      .catch(function (err) {
        if (isAuthError(err)) { lock('가족 비밀번호가 바뀐 것 같아요. 다시 입력해 주세요.'); return; }
        queueOp({ kind: 'delete', id: id });
        setStatus('offline');
        toast('인터넷이 없어 이 기기에서만 뺐어요. 연결되면 서버에도 반영할게요');
      });
  }

  /* ============================================================
     10. 서버 저장 / 대기열
     ============================================================ */
  function pushBook(book) {
    if (!isRemote()) return;
    rpc('family_save_book', {
      p_passcode: storedPass(),
      p_id: book.id,
      p_title: book.title,
      p_author: book.author || null,
      p_cover: book.cover || null,
      p_read_date: book.date || todayYmd(),
      p_rating: (book.rating === null || book.rating === undefined) ? null : book.rating,
      p_review: book.review || null,
      p_family_id: CONFIG.FAMILY_ID
    }).then(function (row) {
      if (row && row.id) {
        upsertLocal(rowToBook(row));
        render();
      }
      setStatus('online');
    }).catch(function (err) {
      if (isAuthError(err)) { lock('가족 비밀번호가 바뀐 것 같아요. 다시 입력해 주세요.'); return; }
      queueOp({ kind: 'save', id: book.id, book: book });
      setStatus('offline');
      toast('인터넷이 없어 이 기기에 저장했어요. 연결되면 서버에 올릴게요');
    });
  }

  function readOutbox() {
    var v = readJSON(KEYS.outbox, []);
    return Array.isArray(v) ? v : [];
  }

  function writeOutbox(v) { writeJSON(KEYS.outbox, v); }

  function queueOp(op) {
    var q = readOutbox().filter(function (o) { return o.id !== op.id; });
    q.push(op);
    writeOutbox(q);
  }

  function flushOutbox() {
    if (!isRemote()) return Promise.resolve();
    var q = readOutbox();
    if (!q.length) return Promise.resolve();
    var i = 0;

    function next() {
      if (i >= q.length) { writeOutbox([]); return Promise.resolve(); }
      var op = q[i++];
      var p;
      if (op.kind === 'delete') {
        p = rpc('family_delete_book', { p_passcode: storedPass(), p_id: op.id, p_family_id: CONFIG.FAMILY_ID });
      } else {
        var b = op.book;
        p = rpc('family_save_book', {
          p_passcode: storedPass(), p_id: b.id, p_title: b.title,
          p_author: b.author || null, p_cover: b.cover || null,
          p_read_date: b.date || todayYmd(),
          p_rating: (b.rating === null || b.rating === undefined) ? null : b.rating,
          p_review: b.review || null, p_family_id: CONFIG.FAMILY_ID
        });
      }
      return p.then(next).catch(function (err) {
        writeOutbox(q.slice(i - 1));
        if (isAuthError(err)) lock('가족 비밀번호가 바뀐 것 같아요. 다시 입력해 주세요.');
        return Promise.resolve();
      });
    }
    return next();
  }

  function loadBooks() {
    if (!isRemote()) {
      state.books = readCache();
      setStatus('local');
      render();
      return Promise.resolve();
    }
    if (!storedPass()) {
      state.books = readCache();
      render();
      return Promise.resolve();
    }
    setStatus('sync');
    return rpc('family_load_books', { p_passcode: storedPass(), p_family_id: CONFIG.FAMILY_ID })
      .then(function (res) {
        var rows = (res && res.items) || [];
        state.books = rows.map(rowToBook).filter(isValidBook);
        cacheBooks();
        setStatus('online');
        render();
      })
      .catch(function (err) {
        setStatus('offline');
        if (!state.books.length) { state.books = readCache(); render(); }
        if (isAuthError(err)) lock('가족 비밀번호가 바뀐 것 같아요. 다시 입력해 주세요.');
      });
  }

  /* ============================================================
     11. 잠금
     ============================================================ */
  function gateMsg(text, info) {
    var m = $('gateMsg');
    m.textContent = text || '';
    m.className = 'gate-msg' + (info ? ' info' : '');
  }

  function attemptUnlock(code) {
    if (!isRemote()) {
      return Promise.resolve(!!CONFIG.FAMILY_PASSCODE && code === String(CONFIG.FAMILY_PASSCODE));
    }
    return rpc('family_unlock', { p_passcode: code, p_family_id: CONFIG.FAMILY_ID })
      .then(function (ok) { return ok === true; })
      .catch(function (err) {
        if (isAuthError(err)) return false;
        if (code && storedPass() === code) return 'offline';
        throw err;
      });
  }

  function grant(status) {
    localStorage.setItem(KEYS.unlocked, '1');
    $('gate').hidden = true;
    document.body.classList.remove('locked');
    gateMsg('');
    if (status === 'offline') setStatus('offline');
    state.books = readCache();
    render();
    loadBooks().then(flushOutbox);
  }

  function lock(msg) {
    localStorage.removeItem(KEYS.unlocked);
    localStorage.removeItem(KEYS.pass);
    closeAllSheets();
    $('gate').hidden = false;
    document.body.classList.add('locked');
    $('gateInput').value = '';
    $('gateSubmit').disabled = false;
    gateMsg(msg || '');
    setStatus('locked');
    setTimeout(function () { try { $('gateInput').focus(); } catch (e) {} }, 60);
  }

  function setStatus(kind) {
    var dot = $('statusDot'), txt = $('statusText');
    if (kind === 'online') { dot.className = 'dot on'; txt.textContent = '가족과 함께 쓰는 중 · 서버 연결됨'; }
    else if (kind === 'offline') { dot.className = 'dot off'; txt.textContent = '오프라인 · 이 기기에 저장 중'; }
    else if (kind === 'locked') { dot.className = 'dot'; txt.textContent = '잠겨 있어요'; }
    else if (kind === 'local') { dot.className = 'dot'; txt.textContent = '이 기기에만 저장 중'; }
    else { dot.className = 'dot'; txt.textContent = '서버에 연결하는 중…'; }
  }

  /* ============================================================
     12. 검색 (Google Books + Open Library)
     ============================================================ */
  function cleanCoverUrl(url) {
    return String(url).replace(/^http:/i, 'https:').replace(/&edge=curl/g, '').trim();
  }

  function searchGoogle(q) {
    var url = GOOGLE_URL + '?q=' + encodeURIComponent(q) + '&maxResults=12&printType=books&orderBy=relevance';
    return fetchJSON(url).then(function (data) {
      var items = (data && data.items) || [];
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var v = items[i].volumeInfo || {};
        var links = v.imageLinks || {};
        var cover = links.thumbnail || links.smallThumbnail || '';
        if (!v.title) continue;
        out.push({
          title: v.subtitle ? v.title + ' : ' + v.subtitle : v.title,
          author: (v.authors || []).join(', '),
          cover: cover ? cleanCoverUrl(cover) : '',
          year: String(v.publishedDate || '').slice(0, 4),
          source: 'Google Books'
        });
      }
      return out;
    });
  }

  function searchOpenLibrary(q) {
    var url = OPENLIB_URL + '?q=' + encodeURIComponent(q) + '&limit=12' +
      '&fields=key,title,subtitle,author_name,cover_i,first_publish_year';
    return fetchJSON(url).then(function (data) {
      var docs = (data && data.docs) || [];
      var out = [];
      for (var i = 0; i < docs.length; i++) {
        var d = docs[i];
        if (!d.title) continue;
        out.push({
          title: d.subtitle ? d.title + ' : ' + d.subtitle : d.title,
          author: (d.author_name || []).slice(0, 3).join(', '),
          cover: d.cover_i ? ('https://covers.openlibrary.org/b/id/' + d.cover_i + '-L.jpg') : '',
          year: d.first_publish_year ? String(d.first_publish_year) : '',
          source: 'Open Library'
        });
      }
      return out;
    });
  }

  function normKey(s) {
    return String(s || '').toLowerCase().replace(/[\s:·,.\-()\[\]]/g, '');
  }

  function dedupe(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var key = normKey(b.title) + '|' + normKey(b.author);
      if (seen[key] === undefined) { seen[key] = out.length; out.push(b); }
      else {
        var prev = out[seen[key]];
        if (!prev.cover && b.cover) prev.cover = b.cover;
        if (!prev.year && b.year) prev.year = b.year;
      }
    }
    return out;
  }

  function setSearchState(text, warn) {
    var s = $('searchState');
    s.hidden = false;
    s.textContent = text;
    s.className = 'search-state' + (warn ? ' warn' : '');
  }

  function runSearch(q) {
    q = String(q || '').trim();
    if (!q) { $('bookQuery').focus(); return; }

    $('searchBtn').disabled = true;
    $('results').innerHTML = '';
    setSearchState('표지를 찾고 있어요…', false);

    var failed = { google: false, openlib: false };
    var g = searchGoogle(q).catch(function () { failed.google = true; return []; });
    var o = searchOpenLibrary(q).catch(function () { failed.openlib = true; return []; });

    Promise.all([g, o]).then(function (groups) {
      $('searchBtn').disabled = false;
      var list = dedupe(groups[0].concat(groups[1]));

      if (!list.length) {
        setSearchState(
          (failed.google && failed.openlib)
            ? '인터넷 검색에 연결하지 못했어요. 아래에서 직접 추가할 수 있어요.'
            : '검색 결과가 없어요. 다른 제목으로 찾아보거나 아래에서 직접 추가해 주세요.',
          true);
        return;
      }

      var note = '';
      if (failed.google) note = ' (Google Books 응답 없음 · Open Library 결과)';
      else if (failed.openlib) note = ' (Open Library 응답 없음 · Google Books 결과)';

      setSearchState(list.length + '권을 찾았어요. 책을 고르면 오늘 날짜로 꽂힙니다.' + note, false);
      renderResults(list);
    });
  }

  function renderResults(list) {
    var box = $('results');
    box.innerHTML = '';
    for (var i = 0; i < list.length; i++) box.appendChild(resultCard(list[i]));
  }

  function resultCard(b) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'result';

    var cover = document.createElement('span');
    cover.className = 'book-cover';
    paintCover(cover, b);

    var t = document.createElement('div');
    t.className = 'result-title';
    t.textContent = b.title;

    var sub = document.createElement('div');
    sub.className = 'result-sub';
    sub.textContent = [b.author, b.year].filter(Boolean).join(' · ') || b.source || '';

    btn.appendChild(cover);
    btn.appendChild(t);
    btn.appendChild(sub);

    btn.addEventListener('click', function () {
      closeSheet('add');
      openBook('new', {
        title: b.title,
        author: b.author,
        cover: b.cover || '',
        date: todayYmd(),
        rating: null,
        review: ''
      });
      if (!b.cover) toast('표지가 없어 기본 표지로 시작할게요. 표지 바꾸기에서 사진을 넣을 수 있어요.');
    });
    return btn;
  }

  /* ============================================================
     13. 별점
     ============================================================ */
  function buildStars() {
    var box = $('dStars');
    box.innerHTML = '';
    for (var i = 1; i <= 5; i++) {
      var star = document.createElement('span');
      star.className = 'star';
      var bg = document.createElement('span');
      bg.className = 'star-bg';
      bg.textContent = '★';
      var fg = document.createElement('span');
      fg.className = 'star-fg';
      fg.textContent = '★';
      var left = document.createElement('button');
      left.type = 'button';
      left.className = 'half left';
      left.setAttribute('aria-label', (i - 0.5) + '점');
      var right = document.createElement('button');
      right.type = 'button';
      right.className = 'half right';
      right.setAttribute('aria-label', i + '점');
      star.appendChild(bg); star.appendChild(fg); star.appendChild(left); star.appendChild(right);
      box.appendChild(star);
    }

    box.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('half')) {
        var v = Number(t.getAttribute('aria-label').replace('점', ''));
        state.rating = (state.rating === v) ? null : v;
        paintStars();
      }
    });
  }

  function paintStars() {
    var stars = $('dStars').children;
    var v = state.rating;
    for (var i = 0; i < stars.length; i++) {
      var fill = 0;
      if (v !== null && v !== undefined) fill = Math.max(0, Math.min(1, v - i));
      var fg = stars[i].querySelector('.star-fg');
      fg.style.width = (fill * 100) + '%';
    }
    var txt = '—';
    if (v !== null && v !== undefined) txt = (v % 1 === 0 ? String(v) : v.toFixed(1)) + '점';
    $('dRateValue').textContent = txt;
    $('dRateClear').hidden = (v === null || v === undefined);
  }

  /* ============================================================
     14. 이벤트 연결
     ============================================================ */
  function bind() {
    // 잠금 화면
    $('gateForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var code = $('gateInput').value.trim();
      if (!code) { gateMsg('비밀번호를 입력해 주세요'); return; }

      $('gateSubmit').disabled = true;
      gateMsg('확인하는 중…', true);

      attemptUnlock(code).then(function (res) {
        $('gateSubmit').disabled = false;
        if (res === true || res === 'offline') {
          localStorage.setItem(KEYS.pass, code);
          grant(res === 'offline' ? 'offline' : 'online');
        } else {
          gateMsg('비밀번호가 맞지 않아요');
          $('gateInput').value = '';
          $('gateInput').classList.add('shake');
          setTimeout(function () { $('gateInput').classList.remove('shake'); }, 360);
          $('gateInput').focus();
        }
      }).catch(function () {
        $('gateSubmit').disabled = false;
        gateMsg('인터넷에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      });
    });

    // 상단
    $('lockBtn').addEventListener('click', function () { lock(''); });
    $('addBtn').addEventListener('click', function () {
      $('bookQuery').value = '';
      $('results').innerHTML = '';
      $('searchState').hidden = true;
      openSheet('add');
      setTimeout(function () { try { $('bookQuery').focus(); } catch (e) {} }, 120);
    });

    // 책장 검색
    var searchTimer = null;
    $('searchInput').addEventListener('input', function () {
      state.query = $('searchInput').value;
      $('searchClear').hidden = !state.query;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(render, 140);
    });
    $('searchClear').addEventListener('click', function () {
      $('searchInput').value = '';
      state.query = '';
      $('searchClear').hidden = true;
      render();
    });

    // 정렬
    var chips = $('sorts').querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function (e) {
        var sort = e.currentTarget.getAttribute('data-sort');
        state.sort = sort;
        try { localStorage.setItem(KEYS.sort, sort); } catch (err) {}
        for (var k = 0; k < chips.length; k++) chips[k].classList.toggle('is-on', chips[k] === e.currentTarget);
        render();
      });
      chips[i].classList.toggle('is-on', chips[i].getAttribute('data-sort') === state.sort);
    }

    // 책 추가 시트
    $('searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      runSearch($('bookQuery').value);
    });
    $('manualToggle').addEventListener('click', function () {
      closeSheet('add');
      openBook('new', { title: '', author: '', cover: '', date: todayYmd(), rating: null, review: '' });
      $('coverTools').hidden = false;
      setTimeout(function () { try { $('dTitle').focus(); } catch (err) {} }, 150);
    });

    // 시트 닫기
    var closers = document.querySelectorAll('[data-close]');
    for (var c = 0; c < closers.length; c++) {
      closers[c].addEventListener('click', function (e) {
        closeSheet(e.currentTarget.getAttribute('data-close'));
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAllSheets();
    });

    // 상세 시트
    $('dTitle').addEventListener('input', function () {
      if (!state.tmpCover) paintDetailCover();
    });
    $('dAuthor').addEventListener('input', function () {
      if (!state.tmpCover) paintDetailCover();
    });
    $('dReview').addEventListener('input', updateReviewCount);
    $('dSave').addEventListener('click', saveBook);
    $('dDelete').addEventListener('click', deleteBook);
    $('dRateClear').addEventListener('click', function () { state.rating = null; paintStars(); });

    $('dCoverToggle').addEventListener('click', function () {
      $('coverTools').hidden = !$('coverTools').hidden;
    });
    $('dCoverUrlApply').addEventListener('click', function () {
      var url = $('dCoverUrl').value.trim();
      if (!/^https?:\/\//i.test(url)) { toast('http:// 또는 https:// 로 시작하는 주소를 넣어 주세요'); return; }
      state.tmpCover = url;
      paintDetailCover();
      toast('표지 주소를 넣었어요');
    });
    $('dCoverGen').addEventListener('click', function () {
      var title = $('dTitle').value.trim();
      if (!title) { toast('제목을 먼저 넣어 주세요'); $('dTitle').focus(); return; }
      state.tmpCover = makeDefaultCover(title, $('dAuthor').value.trim());
      paintDetailCover();
      toast('기본 표지를 만들었어요');
    });
    $('dCoverRemove').addEventListener('click', function () {
      state.tmpCover = '';
      paintDetailCover();
    });
    $('dCoverFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      fileToCover(file).then(function (dataUrl) {
        state.tmpCover = dataUrl;
        paintDetailCover();
        toast('사진을 표지로 넣었어요');
      }).catch(function () {
        toast('사진을 읽지 못했어요. 다른 사진으로 해보세요.');
      });
      e.target.value = '';
    });

    // 화면 크기 바뀌면 책장 다시 배치
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 200);
    });

    // 다른 기기에서 바꾼 내용 반영
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (document.body.classList.contains('locked')) return;
      if (!$('addSheet').hidden || !$('bookSheet').hidden) return;
      if (!storedPass()) return;
      loadBooks().then(flushOutbox);
    });
  }

  /* ============================================================
     15. 시작
     ============================================================ */
  function boot() {
    buildStars();
    bind();
    setStatus('sync');

    if (!isRemote()) {
      $('gateInput').hidden = true;
      $('gateSubmit').textContent = '열기';
      gateMsg('서버 설정이 비어 있어 이 기기에만 저장됩니다.', true);
      grant('local');
      return;
    }

    var saved = storedPass();
    if (!saved || localStorage.getItem(KEYS.unlocked) !== '1') {
      gateMsg('');
      try { $('gateInput').focus(); } catch (e) {}
      return;
    }

    gateMsg('책장을 여는 중…', true);
    $('gateSubmit').disabled = true;
    attemptUnlock(saved).then(function (res) {
      $('gateSubmit').disabled = false;
      if (res === true || res === 'offline') {
        localStorage.setItem(KEYS.pass, saved);
        grant(res === 'offline' ? 'offline' : 'online');
      } else {
        localStorage.removeItem(KEYS.pass);
        localStorage.removeItem(KEYS.unlocked);
        gateMsg('비밀번호를 다시 입력해 주세요.');
        try { $('gateInput').focus(); } catch (e) {}
      }
    }).catch(function () {
      $('gateSubmit').disabled = false;
      gateMsg('인터넷에 연결하지 못했어요. 비밀번호를 입력해 주세요.', true);
    });

    window.__fbReady = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 서비스 워커 (홈 화면 앱으로 쓸 때)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
