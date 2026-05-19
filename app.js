/* ============================================================
   FlashCards — Bilgi Kartları PWA
   React (CDN UMD) + h() helper (JSX yok, build adımı yok)
   ============================================================ */
(function () {
  'use strict';

  var React = window.React;
  var ReactDOM = window.ReactDOM;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useMemo = React.useMemo;

  // React.createElement sarmalayıcı: h(tag, props, ...children)
  function h(type, props) {
    var children = Array.prototype.slice.call(arguments, 2);
    return React.createElement.apply(React, [type, props].concat(children));
  }

  // ---------- Yardımcılar ----------

  var STORAGE_KEY = 'flashcards.v1';
  var THEME_KEY = 'flashcards.theme';
  var ONBOARDED_KEY = 'flashcards.onboarded.v1';
  var CATCHUP_KEY = 'flashcards.catchupEnabled';
  // Sprint 6: marketplace
  var MARKETPLACE_DEFAULT_URL = 'https://raw.githubusercontent.com/ArdaBerkayGurbuz/flashcards-content/main/decks/';
  var MARKETPLACE_URL_KEY = 'flashcards.marketplace.url';
  var MARKETPLACE_CACHE_KEY = 'flashcards.marketplace.v1';
  var MARKETPLACE_TTL = 3600000; // 1 saat

  function marketplaceBaseUrl() {
    try {
      var u = localStorage.getItem(MARKETPLACE_URL_KEY);
      if (u && /^https?:\/\//.test(u)) return u.charAt(u.length - 1) === '/' ? u : u + '/';
    } catch (e) {}
    return MARKETPLACE_DEFAULT_URL;
  }

  // Tema: kayıtlı seçim varsa onu, yoksa cihaz tercihini kullan
  function getInitialTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) {}
    try {
      if (window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: light)').matches) {
        return 'light';
      }
    } catch (e) {}
    return 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // tarayıcı UI rengi (durum çubuğu) temayla uyumlu
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#F6F1FA' : '#160F2B');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ===== Sprint 5: Toplu kart metni parse (saf, modül seviyesi) =====
     Ayraç önceliği: tab en spesifik; boşluklu varyantlar çıplaktan
     önce gelir ki "21:30 - randevu"da ' - ' yakalansın, ':' (saat)
     bozulmasın. Çıplak ':' bilinçli YOK (saat çakışmasın). */
  var BULK_SEPARATORS = ['\t', ' | ', '|', ' - ', ' = ', ' : ', ': '];

  function parseBulkCards(text) {
    var result = { cards: [], errors: [] };
    if (!text || !text.trim()) return result;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim(); // \r dahil baş/son boşluk temizlenir
      if (!line) continue;            // boş satır → atla
      if (line.charAt(0) === '#') continue; // yorum → atla

      var sep = null, sepIdx = -1;
      for (var s = 0; s < BULK_SEPARATORS.length; s++) {
        var idx = line.indexOf(BULK_SEPARATORS[s]);
        if (idx > 0) { sep = BULK_SEPARATORS[s]; sepIdx = idx; break; }
      }
      if (sep === null) {
        result.errors.push({
          lineNumber: i + 1, content: line, reason: 'Ayraç bulunamadı'
        });
        continue;
      }
      var front = line.substring(0, sepIdx).trim();
      var back = line.substring(sepIdx + sep.length).trim();
      if (!front || !back) {
        result.errors.push({
          lineNumber: i + 1, content: line, reason: 'Soru veya cevap boş'
        });
        continue;
      }
      result.cards.push({ front: front, back: back });
    }
    return result;
  }

  /* ===== Sprint 6: Marketplace ağ katmanı (saf, modül seviyesi) ===== */

  // Promise + AbortController timeout. Hata → reject (App kullanıcı
  // dostu mesaja çevirir). Repo henüz yoksa burası reddeder, graceful.
  function fetchJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof fetch !== 'function') {
        reject(new Error('FETCH_UNSUPPORTED')); return;
      }
      var ctrl = null, timer = null;
      try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
      if (ctrl) {
        timer = setTimeout(function () {
          try { ctrl.abort(); } catch (e) {}
        }, timeoutMs || 30000);
      }
      fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) {
          reject(new Error(res.status === 403 ? 'RATE_LIMIT' : 'HTTP_' + res.status));
          return;
        }
        return res.json();
      }).then(function (data) {
        if (data !== undefined) resolve(data);
      }).catch(function (err) {
        if (timer) clearTimeout(timer);
        reject(err && err.name === 'AbortError' ? new Error('TIMEOUT') : err);
      });
    });
  }

  function validateManifest(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.decks)) return null;
    var decks = obj.decks.filter(function (d) {
      return d && typeof d === 'object' &&
        typeof d.id === 'string' && typeof d.name === 'string' &&
        typeof d.url === 'string';
    });
    return decks.length ? { version: obj.version || 1, decks: decks } : null;
  }

  function validateDeckJSON(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.cards)) return null;
    var cards = obj.cards.filter(function (c) {
      return c && typeof c === 'object' &&
        c.front != null && c.back != null;
    });
    if (!cards.length) return null;
    return {
      id: typeof obj.id === 'string' ? obj.id : ('mp_' + uid()),
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name : 'İndirilen Deste',
      imageBaseUrl: typeof obj.imageBaseUrl === 'string' ? obj.imageBaseUrl : '',
      suggestedContext: (obj.suggestedContext && typeof obj.suggestedContext === 'object')
        ? obj.suggestedContext : null,
      cards: cards
    };
  }

  // Manifest cache: { ts, data }. force=true → ağdan zorla.
  // Dönüş: { data, stale } | reject (cache yok + ağ hatası).
  function loadMarketplaceManifest(force) {
    var cached = null;
    try {
      var raw = localStorage.getItem(MARKETPLACE_CACHE_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch (e) { cached = null; }
    var fresh = cached && cached.ts &&
      (Date.now() - cached.ts < MARKETPLACE_TTL) && cached.data;
    if (!force && fresh) {
      return Promise.resolve({ data: cached.data, stale: false });
    }
    return fetchJSON(marketplaceBaseUrl() + 'manifest.json', 15000)
      .then(function (json) {
        var v = validateManifest(json);
        if (!v) throw new Error('BAD_MANIFEST');
        try {
          localStorage.setItem(MARKETPLACE_CACHE_KEY,
            JSON.stringify({ ts: Date.now(), data: v }));
        } catch (e) {}
        return { data: v, stale: false };
      })
      .catch(function (err) {
        // Ağ/parse hatası: eski cache varsa onu döndür (çevrimdışı)
        if (cached && cached.data) return { data: cached.data, stale: true };
        throw err;
      });
  }

  function emptyState() {
    return {
      version: 1,
      decks: [],
      stats: {
        totalSessions: 0,
        totalSeen: 0,
        totalCorrect: 0,
        perDeck: {} // deckId -> { sessions, seen, correct }
      }
    };
  }

  // Şema doğrulama + eksik alan tamamlama (içe aktarma / ilk yükleme için)
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!Array.isArray(raw.decks)) return null;
    var st = emptyState();
    st.decks = raw.decks
      .filter(function (d) { return d && typeof d === 'object'; })
      .map(function (d) {
        return {
          id: typeof d.id === 'string' ? d.id : uid(),
          name: typeof d.name === 'string' && d.name.trim() ? d.name : 'İsimsiz deste',
          createdAt: d.createdAt || Date.now(),
          lastStudied: d.lastStudied || null,
          cards: Array.isArray(d.cards) ? d.cards
            .filter(function (c) { return c && typeof c === 'object'; })
            .map(function (c) {
              var card = {
                id: typeof c.id === 'string' ? c.id : uid(),
                q: String(c.q == null ? '' : c.q),
                a: String(c.a == null ? '' : c.a),
                createdAt: c.createdAt || Date.now()
              };
              // Sprint 6: opsiyonel zengin alanlar — yalnız doluysa yaz
              if (typeof c.pronunciation === 'string' && c.pronunciation)
                card.pronunciation = c.pronunciation;
              if (typeof c.example === 'string' && c.example)
                card.example = c.example;
              if (typeof c.exampleTranslation === 'string' && c.exampleTranslation)
                card.exampleTranslation = c.exampleTranslation;
              if (typeof c.image === 'string' && c.image)
                card.image = c.image;
              return card;
            }) : []
        };
      });
    if (raw.stats && typeof raw.stats === 'object') {
      var s = raw.stats;
      st.stats.totalSessions = Number(s.totalSessions) || 0;
      st.stats.totalSeen = Number(s.totalSeen) || 0;
      st.stats.totalCorrect = Number(s.totalCorrect) || 0;
      if (s.perDeck && typeof s.perDeck === 'object') {
        Object.keys(s.perDeck).forEach(function (k) {
          var p = s.perDeck[k] || {};
          st.stats.perDeck[k] = {
            sessions: Number(p.sessions) || 0,
            seen: Number(p.seen) || 0,
            correct: Number(p.correct) || 0
          };
        });
      }
    }
    return st;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seedState();
      var parsed = JSON.parse(raw);
      var norm = normalizeState(parsed);
      return norm || seedState();
    } catch (e) {
      console.warn('Durum okunamadı, sıfırdan başlanıyor:', e);
      return seedState();
    }
  }

  // İlk açılış boş başlar — örnek deste onboarding 3. ekrandan oluşturulur
  function seedState() {
    return emptyState();
  }

  var saveTimer = null;
  function persist(state) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        console.error('Kaydedilemedi (depolama dolu olabilir):', e);
      }
    }, 180);
  }

  /* ===== Bağlam (Context) veri katmanı — ayrı anahtar ===== */

  var CONTEXTS_KEY = 'flashcards.contexts.v1';

  function emptyContextsState() {
    return { contexts: [], cardContextLinks: {}, triggers: [] };
  }

  // Savunmacı normalize: bozuk/eksik veriden çökmeyiz
  function normalizeContextsState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!Array.isArray(raw.contexts)) return null;
    var st = emptyContextsState();
    st.contexts = raw.contexts
      .filter(function (c) { return c && typeof c === 'object'; })
      .map(function (c) {
        var loc = null;
        if (c.location && typeof c.location === 'object' &&
            typeof c.location.lat === 'number' &&
            typeof c.location.lng === 'number') {
          loc = {
            lat: c.location.lat,
            lng: c.location.lng,
            radiusMeters: Number(c.location.radiusMeters) || 100,
            label: typeof c.location.label === 'string' ? c.location.label : ''
          };
        }
        var tm = null;
        if (c.time && typeof c.time === 'object' &&
            typeof c.time.start === 'string' && typeof c.time.end === 'string') {
          tm = {
            start: c.time.start,
            end: c.time.end,
            daysOfWeek: Array.isArray(c.time.daysOfWeek)
              ? c.time.daysOfWeek.filter(function (d) {
                  return typeof d === 'number' && d >= 0 && d <= 6;
                })
              : []
          };
        }
        return {
          id: typeof c.id === 'string' ? c.id : ('ctx_' + uid()),
          name: typeof c.name === 'string' && c.name.trim() ? c.name : 'İsimsiz bağlam',
          emoji: typeof c.emoji === 'string' && c.emoji ? c.emoji : '📍',
          location: loc,
          time: tm,
          notificationEnabled: c.notificationEnabled !== false,
          maxCardsPerTrigger: clampInt(c.maxCardsPerTrigger, 1, 20, 5),
          cooldownMinutes: Number(c.cooldownMinutes) || 60,
          createdAt: c.createdAt || Date.now(),
          updatedAt: c.updatedAt || Date.now()
        };
      });
    // cardContextLinks / triggers bu sprint kullanılmıyor ama şemada korunur
    if (raw.cardContextLinks && typeof raw.cardContextLinks === 'object' &&
        !Array.isArray(raw.cardContextLinks)) {
      st.cardContextLinks = raw.cardContextLinks;
    }
    if (Array.isArray(raw.triggers)) st.triggers = raw.triggers;
    return st;
  }

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function loadContextsState() {
    try {
      var raw = localStorage.getItem(CONTEXTS_KEY);
      if (!raw) return emptyContextsState();
      var norm = normalizeContextsState(JSON.parse(raw));
      return norm || emptyContextsState();
    } catch (e) {
      console.warn('Bağlam durumu okunamadı, sıfırdan:', e);
      return emptyContextsState();
    }
  }

  var ctxSaveTimer = null;
  function persistContexts(state) {
    if (ctxSaveTimer) clearTimeout(ctxSaveTimer);
    ctxSaveTimer = setTimeout(function () {
      try {
        localStorage.setItem(CONTEXTS_KEY, JSON.stringify(state));
      } catch (e) {
        console.error('Bağlam kaydedilemedi:', e);
      }
    }, 180);
  }

  // Bir bağlamın insancıl özet metni (liste satırında gösterilir)
  var DAY_SHORT = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

  function formatDays(days) {
    if (!days || days.length === 0) return '';
    if (days.length === 7) return 'Her gün';
    // Hafta-içi sıralı bir aralık mı? (örn. [1,2,3,4,5] -> Pzt–Cum)
    var sorted = days.slice().sort(function (a, b) { return a - b; });
    var contiguous = true;
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
    }
    if (contiguous && sorted.length >= 3) {
      return DAY_SHORT[sorted[0]] + '–' + DAY_SHORT[sorted[sorted.length - 1]];
    }
    return sorted.map(function (d) { return DAY_SHORT[d]; }).join(', ');
  }

  function contextSummary(ctx) {
    var parts = [];
    if (ctx.time) {
      parts.push(ctx.time.start + '–' + ctx.time.end);
      var dn = formatDays(ctx.time.daysOfWeek);
      if (dn) parts.push(dn);
    }
    if (ctx.location) {
      var locTxt = ctx.location.radiusMeters + 'm yarıçap';
      if (ctx.location.label && ctx.location.label.trim()) {
        locTxt += ' · ' + ctx.location.label.trim();
      }
      parts.push(locTxt);
    }
    return parts.length ? parts.join(' · ') : 'Sınırsız';
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ===== Sprint 3: Tetikleme yardımcıları (saf, modül seviyesi) ===== */

  // İki koordinat arası mesafe (metre) — Haversine
  function haversineMeters(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // "HH:MM" → bugünün tarihinde Date
  function timeStringToToday(hhmm) {
    var parts = String(hhmm || '').split(':');
    var h = parseInt(parts[0], 10) || 0;
    var m = parseInt(parts[1], 10) || 0;
    var d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  // Şu an bu zaman penceresinde mi? (gece-yarısı wrap dahil)
  function isInTimeWindow(time, nowDate) {
    if (!time) return true; // zaman kuralı yoksa her zaman geçerli
    var now = nowDate || new Date();
    var dow = now.getDay(); // 0=Pazar
    if (Array.isArray(time.daysOfWeek) && time.daysOfWeek.length &&
        time.daysOfWeek.indexOf(dow) < 0) {
      return false;
    }
    var start = timeStringToToday(time.start);
    var end = timeStringToToday(time.end);
    start.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
    end.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
    if (end < start) {
      // gece-yarısı geçişi (örn. 22:00–02:00)
      return now >= start || now <= end;
    }
    return now >= start && now <= end;
  }

  // navigator.geolocation Promise sarmalayıcı
  function getCurrentLocationP(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('GEO_NOT_SUPPORTED'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          });
        },
        function (err) { reject(err); },
        {
          enableHighAccuracy: false,
          timeout: opts.timeout || 8000,
          maximumAge: opts.maximumAge || 300000
        }
      );
    });
  }

  var GEO_DENIED_KEY = 'flashcards.geoPermissionDenied';

  // reasons kodlarını Türkçe banner metnine çevir
  function reasonLabel(reason, ctx) {
    if (reason === 'location') {
      return '📍 ' + (ctx.location ? ctx.location.radiusMeters + 'm' : '') + ' içinde';
    }
    if (reason === 'time') return '⏰ Şu an zamanın';
    if (reason === 'always') return '♾️ Her zaman';
    return reason;
  }

  /* ===== Sprint 4: Bildirim izni (modül seviyesi, saf) ===== */

  function notificationSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  // 'unsupported' | 'granted' | 'denied' | 'default'
  function notificationPermState() {
    if (!notificationSupported()) return 'unsupported';
    return Notification.permission; // 'granted'|'denied'|'default'
  }

  function ensureNotificationPermission() {
    return new Promise(function (resolve) {
      if (!notificationSupported()) { resolve('unsupported'); return; }
      if (Notification.permission === 'granted') { resolve('granted'); return; }
      if (Notification.permission === 'denied') { resolve('denied'); return; }
      try {
        var p = Notification.requestPermission(function (r) { resolve(r); });
        if (p && typeof p.then === 'function') {
          p.then(function (r) { resolve(r); }).catch(function () { resolve('denied'); });
        }
      } catch (e) { resolve('denied'); }
    });
  }

  // Bildirim metni şablonu (Türkçe)
  function buildContextNotification(ctx, cardCount) {
    return {
      title: ctx.emoji + ' ' + ctx.name,
      body: cardCount + ' kart seni bekliyor',
      tag: 'ctx-' + ctx.id, // aynı bağlamın bildirimi üst üste binmesin
      data: { contextId: ctx.id, action: 'study' }
    };
  }

  // İzin granted ise sistem bildirimi göster (SW varsa onun üzerinden)
  function showContextNotification(ctx, cardCount, iconUrl) {
    if (!notificationSupported() || Notification.permission !== 'granted') return;
    var spec = buildContextNotification(ctx, cardCount);
    var opts = {
      body: spec.body, tag: spec.tag, data: spec.data,
      icon: iconUrl, badge: iconUrl
    };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          reg.showNotification(spec.title, opts);
        }).catch(function () {
          try { new Notification(spec.title, opts); } catch (e) {}
        });
      } else {
        new Notification(spec.title, opts);
      }
    } catch (e) { /* yut */ }
  }

  function pct(correct, seen) {
    if (!seen) return 0;
    return Math.round((correct / seen) * 100);
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (e) { return '—'; }
  }

  function todayStamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  // ---------- Ortak bileşenler ----------

  function Modal(props) {
    function onBackdrop(e) {
      if (e.target === e.currentTarget && props.onClose) props.onClose();
    }
    return h('div', { className: 'modal-backdrop', onClick: onBackdrop },
      h('div', { className: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', null, props.title),
        props.children
      )
    );
  }

  function Toast(props) {
    useEffect(function () {
      var t = setTimeout(props.onDone, 2200);
      return function () { clearTimeout(t); };
    }, []);
    return h('div', { className: 'toast' }, props.text);
  }

  /* ===== Sprint 4: Onboarding (3 ekran, route'tan bağımsız overlay) ===== */

  function OnboardingOverlay(props) {
    var stepH = useState(0); // 0/1/2 — localStorage'a YAZILMAZ (session-only)
    var step = stepH[0], setStep = stepH[1];

    function finish(withSample) {
      if (withSample) props.onSample();
      props.onFinish();
    }

    var dots = h('div', { className: 'onb-dots' },
      [0, 1, 2].map(function (i) {
        return h('span', { key: i, className: 'onb-dot' + (i === step ? ' on' : '') });
      })
    );
    var skip = h('button', {
      className: 'linkbtn onb-skip', onClick: function () { finish(false); },
      'aria-label': 'Tanıtımı atla'
    }, 'Atla');

    var screens = [
      h('div', { className: 'onb-screen', key: 's0' },
        h('div', { className: 'onb-art' }, '🗂️'),
        h('h2', { className: 'onb-title' }, "FlashCards'a hoş geldin"),
        h('p', { className: 'onb-text' }, 'Bilgi kartlarını oluştur, çalış, hatırla.'),
        h('button', { className: 'btn primary full lg', onClick: function () { setStep(1); } }, 'Devam')
      ),
      h('div', { className: 'onb-screen', key: 's1' },
        h('div', { className: 'onb-art' }, '📍⏰'),
        h('h2', { className: 'onb-title' }, 'Yeni: Bağlamsal Hatırlatma'),
        h('p', { className: 'onb-text' },
          'Kartlarını konuma, zamana ve duruma bağla. Kafedeyken kafe kelimelerini, yatmadan önce gece tekrar kartlarını çıkar.'),
        h('div', { className: 'onb-fake-banner' },
          h('div', { className: 'onb-fb-head' }, '☕ Sabah Kahvesi'),
          h('div', { className: 'onb-fb-count' }, '7 kart seni bekliyor'),
          h('div', { className: 'onb-fb-reason' }, '📍 100m içinde · ⏰ Şu an zamanın')
        ),
        h('button', { className: 'btn primary full lg', onClick: function () { setStep(2); } }, 'Devam')
      ),
      h('div', { className: 'onb-screen', key: 's2' },
        h('div', { className: 'onb-art' }, '🚀'),
        h('h2', { className: 'onb-title' }, 'Hazırsın!'),
        h('p', { className: 'onb-text' },
          'İstersen örnek bir deste ile başla, ya da kendi destenle ilerle.'),
        h('button', { className: 'btn primary full lg', onClick: function () { finish(true); } },
          'Örnek desteyle başla'),
        h('div', { className: 'spacer-sm' }),
        h('button', { className: 'btn ghost full', onClick: function () { finish(false); } },
          'Boş başla')
      )
    ];

    return h('div', { className: 'onb-backdrop', role: 'dialog', 'aria-modal': 'true' },
      h('div', { className: 'aurora-bg onb-aurora', 'aria-hidden': 'true' }),
      h('div', { className: 'onb-card' },
        skip,
        screens[step],
        dots
      )
    );
  }

  // ---------- Deste listesi ekranı ----------

  function DeckListView(props) {
    var decks = props.state.decks;

    if (decks.length === 0) {
      return h('div', { className: 'empty' },
        h('div', { className: 'big' }, 'Henüz deste yok'),
        h('p', null, 'Çalışmaya başlamak için ilk destenizi oluşturun. Her destenin içine soru-cevap kartları eklersiniz.'),
        h('button', { className: 'btn primary lg', onClick: props.onNew }, '＋  İlk desteyi oluştur')
      );
    }

    return h('div', null,
      h('div', { className: 'section-head' },
        h('span', { className: 'lbl' }, decks.length + ' deste'),
        h('button', { className: 'linkbtn', onClick: props.onNew }, '＋ Yeni deste')
      ),
      h('div', { className: 'deck-list' },
        decks.map(function (d) {
          return h('div', { className: 'deck', key: d.id },
            h('h2', null, d.name),
            h('div', { className: 'meta' },
              d.cards.length + ' kart  ·  son çalışma: ' + fmtDate(d.lastStudied)
            ),
            h('div', { className: 'deck-actions' },
              h('button', {
                className: 'btn primary',
                disabled: d.cards.length === 0,
                onClick: function () { props.onStudy(d.id); }
              }, '▶  Çalış'),
              h('button', { className: 'btn ghost', onClick: function () { props.onOpen(d.id); } }, 'Kartlar'),
              h('button', { className: 'linkbtn', onClick: function () { props.onRename(d); } }, 'Ad'),
              h('button', { className: 'linkbtn danger', onClick: function () { props.onDelete(d); } }, 'Sil')
            )
          );
        })
      )
    );
  }

  // ---------- Deste detay (kart yönetimi) ----------

  function DeckDetailView(props) {
    var deck = props.deck;
    return h('div', null,
      h('div', { className: 'section-head' },
        h('span', { className: 'lbl' }, deck.cards.length + ' kart'),
        h('button', { className: 'linkbtn', onClick: function () { props.onAddCard(); } }, '＋ Kart ekle')
      ),
      deck.cards.length === 0
        ? h('div', { className: 'empty' },
            h('div', { className: 'big' }, 'Bu deste boş'),
            h('p', null, 'Çalışabilmek için en az bir kart ekleyin.'),
            h('button', { className: 'btn primary', onClick: function () { props.onAddCard(); } }, '＋  Kart ekle')
          )
        : h('div', null,
            deck.cards.map(function (c) {
              return h('div', { className: 'card-row', key: c.id },
                h('div', { className: 'q' }, c.q || '(boş soru)'),
                h('div', { className: 'a' }, c.a || '(boş cevap)'),
                h('div', { className: 'row-actions' },
                  h('button', { className: 'linkbtn', onClick: function () { props.onEditCard(c); } }, '✎ Düzenle'),
                  h('button', { className: 'linkbtn danger', onClick: function () { props.onDeleteCard(c); } }, '🗑 Sil')
                )
              );
            }),
            h('div', { className: 'spacer-sm' }),
            h('button', {
              className: 'btn primary full lg',
              disabled: deck.cards.length === 0,
              onClick: function () { props.onStudy(deck.id); }
            }, '▶  Bu desteyi çalış')
          )
    );
  }

  // ---------- Çalışma modu ----------

  function StudyView(props) {
    var deck = props.deck;
    // Bağlam modunda props.cards gelir; yoksa deste kartları (geriye uyumlu)
    var sourceCards = props.cards || deck.cards;
    // queue: ana kuyruk, requeue: bilmiyorum denenler
    var initial = useMemo(function () {
      return shuffle(sourceCards);
    }, [props.sessionKey || deck.id]);
    var st = useState(function () {
      return {
        // current ilk karttır; kuyruk ondan SONRAKİLERİ tutar
        // (aksi halde ilk kart iki kez sorulur)
        queue: initial.slice(1),
        requeue: [],
        current: initial[0] || null,
        flipped: false,
        seen: 0,
        correct: 0,
        total: initial.length,
        done: false
      };
    });
    var s = st[0], setS = st[1];

    // Sprint: kart geçiş animasyonu durumu (slide-out → advance → slide-in)
    var aSt = useState('idle'); // 'idle' | 'leaving' | 'entering'
    var anim = aSt[0], setAnim = aSt[1];
    var animTimer = useRef(null);
    // CSS .leaving=.48s / .entering=.62s. SWAP_MS: çıkış bitmeden
    // advance+entering tetikle → eski/yeni bindirme (crossfade, boş an yok)
    var LEAVE_MS = 480, ENTER_MS = 620, SWAP_MS = 300;

    function advance(rating) {
      // rating: 'good' | 'maybe' | 'bad'
      setS(function (p) {
        var q = p.queue.slice();
        var rq = p.requeue.slice();
        var seen = p.seen + 1;
        var correct = p.correct + (rating === 'good' ? 1 : 0);
        if (rating === 'bad' && p.current) rq.push(p.current);

        var next = null;
        if (q.length > 0) {
          next = q.shift();
        } else if (rq.length > 0) {
          // tekrar kuyruğunu karıştırıp ana kuyruğa al
          q = shuffle(rq);
          rq = [];
          next = q.shift();
        }

        if (!next) {
          return {
            queue: [], requeue: [], current: null, flipped: false,
            seen: seen, correct: correct, total: p.total, done: true
          };
        }
        return {
          queue: q, requeue: rq, current: next, flipped: false,
          seen: seen, correct: correct, total: p.total, done: false
        };
      });
    }

    // advance'i saran geçiş: eski kart kayıp çıkar → advance → yeni kart gelir
    function requestAdvance(rating) {
      if (anim !== 'idle') return; // çift-tık / geçiş ortası kilidi
      setAnim('leaving');
      // SWAP_MS'te (çıkış bitmeden) advance + entering → eski/yeni
      // bindirir (crossfade), boş kare olmaz. idle, girişin tam
      // bitişinde: SWAP_MS + ENTER_MS sonra.
      animTimer.current = setTimeout(function () {
        advance(rating); // mevcut mantık aynen (queue/requeue/done)
        setAnim('entering');
        animTimer.current = setTimeout(function () {
          setAnim('idle');
        }, ENTER_MS);
      }, SWAP_MS);
    }

    // Geçiş animasyon timer'ını unmount'ta temizle
    useEffect(function () {
      return function () {
        if (animTimer.current) clearTimeout(animTimer.current);
      };
    }, []);

    function toggleFlip() {
      if (anim !== 'idle') return; // geçiş ortasında flip'i engelle
      setS(function (p) { return Object.assign({}, p, { flipped: !p.flipped }); });
    }

    // Klavye: boşluk = çevir, 1/2/3 = değerlendir
    useEffect(function () {
      function onKey(e) {
        if (s.done) return;
        if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); toggleFlip(); }
        else if (s.flipped && (e.key === '1')) requestAdvance('bad');
        else if (s.flipped && (e.key === '2')) requestAdvance('maybe');
        else if (s.flipped && (e.key === '3')) requestAdvance('good');
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, [s.flipped, s.done, anim]);

    // Seans bitince istatistikleri kaydet (bir kez)
    var savedRef = useRef(false);
    useEffect(function () {
      if (s.done && !savedRef.current) {
        savedRef.current = true;
        props.onFinish(deck.id, s.seen, s.correct);
      }
    }, [s.done]);

    var headerTitle = props.titleOverride || deck.name;

    if (s.done) {
      return h('div', { className: 'study' },
        h('div', { className: 'summary' },
          h('div', { className: 'seal' }, '🎉'),
          h('h2', null, 'İyi iş!'),
          h('div', { className: 'lead' }, headerTitle + ' · seans tamamlandı'),
          h('div', { className: 'summary-stats' },
            h('div', { className: 'stat-cell' },
              h('div', { className: 'num' }, s.seen),
              h('div', { className: 'cap' }, 'Görülen')),
            h('div', { className: 'stat-cell' },
              h('div', { className: 'num' }, s.correct),
              h('div', { className: 'cap' }, 'Biliyorum')),
            h('div', { className: 'stat-cell' },
              h('div', { className: 'num' }, pct(s.correct, s.seen) + '%'),
              h('div', { className: 'cap' }, 'Başarı'))
          ),
          h('button', { className: 'btn primary full lg', onClick: props.onExit }, 'Bitir'),
          h('div', { className: 'spacer-sm' }),
          h('button', { className: 'btn ghost full', onClick: props.onRestart }, '↻  Tekrar çalış')
        )
      );
    }

    var card = s.current;
    var progress = s.total > 0 ? Math.round((s.seen / (s.seen + s.queue.length + s.requeue.length + 1)) * 100) : 0;

    // Yığın görünümü: aktif kartın arkasında kalan kart sayısına göre
    // (max 3) dekoratif boş katman — son kartta yığın yok
    var remaining = s.queue.length + s.requeue.length;
    var stackCount = remaining >= 3 ? 3 : remaining;
    var stackLayers = [];
    for (var li = 0; li < stackCount; li++) {
      stackLayers.push(h('div', {
        className: 'flashcard-stack stack-' + (li + 1),
        key: 'stk' + li, 'aria-hidden': 'true'
      }));
    }
    var wrapCls = 'card-anim-wrap' +
      (anim === 'leaving' ? ' leaving' : anim === 'entering' ? ' entering' : '');

    return h('div', { className: 'study' },
      h('div', { className: 'study-top' },
        h('button', { className: 'iconbtn', onClick: props.onExit, 'aria-label': 'Çıkış' }, '✕'),
        h('div', { className: 'progress-track' },
          h('div', { className: 'progress-fill', style: { width: progress + '%' } })
        ),
        h('div', { className: 'progress-count' },
          s.seen + ' / ' + (s.seen + s.queue.length + s.requeue.length + 1))
      ),
      h('div', { className: 'flip-area', onClick: toggleFlip },
        stackLayers,
        h('div', { className: wrapCls },
        h('div', { className: 'flashcard' + (s.flipped ? ' flipped' : ''), role: 'button', 'aria-label': 'Kartı çevir' },
          h('div', { className: 'face front' },
            h('div', { className: 'tag' }, 'SORU'),
            (card && card.image)
              ? h('img', {
                  className: 'face-img', src: card.image, alt: '',
                  loading: 'lazy',
                  onError: function (e) { e.target.style.display = 'none'; }
                })
              : null,
            h('div', { className: 'text' }, card ? card.q : ''),
            (card && card.pronunciation)
              ? h('div', { className: 'face-pron' }, card.pronunciation)
              : null,
            h('div', { className: 'hint' }, 'Cevabı görmek için dokun')
          ),
          h('div', { className: 'face back' },
            h('div', { className: 'tag' }, 'CEVAP'),
            h('div', { className: 'text' }, card ? card.a : ''),
            (card && card.example)
              ? h('div', { className: 'face-ex' }, '“' + card.example + '”')
              : null,
            (card && card.exampleTranslation)
              ? h('div', { className: 'face-ex-tr' }, card.exampleTranslation)
              : null
          )
        )
        )
      ),
      s.flipped
        ? h('div', { className: 'rate-row' + (anim !== 'idle' ? ' hidden' : '') },
            h('button', { className: 'rate bad', onClick: function (e) { e.stopPropagation(); requestAdvance('bad'); } },
              h('span', { className: 'ic' }, '✕'), h('span', null, 'Bilmiyorum')),
            h('button', { className: 'rate maybe', onClick: function (e) { e.stopPropagation(); requestAdvance('maybe'); } },
              h('span', { className: 'ic' }, '~'), h('span', null, 'Kararsız')),
            h('button', { className: 'rate good', onClick: function (e) { e.stopPropagation(); requestAdvance('good'); } },
              h('span', { className: 'ic' }, '✓'), h('span', null, 'Biliyorum'))
          )
        : h('div', { className: 'tap-hint' }, 'Karta dokun, sonra kendini değerlendir')
    );
  }

  // ---------- İstatistik ekranı ----------

  function StatsView(props) {
    var stats = props.state.stats;
    var decks = props.state.decks;
    var deckById = {};
    decks.forEach(function (d) { deckById[d.id] = d; });

    var perRows = Object.keys(stats.perDeck).map(function (id) {
      var p = stats.perDeck[id];
      return {
        name: deckById[id] ? deckById[id].name : '(silinmiş deste)',
        sessions: p.sessions, seen: p.seen, correct: p.correct
      };
    }).filter(function (r) { return r.seen > 0; });

    // Sprint 4: bağlam aktivitesi — son 7 gün engaged trigger sayısı
    var cx = props.ctxState || { contexts: [], triggers: [] };
    var weekAgo = Date.now() - 7 * 86400000;
    var trigByCtx = {};
    (cx.triggers || []).forEach(function (t) {
      if (t.engaged && t.triggeredAt >= weekAgo) {
        trigByCtx[t.contextId] = (trigByCtx[t.contextId] || 0) + 1;
      }
    });
    var ctxActivity = (cx.contexts || []).map(function (c) {
      return { id: c.id, name: c.name, emoji: c.emoji, count: trigByCtx[c.id] || 0 };
    });
    var maxAct = ctxActivity.reduce(function (m, a) {
      return a.count > m ? a.count : m;
    }, 0);

    return h('div', null,
      h('div', { className: 'stat-hero' },
        h('div', { className: 'pct' }, pct(stats.totalCorrect, stats.totalSeen) + '%'),
        h('div', { className: 'pct-cap' }, 'Genel başarı oranı')
      ),
      h('div', { className: 'stat-grid' },
        h('div', { className: 'stat-cell' },
          h('div', { className: 'num' }, stats.totalSessions),
          h('div', { className: 'cap' }, 'Seans')),
        h('div', { className: 'stat-cell' },
          h('div', { className: 'num' }, stats.totalSeen),
          h('div', { className: 'cap' }, 'Görülen')),
        h('div', { className: 'stat-cell' },
          h('div', { className: 'num' }, stats.totalCorrect),
          h('div', { className: 'cap' }, 'Doğru'))
      ),
      h('div', { className: 'section-head' },
        h('span', { className: 'lbl' }, 'Deste bazlı kırılım')
      ),
      perRows.length === 0
        ? h('div', { className: 'empty' },
            h('p', null, 'Henüz çalışma kaydı yok. Bir deste çalıştığınızda istatistikler burada görünecek.'))
        : h('div', { className: 'stat-table' },
            h('div', { className: 'thead' },
              h('div', null, 'Deste'),
              h('div', { style: { textAlign: 'right' } }, 'Sns'),
              h('div', { style: { textAlign: 'right' } }, 'Görü'),
              h('div', { style: { textAlign: 'right' } }, '%')
            ),
            perRows.map(function (r, i) {
              return h('div', { className: 'trow', key: i },
                h('div', { className: 'name' }, r.name),
                h('div', { className: 'n' }, r.sessions),
                h('div', { className: 'n' }, r.seen),
                h('div', { className: 'n hl' }, pct(r.correct, r.seen) + '%')
              );
            })
          ),
      ctxActivity.length > 0
        ? h('div', null,
            h('div', { className: 'section-head', style: { marginTop: '22px' } },
              h('span', { className: 'lbl' }, 'Bağlam Aktivitesi (son 7 gün)')
            ),
            ctxActivity.map(function (a) {
              var w = maxAct > 0 ? Math.round((a.count / maxAct) * 100) : 0;
              return h('div', { className: 'actrow', key: a.id },
                h('div', { className: 'actrow-top' },
                  h('span', { className: 'actrow-name' }, a.emoji + ' ' + a.name),
                  h('span', { className: 'actrow-n mono' }, a.count + ' seans')
                ),
                h('div', { className: 'actbar' },
                  h('div', { className: 'actbar-fill', style: { width: Math.max(w, 4) + '%' } })
                )
              );
            })
          )
        : null,
      h('div', { className: 'spacer-sm' }),
      h('button', { className: 'linkbtn danger', onClick: props.onReset }, 'İstatistikleri sıfırla')
    );
  }

  // ---------- Veri ekranı (JSON dışa/içe) ----------

  // ---------- Sprint 6: Gelişmiş + Depolama (marketplace) ----------
  function MarketplaceSettings() {
    var urlH = useState(function () {
      try { return localStorage.getItem(MARKETPLACE_URL_KEY) || ''; }
      catch (e) { return ''; }
    });
    var url = urlH[0], setUrl = urlH[1];
    var imgCntH = useState(null);
    var imgCnt = imgCntH[0], setImgCnt = imgCntH[1];
    var msgH = useState('');
    var msg = msgH[0], setMsg = msgH[1];

    function calcImages() {
      if (!('caches' in window)) { setImgCnt('—'); return; }
      caches.open('flashcards-mp-images-v1').then(function (c) {
        return c.keys();
      }).then(function (keys) {
        setImgCnt(keys.length);
      }).catch(function () { setImgCnt('—'); });
    }
    useEffect(function () { calcImages(); }, []);

    function saveUrl() {
      try {
        if (url && /^https?:\/\//.test(url)) {
          localStorage.setItem(MARKETPLACE_URL_KEY, url);
        } else {
          localStorage.removeItem(MARKETPLACE_URL_KEY);
        }
        localStorage.removeItem(MARKETPLACE_CACHE_KEY);
        setMsg('Kaydedildi — Keşfet sekmesinde yenile');
      } catch (e) { setMsg('Kaydedilemedi'); }
    }
    function clearImgCache() {
      if (!('caches' in window)) return;
      caches.delete('flashcards-mp-images-v1').then(function () {
        setMsg('Görsel cache temizlendi'); calcImages();
      });
    }

    return h('div', null,
      h('div', { className: 'panel' },
        h('h3', null, 'Gelişmiş'),
        h('p', null, 'Hazır deste kaynağı (boş bırakırsan varsayılan kullanılır):'),
        h('div', { className: 'field' },
          h('input', {
            type: 'text', value: url,
            placeholder: MARKETPLACE_DEFAULT_URL,
            onChange: function (e) { setUrl(e.target.value); }
          })
        ),
        h('button', { className: 'btn ghost', onClick: saveUrl },
          'Kaydet ve cache temizle'),
        msg ? h('p', { className: 'mono', style: { fontSize: '12px', color: 'var(--ink-faint)', marginTop: '8px' } }, msg) : null
      ),
      h('div', { className: 'panel' },
        h('h3', null, 'Depolama'),
        h('p', null, 'Marketplace görselleri (önbellek): ' +
          (imgCnt === null ? '…' : imgCnt) + (typeof imgCnt === 'number' ? ' dosya' : '')),
        h('button', { className: 'btn ghost', onClick: clearImgCache },
          'Görsel cache’ini temizle')
      )
    );
  }

  function DataView(props) {
    var fileRef = useRef(null);

    function doExport() {
      try {
        // Mevcut deste/kart/istatistik + bağlam verisi tek dosyada (additif)
        var out = Object.assign({}, props.state, {
          contexts: props.ctxState.contexts,
          cardContextLinks: props.ctxState.cardContextLinks,
          triggers: props.ctxState.triggers,
          exportVersion: 2
        });
        var data = JSON.stringify(out, null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'flashcards-yedek-' + todayStamp() + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        props.toast('Yedek indirildi');
      } catch (e) {
        props.toast('Dışa aktarma başarısız');
      }
    }

    function onFile(e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var norm = normalizeState(parsed);
          if (!norm) {
            props.toast('Bu dosya FlashCards yedek dosyası değil');
            return;
          }
          // Bağlam alanı varsa süz (eski yedekte yoksa null kalır)
          var ctxNorm = null;
          if (parsed && Array.isArray(parsed.contexts)) {
            ctxNorm = normalizeContextsState(parsed);
          }
          props.onImport(norm, ctxNorm);
        } catch (err) {
          props.toast('Dosya okunamadı: geçerli bir JSON değil');
        }
      };
      reader.onerror = function () { props.toast('Dosya okunamadı'); };
      reader.readAsText(file);
      e.target.value = ''; // aynı dosya tekrar seçilebilsin
    }

    var totalCards = props.state.decks.reduce(function (n, d) { return n + d.cards.length; }, 0);

    return h('div', null,
      h('div', { className: 'panel' },
        h('h3', null, 'Yedeği dışa aktar'),
        h('p', null, 'Tüm desteler, kartlar, istatistikler ve bağlamlar tek bir JSON dosyasına indirilir. Bu dosyayı başka bir cihaza taşıyıp içe aktarabilirsiniz.'),
        h('div', { className: 'mono', style: { fontSize: '12px', color: 'var(--ink-faint)', marginBottom: '12px' } },
          props.state.decks.length + ' deste · ' + totalCards + ' kart · ' + props.ctxState.contexts.length + ' bağlam'),
        h('button', { className: 'btn primary', onClick: doExport }, '⤓  JSON dışa aktar')
      ),
      h('div', { className: 'panel' },
        h('h3', null, 'Yedeği içe aktar'),
        h('p', null, 'Daha önce aldığınız bir JSON yedeğini yükleyin. Mevcut verinin yerine geçsin mi yoksa birleştirilsin mi seçeceksiniz.'),
        h('input', { type: 'file', accept: 'application/json,.json', ref: fileRef, className: 'hidden-file', onChange: onFile }),
        h('button', { className: 'btn ghost', onClick: function () { fileRef.current && fileRef.current.click(); } }, '⤒  JSON dosyası seç')
      ),
      // Bildirimler
      h('div', { className: 'panel' },
        h('h3', null, 'Bildirimler'),
        h('p', null,
          props.notifPerm === 'granted' ? 'Bildirim izni verildi.' :
          props.notifPerm === 'denied' ? 'Bildirim izni reddedildi.' :
          props.notifPerm === 'unsupported' ? 'Bu cihaz bildirim desteklemiyor.' :
          'Bildirim izni henüz sorulmadı.'),
        props.notifPerm === 'default'
          ? h('button', { className: 'btn primary', onClick: props.onAskNotif }, '🔔  Bildirim iznini iste')
          : null,
        props.notifPerm === 'denied'
          ? h('div', { className: 'hint-line' }, 'Tarayıcı/site ayarlarından izin verebilirsin.')
          : null,
        h('label', { className: 'cm-ctx-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '14px' } },
          h('span', null, 'Catch-up bildirimleri'),
          h('button', {
            className: 'toggle-sw' + (props.catchupOn ? ' on' : ''),
            role: 'switch', 'aria-checked': props.catchupOn ? 'true' : 'false',
            'aria-label': 'Catch-up bildirimleri',
            onClick: props.onToggleCatchup
          }, h('span', { className: 'toggle-knob' }))
        )
      ),
      // Sprint 6: Gelişmiş (marketplace URL)
      h(MarketplaceSettings, null),
      // Gizlilik
      h('div', { className: 'panel' },
        h('h3', null, 'Gizlilik'),
        h('p', null, '• Konum verilerin cihazından dışarı çıkmaz.'),
        h('p', null, '• Hiçbir veri sunucuya gönderilmez.'),
        h('p', null, '• Verilerini istediğin zaman dışa aktarabilir veya silebilirsin.')
      ),
      // Hakkında
      h('div', { className: 'panel' },
        h('h3', null, 'Hakkında'),
        h('p', { className: 'mono', style: { fontSize: '13px' } }, 'Sürüm v1.0'),
        h('p', null, 'FlashCards — bağlamsal hatırlatmalı bilgi kartı uygulaması.'),
        h('a', {
          className: 'btn ghost', href: 'https://github.com/ArdaBerkayGurbuz/FlashCards/issues',
          target: '_blank', rel: 'noopener noreferrer'
        }, '↗  Geri bildirim gönder')
      )
    );
  }

  // ---------- Sprint 4: Catch-up şeridi (kaçırılan bağlam) ----------

  function CatchupStrip(props) {
    var item = props.item; // {context,dueCardCount} | null
    if (!item) return null;
    var ctx = item.context;
    return h('div', { className: 'catchup', role: 'status' },
      h('div', { className: 'catchup-text' },
        ctx.emoji + ' “' + ctx.name + '” zamanını kaçırdın — ' +
        item.dueCardCount + ' kart hâlâ bekliyor'
      ),
      h('div', { className: 'catchup-actions' },
        h('button', { className: 'btn primary', onClick: function () { props.onStudy(ctx); } }, 'Çalış'),
        h('button', { className: 'linkbtn', onClick: function () { props.onDismiss(ctx.id); } }, 'Şimdi değil')
      )
    );
  }

  // ---------- Sprint 3: Home bağlam banner'ı ----------

  function BannerSection(props) {
    var hasAnyContext = props.hasAnyContext;
    var matches = props.matches;        // [{context,dueCardCount,matchScore,reasons}]
    var needsLocation = props.needsLocation; // konum-gerekli bağlam var ama eşleşme yok
    var geoStatus = props.geoStatus;    // idle|asking|granted|denied|unsupported
    var geoBusy = props.geoBusy;

    if (!hasAnyContext) return null; // Durum 1: hiç bağlam yok → sessiz

    var refreshBtn = h('button', {
      className: 'iconbtn banner-refresh' + (geoBusy ? ' spinning' : ''),
      onClick: props.onRefresh, 'aria-label': 'Yenile',
      title: 'Yenile', disabled: geoBusy
    }, h('span', { className: geoBusy ? 'spin' : '' }, '🔄'));

    // Durum 2: eşleşme yok
    if (!matches || matches.length === 0) {
      return h('div', { className: 'banner-hint-wrap' },
        h('div', { className: 'aurora-bg', 'aria-hidden': 'true' }),
        h('div', { className: 'banner-hint' },
          h('span', null, '📍 Şu an aktif bağlam yok'),
          refreshBtn
        ),
        needsLocation && geoStatus !== 'denied'
          ? h('button', { className: 'linkbtn banner-geo-link', onClick: props.onAskLocation },
              '📍 Konum eşleşmesi için izin ver')
          : null,
        geoStatus === 'denied'
          ? h('div', { className: 'banner-geo-note' },
              'Konum erişimi yok — sadece zaman bağlamları aktif')
          : null,
        geoStatus === 'unsupported'
          ? h('div', { className: 'banner-geo-note' }, 'Bu cihaz konum desteklemiyor')
          : null
      );
    }

    // Durum 3/4: en az bir eşleşme — en yüksek skorlu belirgin kartta
    var top = matches[0];
    var ctx = top.context;
    var reasonText = top.reasons.map(function (r) { return reasonLabel(r, ctx); }).join(' · ');

    return h('div', { className: 'banner' },
      h('div', { className: 'aurora-bg', 'aria-hidden': 'true' }),
      h('button', {
        className: 'banner-x', 'aria-label': 'Kapat',
        onClick: function () { props.onDismiss(ctx.id); }
      }, '×'),
      h('div', { className: 'banner-head' },
        h('span', { className: 'banner-emoji' }, ctx.emoji),
        h('span', { className: 'banner-name' }, ctx.name)
      ),
      h('div', { className: 'banner-count' }, top.dueCardCount + ' kart seni bekliyor'),
      reasonText ? h('div', { className: 'banner-reason' }, reasonText) : null,
      h('div', { className: 'banner-actions' },
        h('button', { className: 'btn primary', onClick: function () { props.onStart(ctx); } },
          '▶  Hadi Başla'),
        refreshBtn
      ),
      matches.length > 1
        ? h('button', { className: 'linkbtn banner-more', onClick: props.onSeeAll },
            '+' + (matches.length - 1) + ' bağlam daha aktif — tümünü gör')
        : null
    );
  }

  // ---------- Sprint 6: Keşfet (marketplace) ekranı ----------

  function DiscoverView(props) {
    var status = props.status;       // loading|ready|error|offline
    var manifest = props.manifest;   // {decks:[...]} | null
    var dl = props.dl;               // {deckId,pct} | null
    var langH = useState('all');
    var lang = langH[0], setLang = langH[1];
    var lvlH = useState('all');
    var lvl = lvlH[0], setLvl = lvlH[1];

    if (status === 'loading') {
      return h('div', { className: 'empty' },
        h('div', { className: 'big' }, 'Desteler yükleniyor…'),
        h('div', { className: 'spin', style: { fontSize: '24px', marginTop: '12px' } }, '🔄')
      );
    }
    if (status === 'error' || !manifest) {
      return h('div', { className: 'empty' },
        h('div', { className: 'big' }, 'Desteler yüklenemedi'),
        h('p', null, 'İnternet bağlantını kontrol et veya biraz sonra tekrar dene.'),
        h('button', { className: 'btn primary lg', onClick: props.onReload }, '↻  Yeniden dene')
      );
    }

    var decks = manifest.decks || [];
    // Filtre seçeneklerini manifest'ten dinamik çıkar
    var langs = {}, levels = {};
    decks.forEach(function (d) {
      if (d.language && d.language.to) langs[d.language.to] = true;
      if (d.level) levels[d.level] = true;
    });
    var langOpts = Object.keys(langs).sort();
    var lvlOpts = Object.keys(levels).sort();

    var filtered = decks.filter(function (d) {
      if (lang !== 'all' && (!d.language || d.language.to !== lang)) return false;
      if (lvl !== 'all' && d.level !== lvl) return false;
      return true;
    });

    function langLabel(code) {
      var m = { en: '🇬🇧 İngilizce', de: '🇩🇪 Almanca', fr: '🇫🇷 Fransızca',
                es: '🇪🇸 İspanyolca', it: '🇮🇹 İtalyanca' };
      return m[code] || code;
    }

    return h('div', null,
      status === 'offline'
        ? h('div', { className: 'mp-offline' },
            '⚠ Çevrimdışı — kayıtlı liste gösteriliyor')
        : null,
      h('p', { className: 'mp-intro' },
        'Hazır flashcard desteleri. İndirdiğin desteler kendi destelerine eklenir.'),
      (langOpts.length > 1 || lvlOpts.length > 0)
        ? h('div', { className: 'mp-filters' },
            langOpts.length > 1
              ? h('select', {
                  className: 'mp-select', value: lang,
                  onChange: function (e) { setLang(e.target.value); },
                  'aria-label': 'Dil filtresi'
                },
                  h('option', { value: 'all' }, 'Tüm diller'),
                  langOpts.map(function (c) {
                    return h('option', { key: c, value: c }, langLabel(c));
                  }))
              : null,
            lvlOpts.length > 0
              ? h('select', {
                  className: 'mp-select', value: lvl,
                  onChange: function (e) { setLvl(e.target.value); },
                  'aria-label': 'Seviye filtresi'
                },
                  h('option', { value: 'all' }, 'Tüm seviyeler'),
                  lvlOpts.map(function (l) {
                    return h('option', { key: l, value: l }, l);
                  }))
              : null
          )
        : null,
      filtered.length === 0
        ? h('div', { className: 'empty' },
            h('p', null, 'Bu filtreye uygun deste yok.'))
        : filtered.map(function (d) {
            var busy = dl && dl.deckId === d.id;
            var langTxt = d.language
              ? ((d.language.from || '') + ' → ' + (d.language.to || '')) : '';
            return h('div', { className: 'mp-card', key: d.id },
              h('div', { className: 'mp-head' },
                h('span', { className: 'mp-emoji' }, d.icon || '📚'),
                h('span', { className: 'mp-name' }, d.name)
              ),
              h('div', { className: 'mp-meta' },
                (d.cardCount || (d.previewCards ? d.previewCards.length : '?')) +
                ' kart' + (d.level ? ' · ' + d.level : '') +
                (langTxt ? ' · ' + langTxt : '')),
              d.description
                ? h('div', { className: 'mp-desc' }, d.description) : null,
              Array.isArray(d.previewCards) && d.previewCards.length
                ? h('div', { className: 'mp-prev' },
                    d.previewCards.slice(0, 4).map(function (pc, i) {
                      return pc.image
                        ? h('img', {
                            key: i, className: 'mp-thumb', loading: 'lazy',
                            src: (d.imageBaseUrl || '') + pc.image, alt: pc.front || '',
                            onError: function (e) {
                              e.target.style.display = 'none';
                            }
                          })
                        : h('div', { key: i, className: 'mp-thumb mp-thumb-ph' }, '🖼️');
                    }))
                : null,
              busy
                ? h('div', { className: 'mp-dl' },
                    h('div', { className: 'mp-dl-bar' },
                      h('div', { className: 'mp-dl-fill', style: { width: (dl.pct || 0) + '%' } })),
                    h('div', { className: 'mp-dl-txt' }, 'İndiriliyor… %' + (dl.pct || 0))
                  )
                : h('button', {
                    className: 'btn primary mp-dl-btn',
                    disabled: !!dl,
                    onClick: function () { props.onDownload(d); }
                  }, '⤓  İndir')
            );
          })
    );
  }

  // ---------- Bağlamlar: liste ekranı ----------

  function ContextListView(props) {
    var contexts = props.contexts;

    if (contexts.length === 0) {
      return h('div', { className: 'empty' },
        h('div', { className: 'big' }, 'Henüz bağlam yok'),
        h('p', null, 'Bir bağlam ekleyince, kartlarını belirli konum/zaman/duruma göre çalışabilirsin.'),
        h('button', { className: 'btn primary lg', onClick: props.onNew }, '＋  İlk Bağlamı Ekle')
      );
    }

    return h('div', null,
      h('div', { className: 'section-head' },
        h('span', { className: 'lbl' }, contexts.length + ' bağlam'),
        h('button', { className: 'linkbtn', onClick: props.onNew }, '＋ Yeni')
      ),
      contexts.map(function (c) {
        var base = contextSummary(c);
        var isNone = base === 'Sınırsız';
        var counts = props.cardCounts || {};
        var n = counts[c.id] || 0;
        return h('div', {
          className: 'ctx-row', key: c.id,
          onClick: function () { props.onOpen(c.id); }
        },
          h('div', { className: 'ctx-emoji' }, c.emoji),
          h('div', { className: 'ctx-body' },
            h('div', { className: 'ctx-name' }, c.name),
            h('div', { className: 'ctx-summary' + (isNone ? ' none' : '') },
              base,
              n > 0
                ? h('span', null, ' · ' + n + ' kart')
                : h('span', { className: 'ctx-nocards' }, ' · kart yok')
            )
          ),
          h('div', { className: 'ctx-right' },
            h('button', {
              className: 'toggle-sw' + (c.notificationEnabled ? ' on' : ''),
              role: 'switch',
              'aria-checked': c.notificationEnabled ? 'true' : 'false',
              'aria-label': 'Bildirim ' + (c.notificationEnabled ? 'açık' : 'kapalı'),
              onClick: function (e) {
                e.stopPropagation();
                props.onToggleNotif(c.id, !c.notificationEnabled);
              }
            }, h('span', { className: 'toggle-knob' })),
            h('span', { className: 'ctx-chevron' }, '›')
          )
        );
      })
    );
  }

  // ---------- Bağlamlar: düzenleme ekranı (tam sayfa) ----------

  var EMOJI_CHOICES = [
    '☕', '🏠', '🏢', '🚗', '🏃', '📚', '🍽️', '🛏️', '🏋️', '🎧',
    '🌳', '🚇', '☀️', '🌙', '⏰', '📍', '✈️', '🎓', '💼', '🛒',
    '🏥', '🏖️', '🎬', '🎮', '🎨', '☔', '❄️', '🔥', '⭐', '💡',
    '📝', '🧠', '🍵', '🌅', '🌃', '🎯'
  ];
  var DAY_LABELS = [
    { d: 1, t: 'Pzt' }, { d: 2, t: 'Sal' }, { d: 3, t: 'Çar' },
    { d: 4, t: 'Per' }, { d: 5, t: 'Cum' }, { d: 6, t: 'Cmt' }, { d: 0, t: 'Paz' }
  ];
  var RADIUS_CHOICES = [50, 100, 250, 500];
  var COOLDOWN_CHOICES = [
    { v: 15, t: '15dk' }, { v: 30, t: '30dk' }, { v: 60, t: '1sa' },
    { v: 120, t: '2sa' }, { v: 240, t: '4sa' }
  ];

  // "Bu bağlama bağlı kartlar" bölümü (max 20 + 'daha fazla')
  function LinkedCardsSection(props) {
    var expH = useState(false);
    var expanded = expH[0], setExpanded = expH[1];
    var cards = props.cards || [];
    var LIMIT = 20;
    var shown = expanded ? cards : cards.slice(0, LIMIT);
    var rest = cards.length - shown.length;

    return h('div', { className: 'ctx-section linked-sec' },
      h('div', { className: 'ctx-sec-head' },
        h('span', null, 'Bu bağlama bağlı kartlar'),
        h('span', { className: 'linked-count' }, cards.length + ' kart')
      ),
      cards.length > 0 && props.onStudyContext
        ? h('button', {
            className: 'btn primary full', style: { marginTop: '12px' },
            onClick: props.onStudyContext
          }, '▶  Bu bağlamla çalış')
        : null,
      cards.length === 0
        ? h('div', { className: 'linked-empty' },
            h('div', null, 'Henüz kart bağlı değil'),
            h('div', { className: 'linked-empty-sub' },
              "Bir kartı düzenleyip 'Bağlamlar' kısmından bu bağlamı seçebilirsin"))
        : h('div', null,
            shown.map(function (c) {
              return h('div', {
                className: 'linked-row', key: c.deckId + '::' + c.cardId,
                onClick: function () { props.onOpen(c.deckId, c.cardId); }
              },
                h('div', { className: 'linked-body' },
                  h('div', { className: 'linked-deck' }, c.deckName),
                  h('div', { className: 'linked-front' }, c.front || '(boş)')
                ),
                h('button', {
                  className: 'linked-x', type: 'button',
                  'aria-label': 'Bu karttan bağlamı kaldır',
                  onClick: function (e) {
                    e.stopPropagation();
                    props.onRemove(c.deckId, c.cardId);
                  }
                }, '×')
              );
            }),
            rest > 0
              ? h('button', {
                  className: 'linkbtn', type: 'button',
                  onClick: function () { setExpanded(true); }
                }, 've ' + rest + ' kart daha')
              : null
          )
    );
  }

  function ContextEditView(props) {
    var existing = props.context; // null = yeni
    var s = useState(function () {
      var c = existing || {};
      return {
        name: c.name || '',
        emoji: c.emoji || '📍',
        locOn: !!c.location,
        lat: c.location ? c.location.lat : null,
        lng: c.location ? c.location.lng : null,
        radius: c.location ? c.location.radiusMeters : 100,
        locLabel: c.location ? (c.location.label || '') : '',
        locError: '',
        locBusy: false,
        timeOn: !!c.time,
        start: c.time ? c.time.start : '08:00',
        end: c.time ? c.time.end : '11:00',
        days: c.time ? c.time.daysOfWeek.slice() : [1, 2, 3, 4, 5],
        notif: existing ? c.notificationEnabled !== false : true,
        maxCards: c.maxCardsPerTrigger || 5,
        cooldown: c.cooldownMinutes || 60
      };
    });
    var f = s[0], setF = s[1];
    function set(patch) { setF(function (p) { return Object.assign({}, p, patch); }); }

    function toggleDay(d) {
      setF(function (p) {
        var has = p.days.indexOf(d) >= 0;
        return Object.assign({}, p, {
          days: has ? p.days.filter(function (x) { return x !== d; })
                    : p.days.concat([d])
        });
      });
    }

    function useMyLocation() {
      if (!navigator.geolocation) {
        set({ locError: 'Bu cihaz konum desteklemiyor.', locBusy: false });
        return;
      }
      set({ locBusy: true, locError: '' });
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          set({
            lat: Math.round(pos.coords.latitude * 1e4) / 1e4,
            lng: Math.round(pos.coords.longitude * 1e4) / 1e4,
            locBusy: false, locError: ''
          });
        },
        function () {
          set({ locError: 'Konum izni verilmedi.', locBusy: false });
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 }
      );
    }

    // Doğrulama
    var nameOk = f.name.trim().length > 0;
    var timeOk = !f.timeOn || (f.start < f.end && f.days.length > 0);
    var locOk = !f.locOn || (f.lat != null && f.lng != null);
    var canSave = nameOk && timeOk && locOk;

    var warn = '';
    if (!nameOk) warn = 'Ad gerekli.';
    else if (f.timeOn && f.start >= f.end) warn = 'Başlangıç, bitişten önce olmalı.';
    else if (f.timeOn && f.days.length === 0) warn = 'En az bir gün seçin.';
    else if (f.locOn && f.lat == null) warn = 'Konum belirleyin veya konum bölümünü kapatın.';

    function save() {
      if (!canSave) return;
      var payload = {
        name: f.name.trim(),
        emoji: f.emoji,
        location: f.locOn ? {
          lat: f.lat, lng: f.lng,
          radiusMeters: f.radius,
          label: f.locLabel.trim()
        } : null,
        time: f.timeOn ? {
          start: f.start, end: f.end,
          daysOfWeek: f.days.slice()
        } : null,
        notificationEnabled: f.notif,
        maxCardsPerTrigger: f.maxCards,
        cooldownMinutes: f.cooldown
      };
      props.onSave(payload);
    }

    function chip(label, active, onClick) {
      return h('button', {
        className: 'chip' + (active ? ' sel' : ''),
        onClick: onClick, type: 'button'
      }, label);
    }

    return h('div', null,
      // Ad
      h('div', { className: 'field' },
        h('label', null, 'Ad'),
        h('input', {
          type: 'text', value: f.name, maxLength: 40,
          placeholder: 'Kafe, Sabah Rutini…',
          onChange: function (e) { set({ name: e.target.value }); }
        })
      ),
      // Emoji
      h('div', { className: 'field' },
        h('label', null, 'Emoji'),
        h('div', { className: 'ctx-emoji-lg' }, f.emoji),
        h('div', { className: 'emoji-grid' },
          EMOJI_CHOICES.map(function (em) {
            return h('button', {
              key: em, type: 'button',
              className: 'emoji-cell' + (f.emoji === em ? ' sel' : ''),
              onClick: function () { set({ emoji: em }); }
            }, em);
          })
        )
      ),
      // Konum
      h('div', { className: 'ctx-section' },
        h('div', { className: 'ctx-sec-head' },
          h('span', null, '📍 Konum'),
          h('button', {
            className: 'toggle-sw' + (f.locOn ? ' on' : ''),
            role: 'switch', 'aria-checked': f.locOn ? 'true' : 'false',
            'aria-label': 'Konum bölümü',
            onClick: function () { set({ locOn: !f.locOn }); }
          }, h('span', { className: 'toggle-knob' }))
        ),
        !f.locOn
          ? h('div', { className: 'ctx-sec-hint' }, 'Konum eklemek için aç')
          : h('div', null,
              h('button', {
                className: 'btn ghost', type: 'button',
                disabled: f.locBusy, onClick: useMyLocation
              }, f.locBusy ? 'Konum alınıyor…' : '📍 Mevcut konumumu kullan'),
              f.locError
                ? h('div', { className: 'ctx-warn' },
                    f.locError,
                    h('button', { className: 'linkbtn', type: 'button', onClick: useMyLocation }, 'Tekrar dene'))
                : null,
              (f.lat != null && f.lng != null)
                ? h('div', null,
                    h('div', { className: 'ctx-coord' }, f.lat + ', ' + f.lng),
                    h('div', { className: 'field', style: { marginTop: '12px' } },
                      h('label', null, 'Etiket (opsiyonel)'),
                      h('input', {
                        type: 'text', value: f.locLabel, maxLength: 40,
                        placeholder: 'Ev, Ofis…',
                        onChange: function (e) { set({ locLabel: e.target.value }); }
                      })
                    ),
                    h('label', { className: 'ctx-sub-label' }, 'Yarıçap'),
                    h('div', { className: 'chip-row' },
                      RADIUS_CHOICES.map(function (r) {
                        return chip(r + 'm', f.radius === r,
                          function () { set({ radius: r }); });
                      })
                    ),
                    h('button', {
                      className: 'linkbtn', type: 'button',
                      onClick: function () { set({ lat: null, lng: null, locLabel: '' }); }
                    }, 'Konumu kaldır')
                  )
                : null
            )
      ),
      // Zaman
      h('div', { className: 'ctx-section' },
        h('div', { className: 'ctx-sec-head' },
          h('span', null, '⏰ Zaman aralığı'),
          h('button', {
            className: 'toggle-sw' + (f.timeOn ? ' on' : ''),
            role: 'switch', 'aria-checked': f.timeOn ? 'true' : 'false',
            'aria-label': 'Zaman bölümü',
            onClick: function () { set({ timeOn: !f.timeOn }); }
          }, h('span', { className: 'toggle-knob' }))
        ),
        !f.timeOn
          ? h('div', { className: 'ctx-sec-hint' }, 'Zaman aralığı eklemek için aç')
          : h('div', null,
              h('div', { className: 'time-row' },
                h('div', { className: 'field' },
                  h('label', null, 'Başlangıç'),
                  h('input', {
                    type: 'time', value: f.start,
                    onChange: function (e) { set({ start: e.target.value }); }
                  })
                ),
                h('div', { className: 'field' },
                  h('label', null, 'Bitiş'),
                  h('input', {
                    type: 'time', value: f.end,
                    onChange: function (e) { set({ end: e.target.value }); }
                  })
                )
              ),
              h('label', { className: 'ctx-sub-label' }, 'Günler'),
              h('div', { className: 'chip-row' },
                DAY_LABELS.map(function (dl) {
                  return chip(dl.t, f.days.indexOf(dl.d) >= 0,
                    function () { toggleDay(dl.d); });
                })
              )
            )
      ),
      // Bildirim ayarları
      h('div', { className: 'ctx-section' },
        h('div', { className: 'ctx-sec-head' },
          h('span', null, '🔔 Bildirim açık'),
          h('button', {
            className: 'toggle-sw' + (f.notif ? ' on' : ''),
            role: 'switch', 'aria-checked': f.notif ? 'true' : 'false',
            'aria-label': 'Bildirim',
            onClick: function () { set({ notif: !f.notif }); }
          }, h('span', { className: 'toggle-knob' }))
        ),
        h('label', { className: 'ctx-sub-label' }, 'Tetiklenme başına en fazla kart: ' + f.maxCards),
        h('input', {
          type: 'range', min: 1, max: 20, value: f.maxCards,
          className: 'ctx-range',
          onChange: function (e) { set({ maxCards: parseInt(e.target.value, 10) }); }
        }),
        h('label', { className: 'ctx-sub-label' }, 'Bekleme süresi (cooldown)'),
        h('div', { className: 'chip-row' },
          COOLDOWN_CHOICES.map(function (cc) {
            return chip(cc.t, f.cooldown === cc.v,
              function () { set({ cooldown: cc.v }); });
          })
        )
      ),
      // Bu bağlama bağlı kartlar (yalnızca kaydedilmiş bağlamda)
      existing ? h(LinkedCardsSection, {
        cards: props.linkedCards || [],
        onRemove: props.onRemoveLink,
        onOpen: props.onOpenCard,
        onStudyContext: props.onStudyContext
      }) : null,
      warn ? h('div', { className: 'ctx-warn' }, warn) : null,
      // Alt aksiyon barı
      h('div', { className: 'modal-actions', style: { marginTop: '20px' } },
        h('button', { className: 'btn ghost', onClick: props.onCancel }, 'İptal'),
        existing
          ? h('button', { className: 'linkbtn danger', onClick: props.onDelete }, '🗑️ Sil')
          : null,
        h('button', { className: 'btn primary', disabled: !canSave, onClick: save }, 'Kaydet')
      )
    );
  }

  // ---------- Kök uygulama ----------

  function App() {
    var stateHook = useState(loadState);
    var state = stateHook[0], setState = stateHook[1];

    // route: { name: 'list'|'detail'|'study'|'stats'|'data', deckId? }
    var routeHook = useState({ name: 'list' });
    var route = routeHook[0], setRoute = routeHook[1];

    var modalHook = useState(null); // { type, ... }
    var modal = modalHook[0], setModal = modalHook[1];

    var toastHook = useState(null);
    var toast = toastHook[0], setToast = toastHook[1];

    var pendingImportHook = useState(null);
    var pendingImport = pendingImportHook[0], setPendingImport = pendingImportHook[1];

    var themeHook = useState(getInitialTheme);
    var theme = themeHook[0], setTheme = themeHook[1];

    var ctxHook = useState(loadContextsState);
    var ctxState = ctxHook[0], setCtxState = ctxHook[1];

    // Sprint 3: oturum içi konum + banner durumu
    var geoHook = useState(null);            // {lat,lng} | null (oturum cache)
    var geo = geoHook[0], setGeo = geoHook[1];
    var geoStatusHook = useState('idle');    // idle|asking|granted|denied|unsupported
    var geoStatus = geoStatusHook[0], setGeoStatus = geoStatusHook[1];
    var refreshHook = useState(0);           // banner yeniden hesaplama tetiği
    var refreshTick = refreshHook[0], setRefreshTick = refreshHook[1];
    var dismissedBannerRef = useRef({});     // {ctxId:true} — sayfa yenilenince sıfır
    var geoBusyHook = useState(false);       // 🔄 spinner
    var geoBusy = geoBusyHook[0], setGeoBusy = geoBusyHook[1];

    // Sprint 4: onboarding (yalnız flag — decks sayısına bakma)
    var onboardHook = useState(function () {
      try { return localStorage.getItem(ONBOARDED_KEY) === '1'; }
      catch (e) { return true; }
    });
    var onboarded = onboardHook[0], setOnboarded = onboardHook[1];

    // bildirim izni durumu (UI için)
    var notifHook = useState(notificationPermState);
    var notifPerm = notifHook[0], setNotifPerm = notifHook[1];

    // SW güncelleme şeridi
    var swUpdHook = useState(false);
    var swUpdate = swUpdHook[0], setSwUpdate = swUpdHook[1];

    // Catch-up bildirimleri toggle (gelecek kullanım flag'i)
    var catchupHook = useState(function () {
      try { return localStorage.getItem(CATCHUP_KEY) !== '0'; }
      catch (e) { return true; }
    });
    var catchupOn = catchupHook[0], setCatchupOn = catchupHook[1];

    // catch-up: bu oturumda gizlenenler (sayfa yenilenince sıfır)
    var dismissedCatchupRef = useRef({});
    // bildirim zamanlama timer'ı
    var notifTimerRef = useRef(null);

    // Sprint 6: marketplace
    var mpStatusHook = useState('idle');   // idle|loading|ready|error|offline
    var mpStatus = mpStatusHook[0], setMpStatus = mpStatusHook[1];
    var mpDataHook = useState(null);       // {decks:[...]}
    var mpData = mpDataHook[0], setMpData = mpDataHook[1];
    var dlHook = useState(null);           // {deckId,pct} | null
    var dl = dlHook[0], setDl = dlHook[1];
    var mpLoadedRef = useRef(false);

    function loadMP(force) {
      setMpStatus('loading');
      loadMarketplaceManifest(force).then(function (r) {
        setMpData(r.data);
        setMpStatus(r.stale ? 'offline' : 'ready');
      }).catch(function () {
        setMpStatus('error');
      });
    }

    function finishOnboarding() {
      try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (e) {}
      setOnboarded(true);
    }

    // her değişimde kaydet
    useEffect(function () { persist(state); }, [state]);
    useEffect(function () { persistContexts(ctxState); }, [ctxState]);

    // Boot'ta bir kere: kırık (orphan) kart-bağlam linklerini sessizce temizle
    useEffect(function () { cleanupOrphanLinks(); }, []);

    // Sprint 6: Keşfet'e ilk girişte manifest yükle (bir kez)
    useEffect(function () {
      if (route.name === 'discover' && !mpLoadedRef.current) {
        mpLoadedRef.current = true;
        loadMP(false);
      }
    }, [route.name]);

    // Sprint 4: deep-link (?action=study&contextId=) — boot'ta bir kere
    useEffect(function () {
      try {
        var sp = new URLSearchParams(window.location.search);
        if (sp.get('action') === 'study' && sp.get('contextId')) {
          var cid = sp.get('contextId');
          var ctx = ctxState.contexts.filter(function (c) { return c.id === cid; })[0];
          // URL'i temizle (tekrar tetiklenmesin)
          window.history.replaceState({}, '', window.location.pathname);
          if (ctx) startContextStudy(ctx);
        }
      } catch (e) {}
    }, []);

    // Sprint 4: SW'den notification-click mesajı
    useEffect(function () {
      if (!navigator.serviceWorker) return;
      function onMsg(e) {
        if (e.data && e.data.type === 'notification-click' && e.data.data) {
          var cid = e.data.data.contextId;
          var ctx = ctxState.contexts.filter(function (c) { return c.id === cid; })[0];
          if (ctx) startContextStudy(ctx);
        }
      }
      navigator.serviceWorker.addEventListener('message', onMsg);
      return function () {
        navigator.serviceWorker.removeEventListener('message', onMsg);
      };
    }, [ctxState]);

    // Sprint 4: görünürlük değişiminde bildirim zamanlama
    useEffect(function () {
      function onVis() {
        if (document.hidden) {
          scheduleNextContextNotification();
        } else if (notifTimerRef.current) {
          clearTimeout(notifTimerRef.current);
          notifTimerRef.current = null;
        }
      }
      document.addEventListener('visibilitychange', onVis);
      return function () {
        document.removeEventListener('visibilitychange', onVis);
        if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
      };
    }, [ctxState, geo]);

    // Sprint 4: SW güncellemesi hazır olduğunda şerit göster
    useEffect(function () {
      if (!navigator.serviceWorker) return;
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) return;
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              setSwUpdate(true);
            }
          });
        });
      }).catch(function () {});
    }, []);

    // tema değişince uygula + kaydet
    useEffect(function () {
      applyTheme(theme);
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    }, [theme]);

    function toggleTheme() {
      setTheme(function (t) { return t === 'light' ? 'dark' : 'light'; });
    }

    function showToast(text) { setToast({ text: text, id: uid() }); }

    function update(mutator) {
      setState(function (prev) {
        var next = JSON.parse(JSON.stringify(prev));
        mutator(next);
        return next;
      });
    }

    function updateCtx(mutator) {
      setCtxState(function (prev) {
        var next = JSON.parse(JSON.stringify(prev));
        mutator(next);
        return next;
      });
    }

    function createContext(partial) {
      var now = Date.now();
      var ctx = Object.assign({
        id: 'ctx_' + uid(),
        name: '', emoji: '📍',
        location: null, time: null,
        notificationEnabled: true,
        maxCardsPerTrigger: 5,
        cooldownMinutes: 60,
        createdAt: now, updatedAt: now
      }, partial || {});
      ctx.id = 'ctx_' + uid();
      ctx.createdAt = now;
      ctx.updatedAt = now;
      updateCtx(function (n) { n.contexts.push(ctx); });
      return ctx.id;
    }

    function updateContext(id, patch) {
      updateCtx(function (n) {
        n.contexts.forEach(function (c) {
          if (c.id === id) {
            Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
            c.updatedAt = Date.now();
          }
        });
      });
    }

    function deleteContext(id) {
      updateCtx(function (n) {
        n.contexts = n.contexts.filter(function (c) { return c.id !== id; });
        // bu bağlama referans veren tüm kart linklerini temizle
        Object.keys(n.cardContextLinks).forEach(function (ck) {
          var arr = n.cardContextLinks[ck].filter(function (cid) { return cid !== id; });
          if (arr.length) n.cardContextLinks[ck] = arr;
          else delete n.cardContextLinks[ck];
        });
      });
    }

    /* ===== Sprint 2: Kart ↔ Bağlam ilişki API'si =====
       Anahtar formatı: 'deckId::cardId' (global benzersizlik garantisi —
       import/merge'de kart id'leri değişebildiği için kompozit). */

    function cardKey(deckId, cardId) { return deckId + '::' + cardId; }

    function getCardContexts(cardId) {
      var m = ctxState.cardContextLinks || {};
      return Array.isArray(m[cardId]) ? m[cardId].slice() : [];
    }

    function setCardContexts(cardId, contextIds) {
      updateCtx(function (n) {
        var clean = (contextIds || []).filter(function (v, i, a) {
          return typeof v === 'string' && a.indexOf(v) === i;
        });
        if (clean.length) n.cardContextLinks[cardId] = clean;
        else delete n.cardContextLinks[cardId];
      });
    }

    function addCardContext(cardId, contextId) {
      updateCtx(function (n) {
        var arr = Array.isArray(n.cardContextLinks[cardId])
          ? n.cardContextLinks[cardId] : [];
        if (arr.indexOf(contextId) < 0) arr = arr.concat([contextId]);
        n.cardContextLinks[cardId] = arr;
      });
    }

    function removeCardContext(cardId, contextId) {
      updateCtx(function (n) {
        if (!Array.isArray(n.cardContextLinks[cardId])) return;
        var arr = n.cardContextLinks[cardId].filter(function (c) { return c !== contextId; });
        if (arr.length) n.cardContextLinks[cardId] = arr;
        else delete n.cardContextLinks[cardId];
      });
    }

    // Bu bağlama bağlı kartları tüm desteleri tarayarak topla
    function getCardsForContext(contextId) {
      var m = ctxState.cardContextLinks || {};
      var out = [];
      state.decks.forEach(function (d) {
        d.cards.forEach(function (c) {
          var k = cardKey(d.id, c.id);
          if (Array.isArray(m[k]) && m[k].indexOf(contextId) >= 0) {
            out.push({ cardId: c.id, deckId: d.id, deckName: d.name, front: c.q, back: c.a });
          }
        });
      });
      return out;
    }

    /* ===== Sprint 3: Tetikleme motoru (canlı React state'ten) ===== */

    // SR yok → bağlama bağlı tüm kartlar "çalışılabilir" sayılır
    function countDueCardsForContext(contextId) {
      return getCardsForContext(contextId).length;
    }

    // loc: {lat,lng} | null. Saf hesap — state YAZMAZ.
    function evaluateContexts(loc) {
      var now = Date.now();
      var results = [];
      ctxState.contexts.forEach(function (ctx) {
        if (!ctx.notificationEnabled) return;

        var reasons = [];
        var matchScore = 0;

        if (ctx.time) {
          if (!isInTimeWindow(ctx.time)) return;
          reasons.push('time');
          matchScore += 1;
        }
        if (ctx.location) {
          if (!loc) return; // konum istiyor ama yok
          var dist = haversineMeters(loc.lat, loc.lng, ctx.location.lat, ctx.location.lng);
          if (dist > ctx.location.radiusMeters) return;
          reasons.push('location');
          matchScore += 2; // konum daha güçlü sinyal
        }
        if (!ctx.time && !ctx.location) reasons.push('always');

        // Cooldown — yalnız 'engaged' trigger'lar sayılır
        var last = null;
        (ctxState.triggers || []).forEach(function (t) {
          if (t.contextId === ctx.id && t.engaged) {
            if (!last || t.triggeredAt > last.triggeredAt) last = t;
          }
        });
        if (last) {
          var cooldownMs = (ctx.cooldownMinutes || 60) * 60000;
          if (now - last.triggeredAt < cooldownMs) return;
        }

        var due = countDueCardsForContext(ctx.id);
        if (due === 0) return;

        results.push({ context: ctx, dueCardCount: due, matchScore: matchScore, reasons: reasons });
      });
      results.sort(function (a, b) {
        return b.matchScore - a.matchScore || b.dueCardCount - a.dueCardCount;
      });
      return results;
    }

    // Yalnız engaged=true yazılır; cooldown sadece bunlardan işler
    function logTrigger(contextId, cardsShown) {
      updateCtx(function (n) {
        if (!Array.isArray(n.triggers)) n.triggers = [];
        n.triggers.push({
          id: 'trg_' + uid(),
          contextId: contextId,
          triggeredAt: Date.now(),
          cardsShown: cardsShown,
          engaged: true
        });
        n.triggers = n.triggers.slice(-100); // localStorage şişmesin
      });
    }

    // Silinmiş kart/bağlam id'lerine işaret eden kırık linkleri temizle
    function cleanupOrphanLinks() {
      var validCards = {};
      state.decks.forEach(function (d) {
        d.cards.forEach(function (c) { validCards[cardKey(d.id, c.id)] = true; });
      });
      var validCtx = {};
      ctxState.contexts.forEach(function (c) { validCtx[c.id] = true; });

      var changed = false;
      var m = ctxState.cardContextLinks || {};
      Object.keys(m).forEach(function (ck) {
        if (!validCards[ck]) { changed = true; return; }
        var filtered = m[ck].filter(function (cid) { return validCtx[cid]; });
        if (filtered.length !== m[ck].length) changed = true;
      });
      if (!changed) return;

      updateCtx(function (n) {
        Object.keys(n.cardContextLinks).forEach(function (ck) {
          if (!validCards[ck]) { delete n.cardContextLinks[ck]; return; }
          var filtered = n.cardContextLinks[ck].filter(function (cid) { return validCtx[cid]; });
          if (filtered.length) n.cardContextLinks[ck] = filtered;
          else delete n.cardContextLinks[ck];
        });
      });
    }

    function findDeck(id) {
      return state.decks.filter(function (d) { return d.id === id; })[0] || null;
    }

    // ----- Deste işlemleri -----
    function createDeck(name) {
      var id = uid();
      update(function (n) {
        n.decks.unshift({ id: id, name: name, createdAt: Date.now(), lastStudied: null, cards: [] });
      });
      setModal(null);
      showToast('Deste oluşturuldu');
    }
    function renameDeck(id, name) {
      update(function (n) {
        n.decks.forEach(function (d) { if (d.id === id) d.name = name; });
      });
      setModal(null);
    }
    function deleteDeck(id) {
      update(function (n) {
        n.decks = n.decks.filter(function (d) { return d.id !== id; });
        delete n.stats.perDeck[id];
      });
      // bu desteye ait tüm kart linklerini ('id::*') temizle —
      // state.decks güncellemesini beklemeden, prefix ile güvenli
      var prefix = id + '::';
      updateCtx(function (n) {
        Object.keys(n.cardContextLinks).forEach(function (ck) {
          if (ck.indexOf(prefix) === 0) delete n.cardContextLinks[ck];
        });
      });
      setModal(null);
      setRoute({ name: 'list' });
      showToast('Deste silindi');
    }

    // ----- Kart işlemleri -----
    // contextIds: opsiyonel — kart kaydedilince bağlam linki yazılır
    // Sprint 6: kart objesine zengin alanları uygula (yalnız dolu)
    function applyCardExtra(card, extra) {
      var keys = ['pronunciation', 'example', 'exampleTranslation', 'image'];
      keys.forEach(function (k) {
        if (extra && typeof extra[k] === 'string' && extra[k]) card[k] = extra[k];
        else delete card[k];
      });
    }

    function addCard(deckId, q, a, contextIds, extra) {
      var newId = uid();
      update(function (n) {
        n.decks.forEach(function (d) {
          if (d.id === deckId) {
            var card = { id: newId, q: q, a: a, createdAt: Date.now() };
            applyCardExtra(card, extra);
            d.cards.push(card);
          }
        });
      });
      if (contextIds) setCardContexts(cardKey(deckId, newId), contextIds);
      setModal(null);
    }
    // Sprint 5: toplu kart ekleme — tek update + tek updateCtx (tek render)
    function addBulkCards(deckId, cards, contextIds) {
      if (!cards || !cards.length) return;
      var newIds = [];
      update(function (n) {
        n.decks.forEach(function (d) {
          if (d.id !== deckId) return;
          cards.forEach(function (c) {
            var id = uid();
            newIds.push(id);
            d.cards.push({ id: id, q: c.front, a: c.back, createdAt: Date.now() });
          });
        });
      });
      // Tüm yeni kartlara aynı bağlam(lar)ı tek updateCtx ile yaz
      if (contextIds && contextIds.length) {
        var clean = contextIds.filter(function (v, i, arr) {
          return typeof v === 'string' && arr.indexOf(v) === i;
        });
        if (clean.length) {
          updateCtx(function (n) {
            newIds.forEach(function (id) {
              n.cardContextLinks[cardKey(deckId, id)] = clean.slice();
            });
          });
        }
      }
      setModal(null);
      showToast(cards.length + ' kart eklendi');
    }
    function editCard(deckId, cardId, q, a, contextIds, extra) {
      update(function (n) {
        n.decks.forEach(function (d) {
          if (d.id === deckId) d.cards.forEach(function (c) {
            if (c.id === cardId) {
              c.q = q; c.a = a;
              applyCardExtra(c, extra);
            }
          });
        });
      });
      if (contextIds) setCardContexts(cardKey(deckId, cardId), contextIds);
      setModal(null);
    }
    function deleteCard(deckId, cardId) {
      update(function (n) {
        n.decks.forEach(function (d) {
          if (d.id === deckId) d.cards = d.cards.filter(function (c) { return c.id !== cardId; });
        });
      });
      setCardContexts(cardKey(deckId, cardId), []); // ilişkiyi temizle
      setModal(null);
    }

    // ----- Seans bitişi -> istatistik -----
    function finishSession(deckId, seen, correct) {
      update(function (n) {
        n.stats.totalSessions += 1;
        n.stats.totalSeen += seen;
        n.stats.totalCorrect += correct;
        if (!n.stats.perDeck[deckId]) n.stats.perDeck[deckId] = { sessions: 0, seen: 0, correct: 0 };
        var p = n.stats.perDeck[deckId];
        p.sessions += 1; p.seen += seen; p.correct += correct;
        n.decks.forEach(function (d) { if (d.id === deckId) d.lastStudied = Date.now(); });
      });
    }

    function resetStats() {
      update(function (n) {
        n.stats = { totalSessions: 0, totalSeen: 0, totalCorrect: 0, perDeck: {} };
      });
      setModal(null);
      showToast('İstatistikler sıfırlandı');
    }

    // Bağlam seansı: global istatistiğe yaz, perDeck'e DOKUNMA
    // (kartlar karışık destelerden — tek deste'ye atfetmek yanlış olur)
    function finishContextSession(_ignoredDeckId, seen, correct) {
      update(function (n) {
        n.stats.totalSessions += 1;
        n.stats.totalSeen += seen;
        n.stats.totalCorrect += correct;
      });
    }

    // Manuel yenile / "konum izni ver" — geo al, banner'ı tazele
    function doGeoRefresh() {
      // Reddedilme kalıcı flag'i: manuel tetik onu temizleyip tekrar dener
      setGeoBusy(true);
      setGeoStatus('asking');
      getCurrentLocationP({ timeout: 8000 }).then(function (loc) {
        try { localStorage.removeItem(GEO_DENIED_KEY); } catch (e) {}
        setGeo({ lat: loc.lat, lng: loc.lng });
        setGeoStatus('granted');
        setGeoBusy(false);
        setRefreshTick(function (x) { return x + 1; });
      }).catch(function (err) {
        setGeoBusy(false);
        if (err && err.message === 'GEO_NOT_SUPPORTED') {
          setGeoStatus('unsupported');
        } else {
          setGeoStatus('denied');
          try { localStorage.setItem(GEO_DENIED_KEY, '1'); } catch (e) {}
        }
        setRefreshTick(function (x) { return x + 1; });
      });
    }

    // Bir bağlamla çalışmayı başlat (banner / Bağlamlar ekranı kısayolu)
    function startContextStudy(ctx) {
      var linked = getCardsForContext(ctx.id);
      if (linked.length === 0) {
        showToast('Bu bağlamda kart yok');
        return;
      }
      var cards = linked.map(function (lc) {
        return { id: lc.deckId + '::' + lc.cardId, q: lc.front, a: lc.back };
      });
      logTrigger(ctx.id, cards.length);
      setRoute({
        name: 'study',
        sessionKey: uid(),
        ctxStudy: { ctxId: ctx.id, name: ctx.name, emoji: ctx.emoji, cards: cards }
      });
    }

    /* ===== Sprint 6: marketplace deste indirme ===== */

    function commitDownloadedDeck(deckJson, meta) {
      var now = Date.now();
      var newDeckId = uid();
      var imgBase = deckJson.imageBaseUrl || '';
      var newIds = [];
      var cards = deckJson.cards.map(function (c) {
        var id = uid();
        newIds.push(id);
        var card = {
          id: id, q: String(c.front), a: String(c.back), createdAt: now
        };
        if (typeof c.pronunciation === 'string' && c.pronunciation)
          card.pronunciation = c.pronunciation;
        if (typeof c.example === 'string' && c.example)
          card.example = c.example;
        if (typeof c.exampleTranslation === 'string' && c.exampleTranslation)
          card.exampleTranslation = c.exampleTranslation;
        if (typeof c.image === 'string' && c.image)
          card.image = imgBase + c.image; // mutlak URL — SW cache'ler
        return card;
      });
      update(function (n) {
        n.decks.unshift({
          id: newDeckId, name: deckJson.name,
          createdAt: now, lastStudied: null,
          source: 'marketplace:' + (meta.id || deckJson.id || ''),
          cards: cards
        });
      });
      setDl(null);
      // Bağlam önerisi varsa modal aç, yoksa bitir
      var sc = deckJson.suggestedContext;
      if (sc && sc.name) {
        setModal({
          type: 'mpContext', ctxName: sc.name,
          ctxEmoji: sc.emoji || '📍', deckId: newDeckId, cardIds: newIds,
          deckName: deckJson.name
        });
      } else {
        showToast(cards.length + ' kart eklendi');
        setRoute({ name: 'detail', deckId: newDeckId });
      }
    }

    function reallyDownload(meta) {
      setDl({ deckId: meta.id, pct: 0 });
      fetchJSON(marketplaceBaseUrl() + meta.url, 30000).then(function (json) {
        var dj = validateDeckJSON(json);
        if (!dj) { setDl(null); showToast('Deste dosyası bozuk'); return; }
        if (dj.cards.length > 500) {
          // çok büyük — yine de devam (kullanıcı zaten İndir'e bastı)
        }
        var imgs = [];
        dj.cards.forEach(function (c) {
          if (c.image) imgs.push((dj.imageBaseUrl || '') + c.image);
        });
        if (imgs.length === 0) { commitDownloadedDeck(dj, meta); return; }
        // Görselleri best-effort ısıt (SW cache doldur); hata → atla
        var done = 0;
        function step() {
          done++;
          setDl({ deckId: meta.id, pct: Math.round((done / imgs.length) * 100) });
          if (done >= imgs.length) commitDownloadedDeck(dj, meta);
        }
        imgs.forEach(function (u) {
          (typeof fetch === 'function'
            ? fetch(u).then(function () {}, function () {})
            : Promise.resolve()
          ).then(step, step);
        });
      }).catch(function (err) {
        setDl(null);
        var m = err && err.message;
        showToast(
          m === 'TIMEOUT' ? 'İndirme zaman aşımına uğradı'
          : m === 'RATE_LIMIT' ? 'GitHub sınırı — biraz sonra dene'
          : 'Deste indirilemedi');
      });
    }

    function downloadMarketplaceDeck(meta) {
      // Aynı kaynaktan daha önce indirilmiş mi?
      var srcTag = 'marketplace:' + meta.id;
      var exists = state.decks.some(function (d) { return d.source === srcTag; });
      if (exists) {
        setModal({
          type: 'confirm',
          title: 'Zaten indirildi',
          message: '“' + meta.name + '” destesini daha önce indirdin. Yeni bir kopya olarak ekleyelim mi?',
          confirmLabel: 'Yeni kopya',
          onConfirm: function () { setModal(null); reallyDownload(meta); }
        });
        return;
      }
      reallyDownload(meta);
    }

    function applyMpContext(modalData) {
      var newCtxId = createContext({
        name: modalData.ctxName, emoji: modalData.ctxEmoji
      });
      if (newCtxId && modalData.cardIds && modalData.cardIds.length) {
        updateCtx(function (n) {
          modalData.cardIds.forEach(function (cid) {
            n.cardContextLinks[cardKey(modalData.deckId, cid)] = [newCtxId];
          });
        });
      }
      setModal(null);
      showToast('Bağlam oluşturuldu');
      setRoute({ name: 'detail', deckId: modalData.deckId });
    }

    /* ===== Sprint 4: örnek deste, bildirim, catch-up ===== */

    function createSampleDeck() {
      var now = Date.now();
      var cards = [
        ['Türkiye’nin başkenti neresidir?', 'Ankara'],
        ['Suyun kimyasal formülü nedir?', 'H₂O'],
        ['Mona Lisa’yı kim yaptı?', 'Leonardo da Vinci'],
        ['Bir üçgenin iç açıları toplamı kaç derecedir?', '180°'],
        ['Dünya’nın uydusu nedir?', 'Ay'],
        ['"Merhaba"nın İngilizcesi nedir?', 'Hello'],
        ['Işık bir yılda ne kadar yol alır?', 'Yaklaşık 9,46 trilyon km (1 ışık yılı)']
      ].map(function (qa) {
        return { id: uid(), q: qa[0], a: qa[1], createdAt: now };
      });
      update(function (n) {
        n.decks.unshift({
          id: uid(), name: 'Genel Kültür',
          createdAt: now, lastStudied: null, cards: cards
        });
      });
      showToast('Örnek deste oluşturuldu');
    }

    // İzin granted ise bağlam için sistem bildirimi göster
    function notify(ctx, cardCount) {
      showContextNotification(ctx, cardCount,
        './icons/flashcards_icons/pwa/icon-192.png');
    }

    // En yakın gelecek zaman-bağlamı başlangıcına setTimeout planla.
    // Uygulama açıkken çalışır; suspend olursa kaybolur (PWA sınırı).
    function scheduleNextContextNotification() {
      if (notifTimerRef.current) {
        clearTimeout(notifTimerRef.current);
        notifTimerRef.current = null;
      }
      if (notificationPermState() !== 'granted') return;
      var now = new Date();
      var soonest = null;
      ctxState.contexts.forEach(function (ctx) {
        if (!ctx.notificationEnabled || !ctx.time) return;
        var start = timeStringToToday(ctx.time.start);
        if (start <= now) return; // bugün için geçmiş
        if (Array.isArray(ctx.time.daysOfWeek) && ctx.time.daysOfWeek.length &&
            ctx.time.daysOfWeek.indexOf(now.getDay()) < 0) return;
        var delay = start.getTime() - now.getTime();
        if (soonest === null || delay < soonest) soonest = delay;
      });
      if (soonest === null) return;
      if (soonest > 86400000) soonest = 86400000; // en fazla ~24s
      notifTimerRef.current = setTimeout(function () {
        var matches = evaluateContexts(geo);
        if (matches.length > 0) {
          notify(matches[0].context, matches[0].dueCardCount);
        }
      }, soonest);
    }

    // Kaçırılmış zaman-bağlamlarını bul (son 4 saatte kapanan pencere,
    // o pencerede trigger yok, hâlâ vadesi gelmiş kart var)
    function computeCatchups() {
      var now = new Date();
      var nowMs = now.getTime();
      var WINDOW = 4 * 3600000;
      var out = [];
      ctxState.contexts.forEach(function (ctx) {
        if (!ctx.notificationEnabled || !ctx.time) return;
        if (dismissedCatchupRef.current[ctx.id]) return;
        // gün filtresi
        if (Array.isArray(ctx.time.daysOfWeek) && ctx.time.daysOfWeek.length &&
            ctx.time.daysOfWeek.indexOf(now.getDay()) < 0) return;
        var start = timeStringToToday(ctx.time.start);
        var end = timeStringToToday(ctx.time.end);
        var wrap = end < start;
        // Pencere kapandı mı? (wrap: gündüz arada = kapalı)
        var closed = wrap ? (nowMs > end.getTime() && nowMs < start.getTime())
                          : (nowMs > end.getTime());
        if (!closed) return;
        var endMs = end.getTime();
        if (nowMs - endMs > WINDOW) return; // 4 saatten eski, geç
        // bu pencere aralığında bu bağlam için trigger var mı?
        var winStart = start.getTime();
        var hit = (ctxState.triggers || []).some(function (t) {
          return t.contextId === ctx.id &&
                 t.triggeredAt >= winStart && t.triggeredAt <= nowMs;
        });
        if (hit) return; // kaçırılmamış
        var due = countDueCardsForContext(ctx.id);
        if (due === 0) return;
        out.push({ context: ctx, dueCardCount: due, endMs: endMs });
      });
      // en güncel kaçırılan (penceresi en yeni kapanan) önce
      out.sort(function (a, b) { return b.endMs - a.endMs; });
      return out;
    }

    function requestNotifPermission() {
      ensureNotificationPermission().then(function (r) {
        setNotifPerm(notificationPermState());
        if (r === 'granted') scheduleNextContextNotification();
      });
    }

    // ----- İçe aktarma -----
    function applyImport(mode) {
      var incoming = pendingImport;
      if (!incoming) return;
      var deckNorm = incoming.deckNorm;
      var ctxNorm = incoming.ctxNorm; // null = eski yedek (bağlam yok)

      update(function (n) {
        if (mode === 'replace') {
          n.decks = deckNorm.decks;
          n.stats = deckNorm.stats;
        } else { // merge
          var existingIds = {};
          n.decks.forEach(function (d) { existingIds[d.id] = true; });
          deckNorm.decks.forEach(function (d) {
            if (existingIds[d.id]) d.id = uid(); // çakışmayı önle
            n.decks.push(d);
          });
          n.stats.totalSessions += deckNorm.stats.totalSessions;
          n.stats.totalSeen += deckNorm.stats.totalSeen;
          n.stats.totalCorrect += deckNorm.stats.totalCorrect;
          Object.keys(deckNorm.stats.perDeck).forEach(function (k) {
            if (!n.stats.perDeck[k]) { n.stats.perDeck[k] = deckNorm.stats.perDeck[k]; }
          });
        }
      });

      // Bağlamlar: yalnızca yedekte varsa dokun (eski yedek → ctxState korunur)
      if (ctxNorm) {
        updateCtx(function (n) {
          if (mode === 'replace') {
            n.contexts = ctxNorm.contexts;
            n.cardContextLinks = ctxNorm.cardContextLinks;
            n.triggers = ctxNorm.triggers;
          } else { // merge: aynı id atla, yoksa ekle
            var have = {};
            n.contexts.forEach(function (c) { have[c.id] = true; });
            ctxNorm.contexts.forEach(function (c) {
              if (!have[c.id]) n.contexts.push(c);
            });
            // kart-bağlam linklerini de birleştir (cardKey bazında, tekrarsız)
            var inLinks = ctxNorm.cardContextLinks || {};
            Object.keys(inLinks).forEach(function (ck) {
              var cur = Array.isArray(n.cardContextLinks[ck]) ? n.cardContextLinks[ck] : [];
              inLinks[ck].forEach(function (cid) {
                if (cur.indexOf(cid) < 0) cur = cur.concat([cid]);
              });
              if (cur.length) n.cardContextLinks[ck] = cur;
            });
          }
        });
      }

      setPendingImport(null);
      setModal(null);
      showToast(mode === 'replace' ? 'Veriler değiştirildi' : 'Veriler birleştirildi');
    }

    // ---------- Modal içerikleri ----------
    function renderModal() {
      if (!modal) return null;

      if (modal.type === 'newDeck' || modal.type === 'renameDeck') {
        var isNew = modal.type === 'newDeck';
        return h(DeckNameModal, {
          title: isNew ? 'Yeni deste' : 'Desteyi yeniden adlandır',
          initial: isNew ? '' : modal.deck.name,
          submitLabel: isNew ? 'Oluştur' : 'Kaydet',
          onClose: function () { setModal(null); },
          onSubmit: function (name) {
            if (isNew) createDeck(name); else renameDeck(modal.deck.id, name);
          }
        });
      }

      if (modal.type === 'addCard' || modal.type === 'editCard') {
        var isAdd = modal.type === 'addCard';
        var initialCtxIds = isAdd
          ? []
          : getCardContexts(cardKey(modal.deckId, modal.card.id));
        return h(CardModal, {
          title: isAdd ? 'Yeni kart' : 'Kartı düzenle',
          initialQ: isAdd ? '' : modal.card.q,
          initialA: isAdd ? '' : modal.card.a,
          initialExtra: isAdd ? null : {
            pronunciation: modal.card.pronunciation,
            example: modal.card.example,
            exampleTranslation: modal.card.exampleTranslation,
            image: modal.card.image
          },
          availableContexts: ctxState.contexts,
          initialContextIds: initialCtxIds,
          onGoToContexts: function () {
            setModal(null);
            setRoute({ name: 'contexts' });
          },
          onClose: function () { setModal(null); },
          onSubmit: function (q, a, ctxIds, extra) {
            if (isAdd) addCard(modal.deckId, q, a, ctxIds, extra);
            else editCard(modal.deckId, modal.card.id, q, a, ctxIds, extra);
          },
          // Toplu Ekle yalnız yeni kart modunda (düzenlemede anlamsız)
          onBulkSubmit: isAdd
            ? function (cards, ctxIds) { addBulkCards(modal.deckId, cards, ctxIds); }
            : null
        });
      }

      if (modal.type === 'confirm') {
        return h(Modal, { title: modal.title, onClose: function () { setModal(null); } },
          h('p', { className: 'confirm-text' }, modal.message),
          h('div', { className: 'modal-actions' },
            h('button', { className: 'btn ghost', onClick: function () { setModal(null); } }, 'Vazgeç'),
            h('button', { className: 'btn primary', onClick: modal.onConfirm }, modal.confirmLabel || 'Sil')
          )
        );
      }

      // Sprint 6: indirilen deste için bağlam önerisi
      if (modal.type === 'mpContext') {
        function closeMp() {
          setModal(null);
          showToast('Kartlar eklendi');
          setRoute({ name: 'detail', deckId: modal.deckId });
        }
        return h(Modal, { title: 'Bağlam önerisi', onClose: closeMp },
          h('p', { className: 'confirm-text' },
            modal.ctxEmoji + ' Bu desteyi “' + modal.ctxName +
            '” bağlamına bağlayalım mı? O bağlamdayken bu kartlar öne çıkar.'),
          h('div', { className: 'modal-actions', style: { flexDirection: 'column' } },
            h('button', { className: 'btn primary full',
              onClick: function () { applyMpContext(modal); } },
              'Evet, otomatik bağlam oluştur'),
            h('button', { className: 'btn ghost full',
              onClick: closeMp }, 'Hayır, bağlam olmasın'),
            h('button', { className: 'linkbtn',
              onClick: function () { setModal(null); setRoute({ name: 'contexts' }); } },
              'Manuel ayarlayacağım')
          )
        );
      }

      if (modal.type === 'import') {
        var inc = pendingImport;
        var incDecks = inc ? inc.deckNorm.decks : [];
        var nCards = incDecks.reduce(function (a, d) { return a + d.cards.length; }, 0);
        var nCtx = (inc && inc.ctxNorm) ? inc.ctxNorm.contexts.length : 0;
        var ctxNote = nCtx > 0 ? (' ve ' + nCtx + ' bağlam') : '';
        return h(Modal, { title: 'Yedeği içe aktar', onClose: function () { setModal(null); setPendingImport(null); } },
          h('p', { className: 'confirm-text' },
            'Dosyada ' + incDecks.length + ' deste, ' + nCards + ' kart' + ctxNote + ' bulundu. Nasıl uygulansın?'),
          h('div', { className: 'modal-actions', style: { flexDirection: 'column' } },
            h('button', { className: 'btn primary full', onClick: function () { applyImport('replace'); } },
              'Mevcut verinin yerine koy'),
            h('button', { className: 'btn ghost full', onClick: function () { applyImport('merge'); } },
              'Mevcut veriyle birleştir'),
            h('button', { className: 'linkbtn', onClick: function () { setModal(null); setPendingImport(null); } }, 'Vazgeç')
          )
        );
      }

      return null;
    }

    // ---------- Görünüm yönlendirme ----------

    // Sprint 4: onboarding gate — her şeyin (study dahil) ÜSTÜNDE
    if (!onboarded) {
      return h(OnboardingOverlay, {
        onFinish: finishOnboarding,
        onSample: createSampleDeck
      });
    }

    // Çalışma modu tam ekran (tab bar yok)
    if (route.name === 'study') {
      // Bağlam modu: route.ctxStudy varsa karışık-deste kart listesiyle çalış
      if (route.ctxStudy) {
        var cs = route.ctxStudy;
        if (!cs.cards || cs.cards.length === 0) {
          setRoute({ name: 'list' });
          return null;
        }
        return h('div', { className: 'app', style: { padding: 0 } },
          h(StudyView, {
            deck: { id: '__ctx__', name: cs.name, cards: [] },
            cards: cs.cards,
            titleOverride: (cs.emoji ? cs.emoji + ' ' : '') + cs.name,
            sessionKey: route.sessionKey,
            key: route.sessionKey,
            onExit: function () { setRoute({ name: 'list' }); },
            onRestart: function () {
              setRoute({ name: 'study', sessionKey: uid(), ctxStudy: cs });
            },
            onFinish: finishContextSession
          })
        );
      }
      // Mevcut deste çalışması — AYNEN korunur (cards prop'u verilmez)
      var sd = findDeck(route.deckId);
      if (!sd || sd.cards.length === 0) {
        setRoute({ name: 'list' });
        return null;
      }
      return h('div', { className: 'app', style: { padding: 0 } },
        h(StudyView, {
          deck: sd,
          key: route.sessionKey || sd.id,
          onExit: function () { setRoute({ name: 'list' }); },
          onRestart: function () { setRoute({ name: 'study', deckId: sd.id, sessionKey: uid() }); },
          onFinish: finishSession
        })
      );
    }

    var title = 'FlashCards';
    var body = null;
    var showBack = false;

    if (route.name === 'list') {
      // Banner: motoru canlı state'ten çalıştır, dismiss edilenleri çıkar
      var allMatches = evaluateContexts(geo);
      var visibleMatches = allMatches.filter(function (m) {
        return !dismissedBannerRef.current[m.context.id];
      });
      // Konum-gerekli bağlam var mı (eşleşme yokken "izin ver" linki için)?
      var needsLocation = false;
      ctxState.contexts.forEach(function (c) {
        if (c.notificationEnabled && c.location && !geo) needsLocation = true;
      });
      var deckList = h(DeckListView, {
        state: state,
        onNew: function () { setModal({ type: 'newDeck' }); },
        onOpen: function (id) { setRoute({ name: 'detail', deckId: id }); },
        onStudy: function (id) { setRoute({ name: 'study', deckId: id, sessionKey: uid() }); },
        onRename: function (d) { setModal({ type: 'renameDeck', deck: d }); },
        onDelete: function (d) {
          setModal({
            type: 'confirm',
            title: 'Desteyi sil',
            message: '“' + d.name + '” destesi ve içindeki ' + d.cards.length + ' kart kalıcı olarak silinecek. Emin misiniz?',
            confirmLabel: 'Sil',
            onConfirm: function () { deleteDeck(d.id); }
          });
        }
      });
      // Catch-up: aktif banner'da gösterilen bağlamı hariç tut
      var activeIds = {};
      visibleMatches.forEach(function (m) { activeIds[m.context.id] = true; });
      var catchups = computeCatchups().filter(function (c) {
        return !activeIds[c.context.id];
      });
      var topCatchup = catchups.length ? catchups[0] : null;
      body = h('div', null,
        h(BannerSection, {
          hasAnyContext: ctxState.contexts.length > 0,
          matches: visibleMatches,
          needsLocation: needsLocation,
          geoStatus: geoStatus,
          geoBusy: geoBusy,
          onStart: function (ctx) { startContextStudy(ctx); },
          onDismiss: function (ctxId) {
            dismissedBannerRef.current[ctxId] = true;
            setRefreshTick(function (x) { return x + 1; });
          },
          onSeeAll: function () { setRoute({ name: 'contexts' }); },
          onRefresh: function () { doGeoRefresh(); },
          onAskLocation: function () { doGeoRefresh(); }
        }),
        h(CatchupStrip, {
          item: topCatchup,
          onStudy: function (ctx) { startContextStudy(ctx); },
          onDismiss: function (ctxId) {
            dismissedCatchupRef.current[ctxId] = true;
            setRefreshTick(function (x) { return x + 1; });
          }
        }),
        deckList
      );
    } else if (route.name === 'detail') {
      var dd = findDeck(route.deckId);
      if (!dd) { setRoute({ name: 'list' }); return null; }
      title = dd.name;
      showBack = true;
      body = h(DeckDetailView, {
        deck: dd,
        onAddCard: function () { setModal({ type: 'addCard', deckId: dd.id }); },
        onEditCard: function (c) { setModal({ type: 'editCard', deckId: dd.id, card: c }); },
        onDeleteCard: function (c) {
          setModal({
            type: 'confirm',
            title: 'Kartı sil',
            message: 'Bu kart kalıcı olarak silinecek. Emin misiniz?',
            confirmLabel: 'Sil',
            onConfirm: function () { deleteCard(dd.id, c.id); }
          });
        },
        onStudy: function (id) { setRoute({ name: 'study', deckId: id, sessionKey: uid() }); }
      });
    } else if (route.name === 'stats') {
      title = 'İstatistik';
      body = h(StatsView, {
        state: state,
        ctxState: ctxState,
        onReset: function () {
          setModal({
            type: 'confirm',
            title: 'İstatistikleri sıfırla',
            message: 'Tüm seans ve başarı kayıtları silinecek (desteler ve kartlar kalır). Emin misiniz?',
            confirmLabel: 'Sıfırla',
            onConfirm: resetStats
          });
        }
      });
    } else if (route.name === 'data') {
      title = 'Veri';
      body = h(DataView, {
        state: state,
        ctxState: ctxState,
        toast: showToast,
        notifPerm: notifPerm,
        onAskNotif: requestNotifPermission,
        catchupOn: catchupOn,
        onToggleCatchup: function () {
          var nv = !catchupOn;
          setCatchupOn(nv);
          try { localStorage.setItem(CATCHUP_KEY, nv ? '1' : '0'); } catch (e) {}
        },
        onImport: function (norm, ctxNorm) {
          setPendingImport({ deckNorm: norm, ctxNorm: ctxNorm || null });
          setModal({ type: 'import' });
        }
      });
    } else if (route.name === 'discover') {
      title = 'Keşfet';
      body = h(DiscoverView, {
        status: mpStatus,
        manifest: mpData,
        dl: dl,
        onReload: function () { loadMP(true); },
        onDownload: function (meta) { downloadMarketplaceDeck(meta); }
      });
    } else if (route.name === 'contexts') {
      title = 'Bağlamlar';
      // Her bağlam için kart sayısı — tek geçişte (geçerli kart linkleri)
      var validCardKeys = {};
      state.decks.forEach(function (d) {
        d.cards.forEach(function (c) { validCardKeys[cardKey(d.id, c.id)] = true; });
      });
      var cardCounts = {};
      var linkMap = ctxState.cardContextLinks || {};
      Object.keys(linkMap).forEach(function (ck) {
        if (!validCardKeys[ck]) return;
        linkMap[ck].forEach(function (cid) {
          cardCounts[cid] = (cardCounts[cid] || 0) + 1;
        });
      });
      body = h(ContextListView, {
        contexts: ctxState.contexts,
        cardCounts: cardCounts,
        onNew: function () { setRoute({ name: 'contextEdit' }); },
        onOpen: function (id) { setRoute({ name: 'contextEdit', ctxId: id }); },
        onToggleNotif: function (id, val) {
          updateContext(id, { notificationEnabled: val });
        }
      });
    } else if (route.name === 'contextEdit') {
      var editingCtx = route.ctxId
        ? (ctxState.contexts.filter(function (c) { return c.id === route.ctxId; })[0] || null)
        : null;
      if (route.ctxId && !editingCtx) { setRoute({ name: 'contexts' }); return null; }
      title = editingCtx ? 'Bağlamı Düzenle' : 'Yeni Bağlam';
      showBack = true;
      body = h(ContextEditView, {
        key: route.ctxId || 'new',
        context: editingCtx,
        linkedCards: editingCtx ? getCardsForContext(editingCtx.id) : [],
        onStudyContext: editingCtx ? function () { startContextStudy(editingCtx); } : null,
        onRemoveLink: function (deckId, cardId) {
          removeCardContext(cardKey(deckId, cardId), editingCtx.id);
          showToast('Bağlantı kaldırıldı');
        },
        onOpenCard: function (deckId, cardId) {
          var d = findDeck(deckId);
          var card = d && d.cards.filter(function (c) { return c.id === cardId; })[0];
          if (!d || !card) { showToast('Kart bulunamadı'); return; }
          setRoute({ name: 'detail', deckId: deckId });
          setModal({ type: 'editCard', deckId: deckId, card: card });
        },
        onCancel: function () { setRoute({ name: 'contexts' }); },
        onSave: function (payload) {
          if (editingCtx) {
            updateContext(editingCtx.id, payload);
            showToast('Bağlam güncellendi');
          } else {
            createContext(payload);
            showToast('Bağlam oluşturuldu');
          }
          // Bildirim açık + izin henüz sorulmamışsa kaydederken iste
          if (payload.notificationEnabled && notificationPermState() === 'default') {
            ensureNotificationPermission().then(function () {
              setNotifPerm(notificationPermState());
              scheduleNextContextNotification();
            });
          }
          setRoute({ name: 'contexts' });
        },
        onDelete: function () {
          var linkedN = editingCtx ? getCardsForContext(editingCtx.id).length : 0;
          var relMsg = linkedN > 0
            ? ' ' + linkedN + ' kartla olan ilişkisi de kaldırılacak (kartlar silinmez).'
            : '';
          setModal({
            type: 'confirm',
            title: 'Bağlamı sil',
            message: '“' + (editingCtx ? editingCtx.name : '') + '” bağlamı kalıcı olarak silinecek.' + relMsg + ' Emin misiniz?',
            confirmLabel: 'Sil',
            onConfirm: function () {
              deleteContext(editingCtx.id);
              setModal(null);
              setRoute({ name: 'contexts' });
              showToast('Bağlam silindi');
            }
          });
        }
      });
    }

    function Tab(name, icon, label) {
      return h('button', {
        className: route.name === name ? 'active' : '',
        onClick: function () { setRoute({ name: name }); }
      }, h('span', { className: 'ic' }, icon), h('span', null, label));
    }

    // Geri butonu hedefi route'a göre: contextEdit → Bağlamlar, diğer → Desteler
    var backTarget = route.name === 'contextEdit' ? 'contexts' : 'list';
    var backLabel = route.name === 'contextEdit' ? '‹ Bağlamlar' : '‹ Desteler';

    return h('div', { className: 'app' },
      h('div', { className: 'topbar' },
        showBack
          ? h('button', { className: 'back', onClick: function () { setRoute({ name: backTarget }); } }, backLabel)
          : null,
        h('h1', null, title),
        h('button', {
          className: 'iconbtn',
          onClick: toggleTheme,
          'aria-label': theme === 'light' ? 'Koyu temaya geç' : 'Açık temaya geç',
          title: theme === 'light' ? 'Koyu tema' : 'Açık tema'
        }, theme === 'light' ? '☾' : '☀'),
        route.name === 'list'
          ? h('button', { className: 'iconbtn accent', onClick: function () { setModal({ type: 'newDeck' }); }, 'aria-label': 'Yeni deste' }, '＋')
          : null,
        route.name === 'contexts'
          ? h('button', { className: 'iconbtn accent', onClick: function () { setRoute({ name: 'contextEdit' }); }, 'aria-label': 'Yeni bağlam' }, '＋')
          : null
      ),
      h('div', { className: 'content' }, body),
      h('div', { className: 'tabs' },
        Tab('list', '▤', 'Desteler'),
        Tab('discover', '🌟', 'Keşfet'),
        Tab('contexts', '📍', 'Bağlamlar'),
        Tab('stats', '◷', 'İstatistik'),
        Tab('data', '⇅', 'Veri')
      ),
      renderModal(),
      swUpdate
        ? h('div', { className: 'sw-update' },
            h('span', null, 'Güncelleme hazır'),
            h('button', {
              className: 'linkbtn', onClick: function () { window.location.reload(); }
            }, 'Yenile')
          )
        : null,
      toast ? h(Toast, { key: toast.id, text: toast.text, onDone: function () { setToast(null); } }) : null
    );
  }

  // ---------- Modal: deste adı ----------
  function DeckNameModal(props) {
    var vh = useState(props.initial || '');
    var v = vh[0], setV = vh[1];
    var inputRef = useRef(null);
    useEffect(function () {
      if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
    }, []);
    function submit() {
      var name = v.trim();
      if (!name) { if (inputRef.current) inputRef.current.focus(); return; }
      props.onSubmit(name);
    }
    return h(Modal, { title: props.title, onClose: props.onClose },
      h('div', { className: 'field' },
        h('label', null, 'Deste adı'),
        h('input', {
          ref: inputRef, type: 'text', value: v, maxLength: 60,
          placeholder: 'Örn. İngilizce Kelimeler',
          onChange: function (e) { setV(e.target.value); },
          onKeyDown: function (e) { if (e.key === 'Enter') submit(); }
        })
      ),
      h('div', { className: 'modal-actions' },
        h('button', { className: 'btn ghost', onClick: props.onClose }, 'Vazgeç'),
        h('button', { className: 'btn primary', onClick: submit }, props.submitLabel)
      )
    );
  }

  // ---------- Sprint 5: Toplu kart ekleme bölümü ----------
  function BulkAddSection(props) {
    var txtH = useState('');
    var txt = txtH[0], setTxt = txtH[1];
    var revH = useState(false);
    var rev = revH[0], setRev = revH[1];
    var selH = useState([]);
    var sel = selH[0], setSel = selH[1];
    var showErrH = useState(false);
    var showErr = showErrH[0], setShowErr = showErrH[1];
    var expandH = useState(false);
    var expand = expandH[0], setExpand = expandH[1];
    var helpH = useState(false);
    var help = helpH[0], setHelp = helpH[1];

    var contexts = props.availableContexts || [];
    var parsed = parseBulkCards(txt);
    var cards = rev
      ? parsed.cards.map(function (c) { return { front: c.back, back: c.front }; })
      : parsed.cards;
    var errs = parsed.errors;

    function toggleCtx(id) {
      setSel(function (p) {
        return p.indexOf(id) >= 0
          ? p.filter(function (x) { return x !== id; })
          : p.concat([id]);
      });
    }

    var previewN = expand ? cards.length : 3;
    var shown = cards.slice(0, previewN);
    var moreN = cards.length - shown.length;

    return h('div', null,
      h('div', { className: 'cm-ctx-sub' },
        'Her satıra bir kart yaz. Soru ve cevabı şununla ayır: ',
        h('strong', null, '|'), ' veya ', h('strong', null, '-'),
        ' veya ', h('strong', null, '='), ' veya ', h('strong', null, ': '),
        ' veya sekme (Tab). Excel/Sheets’ten doğrudan yapıştırabilirsin.',
        h('button', {
          className: 'linkbtn', type: 'button',
          onClick: function () { setHelp(!help); }, 'aria-label': 'Yardım'
        }, ' ?')
      ),
      help ? h('div', { className: 'bulk-help' },
        h('div', null, '• Ayraçlar: | , - , = , “: ” , Tab'),
        h('div', null, '• Excel/Sheets’ten kopyala-yapıştır (Tab) çalışır'),
        h('div', null, '• Boş satırlar ve # ile başlayan satırlar yoksayılır'),
        h('div', null, '• “21:30 - randevu” gibi saatlerde diğer ayraç seçilir')
      ) : null,
      h('div', { className: 'field' },
        h('textarea', {
          className: 'bulk-ta mono', value: txt,
          placeholder: 'mitokondri | hücrenin enerji üreticisi\nribozom - protein sentezi yapar\ncat: kedi\nhello | merhaba',
          onChange: function (e) { setTxt(e.target.value); }
        })
      ),
      h('div', { className: 'bulk-status' },
        cards.length > 0
          ? h('span', { className: 'bulk-ok' }, '✓ ' + cards.length + ' kart algılandı')
          : h('span', { className: 'bulk-none' }, '0 kart algılandı, lütfen formatı kontrol et'),
        errs.length > 0
          ? h('button', {
              className: 'linkbtn', type: 'button',
              onClick: function () { setShowErr(!showErr); }
            }, '⚠ ' + errs.length + ' satır anlaşılamadı')
          : null
      ),
      (showErr && errs.length > 0)
        ? h('div', { className: 'bulk-err' },
            errs.map(function (er, i) {
              return h('div', { key: i, className: 'bulk-err-row' },
                'satır ' + er.lineNumber + ': ' + er.content + ' — ' + er.reason);
            })
          )
        : null,
      cards.length > 200
        ? h('div', { className: 'bulk-warn' },
            '200’den fazla kart — eklemek biraz yavaş olabilir.')
        : null,
      cards.length > 0
        ? h('div', null,
            h('div', { className: 'cm-ctx-sub', style: { marginTop: '6px' } }, 'Önizleme'),
            shown.map(function (c, i) {
              return h('div', { className: 'bulk-prev', key: i },
                h('div', { className: 'bulk-prev-q' }, 'Soru: ' + c.front),
                h('div', { className: 'bulk-prev-a' }, 'Cevap: ' + c.back)
              );
            }),
            moreN > 0
              ? h('button', {
                  className: 'linkbtn', type: 'button',
                  onClick: function () { setExpand(true); }
                }, '… ve ' + moreN + ' kart daha')
              : null
          )
        : null,
      h('div', { className: 'bulk-rev' },
        h('button', {
          className: 'toggle-sw' + (rev ? ' on' : ''), type: 'button',
          role: 'switch', 'aria-checked': rev ? 'true' : 'false',
          'aria-label': 'Ters çevir',
          onClick: function () { setRev(!rev); }
        }, h('span', { className: 'toggle-knob' })),
        h('span', { className: 'bulk-rev-lbl' }, 'Ters çevir (soru ↔ cevap)')
      ),
      contexts.length > 0
        ? h('div', { className: 'field cm-ctx' },
            h('label', null, 'Tüm kartlara bağlam ata (opsiyonel)'),
            h('div', { className: 'chip-row' },
              contexts.map(function (c) {
                var on = sel.indexOf(c.id) >= 0;
                return h('button', {
                  key: c.id, type: 'button',
                  className: 'chip' + (on ? ' sel' : ''),
                  onClick: function () { toggleCtx(c.id); }
                }, c.emoji + ' ' + c.name);
              })
            )
          )
        : null,
      h('div', { className: 'modal-actions' },
        h('button', { className: 'btn ghost', type: 'button', onClick: props.onClose }, 'İptal'),
        h('button', {
          className: 'btn primary', type: 'button',
          disabled: cards.length === 0,
          onClick: function () { props.onBulkSubmit(cards.slice(), sel.slice()); }
        }, cards.length + ' Kartı Ekle')
      )
    );
  }

  // ---------- Modal: kart ekle/düzenle ----------
  function CardModal(props) {
    var qh = useState(props.initialQ || '');
    var ah = useState(props.initialA || '');
    var q = qh[0], setQ = qh[1];
    var a = ah[0], setA = ah[1];
    var selH = useState(function () { return (props.initialContextIds || []).slice(); });
    var sel = selH[0], setSel = selH[1];
    var tabH = useState('single'); // 'single' | 'bulk' (kaydedilmez)
    var tab = tabH[0], setTab = tabH[1];
    // Sprint 6: zengin alanlar (düzenlemede initialExtra ile dolu)
    var ex = props.initialExtra || {};
    var pronH = useState(ex.pronunciation || '');
    var pron = pronH[0], setPron = pronH[1];
    var exmH = useState(ex.example || '');
    var exm = exmH[0], setExm = exmH[1];
    var exTrH = useState(ex.exampleTranslation || '');
    var exTr = exTrH[0], setExTr = exTrH[1];
    var imgH = useState(ex.image || '');
    var img = imgH[0], setImg = imgH[1];
    var qRef = useRef(null);
    var fileRef = useRef(null);
    useEffect(function () { if (qRef.current) qRef.current.focus(); }, []);

    function onPickImage(e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { setImg(String(rd.result)); };
      rd.readAsDataURL(f); // hata → görsel boş kalır (sessiz)
      e.target.value = '';
    }

    var contexts = props.availableContexts || [];
    var allowBulk = !!props.onBulkSubmit; // yalnız yeni kart (addCard) modunda

    function toggleCtx(id) {
      setSel(function (p) {
        return p.indexOf(id) >= 0
          ? p.filter(function (x) { return x !== id; })
          : p.concat([id]);
      });
    }

    function submit() {
      if (!q.trim() && !a.trim()) { if (qRef.current) qRef.current.focus(); return; }
      var extra = {};
      if (pron.trim()) extra.pronunciation = pron.trim();
      if (exm.trim()) extra.example = exm.trim();
      if (exTr.trim()) extra.exampleTranslation = exTr.trim();
      if (img) extra.image = img;
      props.onSubmit(q.trim(), a.trim(), sel.slice(), extra);
    }

    // Toplu Ekle sekmesi (yalnız yeni kart modunda)
    if (allowBulk && tab === 'bulk') {
      return h(Modal, { title: props.title, onClose: props.onClose },
        h('div', { className: 'cm-tabs' },
          h('button', {
            className: 'seg', type: 'button',
            onClick: function () { setTab('single'); }
          }, 'Tek Kart'),
          h('button', {
            className: 'seg active', type: 'button'
          }, 'Toplu Ekle')
        ),
        h(BulkAddSection, {
          availableContexts: contexts,
          onBulkSubmit: props.onBulkSubmit,
          onClose: props.onClose
        })
      );
    }

    return h(Modal, { title: props.title, onClose: props.onClose },
      allowBulk
        ? h('div', { className: 'cm-tabs' },
            h('button', {
              className: 'seg active', type: 'button'
            }, 'Tek Kart'),
            h('button', {
              className: 'seg', type: 'button',
              onClick: function () { setTab('bulk'); }
            }, 'Toplu Ekle')
          )
        : null,
      h('div', { className: 'field' },
        h('label', null, 'Soru (ön yüz)'),
        h('textarea', {
          ref: qRef, value: q, placeholder: 'Soruyu yazın…',
          onChange: function (e) { setQ(e.target.value); }
        })
      ),
      h('div', { className: 'field' },
        h('label', null, 'Cevap (arka yüz)'),
        h('textarea', {
          value: a, placeholder: 'Cevabı yazın…',
          onChange: function (e) { setA(e.target.value); }
        })
      ),
      // Sprint 6: zengin alanlar (hepsi opsiyonel)
      h('div', { className: 'field' },
        h('label', null, 'Telaffuz (opsiyonel)'),
        h('input', {
          type: 'text', value: pron, placeholder: '/ˈmen.juː/',
          onChange: function (e) { setPron(e.target.value); }
        })
      ),
      h('div', { className: 'field' },
        h('label', null, 'Örnek cümle (opsiyonel)'),
        h('textarea', {
          value: exm, placeholder: 'The menu is on the table.',
          onChange: function (e) { setExm(e.target.value); }
        })
      ),
      h('div', { className: 'field' },
        h('label', null, 'Örnek çevirisi (opsiyonel)'),
        h('input', {
          type: 'text', value: exTr, placeholder: 'Menü masanın üzerinde.',
          onChange: function (e) { setExTr(e.target.value); }
        })
      ),
      h('div', { className: 'field' },
        h('label', null, 'Görsel (opsiyonel)'),
        img
          ? h('div', { className: 'cm-img-prev' },
              h('img', { src: img, alt: '' }),
              h('button', {
                className: 'linkbtn danger', type: 'button',
                onClick: function () { setImg(''); }
              }, 'Kaldır'))
          : h('div', null,
              h('input', {
                type: 'file', accept: 'image/*', ref: fileRef,
                className: 'hidden-file', onChange: onPickImage
              }),
              h('button', {
                className: 'btn ghost', type: 'button',
                onClick: function () { fileRef.current && fileRef.current.click(); }
              }, '🖼️  Görsel ekle'))
      ),
      // Bağlamlar bölümü (Sprint 2)
      h('div', { className: 'field cm-ctx' },
        h('label', null, 'Bağlamlar'),
        h('div', { className: 'cm-ctx-sub' }, 'Bu kart hangi bağlamlarda öne çıksın?'),
        contexts.length === 0
          ? h('div', { className: 'cm-ctx-empty' },
              h('span', null, 'Henüz bağlam yok'),
              h('button', {
                className: 'linkbtn', type: 'button',
                onClick: props.onGoToContexts
              }, 'Bağlam ekle →'))
          : h('div', null,
              h('div', { className: 'cm-ctx-hint' },
                'Hiç seçilmezse bu kart tüm bağlamlarda gösterilir'),
              h('div', { className: 'chip-row' },
                contexts.map(function (c) {
                  var on = sel.indexOf(c.id) >= 0;
                  return h('button', {
                    key: c.id, type: 'button',
                    className: 'chip' + (on ? ' sel' : ''),
                    onClick: function () { toggleCtx(c.id); }
                  }, c.emoji + ' ' + c.name);
                })
              )
            )
      ),
      h('div', { className: 'modal-actions' },
        h('button', { className: 'btn ghost', onClick: props.onClose }, 'Vazgeç'),
        h('button', { className: 'btn primary', onClick: submit }, 'Kaydet')
      )
    );
  }

  // ---------- Mount ----------
  var root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(h(App));
})();
