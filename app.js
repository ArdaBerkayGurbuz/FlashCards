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
  // Sprint 7: retention (streak, günlük hedef, hatırlatma)
  var RETENTION_KEY = 'flashcards.retention.v1';
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
              // Sprint 7: SR alanları (yalnız >0 ise yaz, eski yedek bozulmasın)
              var sRep = Number(c.repetitions) || 0;
              var sInt = Number(c.intervalDays) || 0;
              var sEase = Number(c.easeFactor);
              if (sRep > 0) card.repetitions = sRep;
              if (sInt > 0) card.intervalDays = sInt;
              if (sEase >= 1.3 && sEase <= 3) card.easeFactor = sEase;
              if (typeof c.lastReviewedAt === 'number' && c.lastReviewedAt > 0)
                card.lastReviewedAt = c.lastReviewedAt;
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
        // Sprint 10: eski emoji'yi koru (geri yükleme için), yeni 'icon' alanını
        // doldur. Daha önce kaydedilmiş ikon varsa onu tut; yoksa emoji'yi
        // eşle. Sonuç: her bağlamda geçerli bir ikon ID'si garanti.
        var existingIcon = (typeof c.icon === 'string' && c.icon) ? c.icon : null;
        var emojiKey = typeof c.emoji === 'string' && c.emoji ? c.emoji : '📍';
        return {
          id: typeof c.id === 'string' ? c.id : ('ctx_' + uid()),
          name: typeof c.name === 'string' && c.name.trim() ? c.name : 'İsimsiz bağlam',
          emoji: emojiKey,
          icon: existingIcon || migrateContextIcon(emojiKey),
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

  /* ===== Sprint 8: Asenkron Challenge (meydan okuma) ===== */

  var CHALLENGE_VERSION = 1;
  var CHALLENGE_MAX_CARDS = 12;
  var CHALLENGE_URL_SAFE_LIMIT = 1900;
  var DUELS_KEY = 'flashcards.duels.v1';
  var LAST_CHALLENGER_NAME_KEY = 'flashcards.lastChallengerName';

  // UTF-8 güvenli base64 (Türkçe karakter destekli) + URL-safe varyant
  function encodeChallenge(ch) {
    var json = JSON.stringify(ch);
    var b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  function decodeChallenge(encoded) {
    var b64 = String(encoded || '').replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  }
  function buildChallengeUrl(ch) {
    var base = window.location.origin + window.location.pathname;
    return base + '#challenge=' + encodeChallenge(ch);
  }

  function emptyDuelsState() {
    return {
      sent: [],
      received: [],
      stats: { totalPlayed: 0, wins: 0, losses: 0, draws: 0 }
    };
  }
  function loadDuelsState() {
    try {
      var raw = localStorage.getItem(DUELS_KEY);
      if (!raw) return emptyDuelsState();
      var p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return emptyDuelsState();
      var st = emptyDuelsState();
      if (Array.isArray(p.sent)) st.sent = p.sent;
      if (Array.isArray(p.received)) st.received = p.received;
      if (p.stats && typeof p.stats === 'object') {
        st.stats.totalPlayed = Number(p.stats.totalPlayed) || 0;
        st.stats.wins = Number(p.stats.wins) || 0;
        st.stats.losses = Number(p.stats.losses) || 0;
        st.stats.draws = Number(p.stats.draws) || 0;
      }
      return st;
    } catch (e) {
      console.warn('Düello durumu okunamadı:', e);
      return emptyDuelsState();
    }
  }
  var duelsSaveTimer = null;
  function persistDuels(state) {
    if (duelsSaveTimer) clearTimeout(duelsSaveTimer);
    duelsSaveTimer = setTimeout(function () {
      try { localStorage.setItem(DUELS_KEY, JSON.stringify(state)); }
      catch (e) { console.error('Düello kaydedilemedi:', e); }
    }, 180);
  }

  // Kazanan mantığı: doğru sayısı desc → süre asc → berabere
  function duelOutcome(mine, theirs) {
    if (mine.score > theirs.score) return 'win';
    if (mine.score < theirs.score) return 'loss';
    if (mine.time < theirs.time) return 'win';
    if (mine.time > theirs.time) return 'loss';
    return 'draw';
  }

  /* ===== Sprint 9: Ses + Haptik + Animasyon ayarları ===== */

  var SOUND_KEY = 'flashcards.soundEnabled';
  var HAPTIC_KEY = 'flashcards.hapticEnabled';
  var ANIM_KEY = 'flashcards.animEnabled';

  function readBoolPref(k, dflt) {
    try {
      var v = localStorage.getItem(k);
      if (v === null) return dflt;
      return v !== '0';
    } catch (e) { return dflt; }
  }
  function writeBoolPref(k, v) {
    try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {}
  }
  function isSoundOn() { return readBoolPref(SOUND_KEY, true); }
  function isHapticOn() { return readBoolPref(HAPTIC_KEY, true); }
  function isAnimOn() { return readBoolPref(ANIM_KEY, true); }

  function reducedMotionPref() {
    try {
      return window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }
  function animationsAllowed() {
    return isAnimOn() && !reducedMotionPref();
  }
  function hapticSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  /* ===== Sprint 9: Web Audio motoru (programatik ton) ===== */

  var _audioCtx = null;
  function getAudioCtx() {
    if (_audioCtx) return _audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { _audioCtx = new AC(); } catch (e) { _audioCtx = null; }
    return _audioCtx;
  }
  // Tarayıcı autoplay politikası: ilk dokunuşa kadar suspend kalır
  function unlockAudioOnFirstGesture() {
    function unlock() {
      var ctx = getAudioCtx();
      if (ctx && ctx.state === 'suspended') {
        try { ctx.resume(); } catch (e) {}
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    }
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
  }
  function tone(freq, dur, type, vol, startAt) {
    var ctx = getAudioCtx();
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime + (startAt || 0);
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.12, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + dur);
    } catch (e) {}
  }

  // Ses olayı dispatcher (Sprint 9 ses paleti)
  // Sprint 12: kısa noise burst (mekanik klik karakteri). centerHz +
  // bandpass + hızlı exponential decay → "tık" tınısı.
  function noiseBurst(durSec, centerHz, q, vol, startAt) {
    var ctx = getAudioCtx();
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime + (startAt || 0);
      var sr = ctx.sampleRate;
      var len = Math.max(16, Math.floor(sr * durSec));
      var buf = ctx.createBuffer(1, len, sr);
      var data = buf.getChannelData(0);
      // 8.uncu kuvvete decay edilen beyaz gürültü → keskin transient
      for (var i = 0; i < len; i++) {
        var t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 8);
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = centerHz || 2500;
      filter.Q.value = q || 1.2;
      var g = ctx.createGain();
      g.gain.setValueAtTime(vol || 0.22, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + durSec);
      src.connect(filter); filter.connect(g); g.connect(ctx.destination);
      src.start(t0); src.stop(t0 + durSec);
    } catch (e) {}
  }

  function playSound(kind) {
    if (!isSoundOn()) return;
    switch (kind) {
      case 'correct':
        tone(523, 0.09, 'sine', 0.12);
        tone(784, 0.12, 'sine', 0.12, 0.08);
        return;
      case 'wrong':
        tone(280, 0.18, 'triangle', 0.10);
        tone(200, 0.20, 'triangle', 0.10, 0.10);
        return;
      case 'maybe':
        // Sprint 12: kararsız için nötr iki ton (cezalandırıcı değil,
        // ödüllendirici de değil — nötr/düşünceli his)
        tone(440, 0.10, 'sine', 0.10);
        tone(523, 0.10, 'sine', 0.10, 0.10);
        return;
      case 'flip':
        tone(1200, 0.025, 'square', 0.04);
        return;
      case 'switch':
        // Sprint 12: mekanik ışık anahtarı "tık-tak"
        // Tık: yüksek frekanslı transient burst (klik karakteri)
        // Tak: hafif düşük frekanslı gövde sesi
        noiseBurst(0.018, 2600, 1.4, 0.30, 0);
        noiseBurst(0.040, 380, 1.0, 0.16, 0.012);
        return;
      case 'streak':
        tone(523, 0.10, 'sine', 0.12);
        tone(659, 0.10, 'sine', 0.12, 0.08);
        tone(784, 0.12, 'sine', 0.12, 0.16);
        return;
      case 'win':
        tone(523, 0.10, 'sine', 0.12);
        tone(659, 0.10, 'sine', 0.12, 0.08);
        tone(784, 0.10, 'sine', 0.12, 0.16);
        tone(1046, 0.16, 'sine', 0.14, 0.24);
        return;
      case 'loss':
        tone(392, 0.18, 'sine', 0.10);
        tone(330, 0.22, 'sine', 0.10, 0.12);
        return;
      case 'draw':
        tone(659, 0.10, 'sine', 0.10);
        tone(659, 0.10, 'sine', 0.10, 0.14);
        return;
    }
  }

  /* ===== Sprint 9: Haptik (titreşim) ===== */

  function haptic(pattern) {
    if (!isHapticOn()) return;
    if (!hapticSupported()) return;
    try { navigator.vibrate(pattern); } catch (e) {}
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

  /* ===== Sprint 7: Retention (streak + günlük hedef + hatırlatma) ===== */

  // Local takvim tabanlı YYYY-MM-DD (UTC DEĞİL — gece yarısı doğru hesaplansın)
  function getTodayString() {
    var d = new Date();
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function parseDateStr(s) {
    // 'YYYY-MM-DD' → Date (local 00:00)
    if (!s || typeof s !== 'string') return null;
    var p = s.split('-');
    if (p.length !== 3) return null;
    var d = new Date(parseInt(p[0], 10),
                     parseInt(p[1], 10) - 1,
                     parseInt(p[2], 10), 0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  function isYesterday(prevStr, todayStr) {
    var prev = parseDateStr(prevStr);
    var today = parseDateStr(todayStr);
    if (!prev || !today) return false;
    var diffMs = today.getTime() - prev.getTime();
    // 1 günden büyük tolerans: 23-25 saat arası (DST için)
    return diffMs >= 23 * 3600000 && diffMs <= 25 * 3600000;
  }

  function defaultRetention() {
    return {
      streak: { current: 0, longest: 0, lastStudyDate: null, studyDates: [] },
      dailyGoal: { target: 20, todayCount: 0, todayDate: null },
      reminder: { enabled: false, time: '20:00', lastFiredDate: null }
    };
  }

  function loadRetentionState() {
    try {
      var raw = localStorage.getItem(RETENTION_KEY);
      if (!raw) return defaultRetention();
      var parsed = JSON.parse(raw);
      var d = defaultRetention();
      if (parsed && typeof parsed === 'object') {
        if (parsed.streak && typeof parsed.streak === 'object') {
          d.streak.current = Number(parsed.streak.current) || 0;
          d.streak.longest = Number(parsed.streak.longest) || 0;
          d.streak.lastStudyDate = typeof parsed.streak.lastStudyDate === 'string'
            ? parsed.streak.lastStudyDate : null;
          d.streak.studyDates = Array.isArray(parsed.streak.studyDates)
            ? parsed.streak.studyDates.filter(function (x) {
                return typeof x === 'string';
              }).slice(-60) : [];
        }
        if (parsed.dailyGoal && typeof parsed.dailyGoal === 'object') {
          var t = Number(parsed.dailyGoal.target);
          d.dailyGoal.target = (t >= 5 && t <= 500) ? t : 20;
          d.dailyGoal.todayCount = Number(parsed.dailyGoal.todayCount) || 0;
          d.dailyGoal.todayDate = typeof parsed.dailyGoal.todayDate === 'string'
            ? parsed.dailyGoal.todayDate : null;
        }
        if (parsed.reminder && typeof parsed.reminder === 'object') {
          d.reminder.enabled = !!parsed.reminder.enabled;
          if (typeof parsed.reminder.time === 'string' &&
              /^\d{2}:\d{2}$/.test(parsed.reminder.time)) {
            d.reminder.time = parsed.reminder.time;
          }
          d.reminder.lastFiredDate = typeof parsed.reminder.lastFiredDate === 'string'
            ? parsed.reminder.lastFiredDate : null;
        }
      }
      return d;
    } catch (e) {
      return defaultRetention();
    }
  }

  function saveRetentionState(s) {
    try { localStorage.setItem(RETENTION_KEY, JSON.stringify(s)); }
    catch (e) {}
  }

  // Çalışma oturumu sonunda çağrılır. Mevcut state'i okur, mutate eder,
  // kaydeder; { newStreak, didIncrement } döndürür (kutlama için).
  function recordStudySession(cardsStudied) {
    var state = loadRetentionState();
    var today = getTodayString();
    var lastDate = state.streak.lastStudyDate;
    var prevStreak = state.streak.current;
    var didIncrement = false;

    if (lastDate === today) {
      // bugün zaten çalışılmış — streak aynı
    } else if (lastDate && isYesterday(lastDate, today)) {
      state.streak.current += 1;
      didIncrement = true;
    } else {
      state.streak.current = 1;
      didIncrement = prevStreak !== 1;
    }
    if (state.streak.current > state.streak.longest) {
      state.streak.longest = state.streak.current;
    }
    state.streak.lastStudyDate = today;
    if (state.streak.studyDates.indexOf(today) < 0) {
      state.streak.studyDates.push(today);
      state.streak.studyDates = state.streak.studyDates.slice(-60);
    }

    if (state.dailyGoal.todayDate !== today) {
      state.dailyGoal.todayDate = today;
      state.dailyGoal.todayCount = 0;
    }
    state.dailyGoal.todayCount += (Number(cardsStudied) || 0);

    saveRetentionState(state);
    return { state: state, newStreak: state.streak.current, didIncrement: didIncrement };
  }

  // Uygulama açılışında streak'in hâlâ geçerli olup olmadığını kontrol et.
  // Bugün veya dün çalışılmadıysa streak'i sıfırla.
  function checkStreakBroken() {
    var state = loadRetentionState();
    var today = getTodayString();
    var lastDate = state.streak.lastStudyDate;
    if (!lastDate) return state;
    if (lastDate === today || isYesterday(lastDate, today)) return state;
    if (state.streak.current > 0) {
      state.streak.current = 0;
      saveRetentionState(state);
    }
    return state;
  }

  // Kart "öğrenilmiş" sayılır mı? (SM-2 hafif: rep>=2 veya interval>=7)
  function isCardLearned(c) {
    if (!c) return false;
    return (Number(c.repetitions) || 0) >= 2 ||
           (Number(c.intervalDays) || 0) >= 7;
  }

  function deckLearnedPercent(deck) {
    if (!deck || !deck.cards || deck.cards.length === 0) return 0;
    var learned = 0;
    for (var i = 0; i < deck.cards.length; i++) {
      if (isCardLearned(deck.cards[i])) learned++;
    }
    return Math.round((learned / deck.cards.length) * 100);
  }

  // Hatırlatma bildirimi (günlük sabit saat).
  function fireDailyReminder(retentionState) {
    if (!notificationSupported() || Notification.permission !== 'granted') return;
    var today = getTodayString();
    var remaining;
    if (retentionState.dailyGoal.todayDate === today) {
      remaining = Math.max(0,
        retentionState.dailyGoal.target - retentionState.dailyGoal.todayCount);
    } else {
      remaining = retentionState.dailyGoal.target;
    }
    var streak = retentionState.streak.current;
    var body = streak > 0
      ? streak + ' günlük serini koru! ' + remaining + ' kart kaldı.'
      : 'Bugün ' + remaining + ' kart çalışmaya ne dersin?';
    var opts = {
      body: body,
      tag: 'daily-reminder',
      data: { action: 'study' },
      icon: './icons/flashcards_icons/pwa/icon-192.png',
      badge: './icons/flashcards_icons/pwa/icon-192.png'
    };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          reg.showNotification('📚 Çalışma zamanı!', opts);
        }).catch(function () {
          try { new Notification('📚 Çalışma zamanı!', opts); } catch (e) {}
        });
      } else {
        new Notification('📚 Çalışma zamanı!', opts);
      }
    } catch (e) {}
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

  /* ===== Sprint 9: İkon kayıt defteri (inline SVG, offline) ===== */
  // currentColor → tema değişikliklerinde otomatik renk geçişi
  var ICONS = {
    decks:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    discover:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4L12 3z"/><path d="M5 18l.6 1.4L7 20l-1.4.6L5 22l-.6-1.4L3 20l1.4-.6L5 18z"/><path d="M19 14l.5 1.2L21 16l-1.5.8L19 18l-.5-1.2L17 16l1.5-.8L19 14z"/></svg>',
    contexts:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    stats:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="13"/><line x1="22" y1="20" x2="2" y2="20"/></svg>',
    data:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 10 12 5 17 10"/><line x1="12" y1="5" x2="12" y2="14"/><polyline points="7 17 12 22 17 17"/><line x1="12" y1="22" x2="12" y2="13"/></svg>',
    plus:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    sun:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.8" y1="4.8" x2="6.9" y2="6.9"/><line x1="17.1" y1="17.1" x2="19.2" y2="19.2"/><line x1="4.8" y1="19.2" x2="6.9" y2="17.1"/><line x1="17.1" y1="6.9" x2="19.2" y2="4.8"/></svg>',
    moon:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    check:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>',
    cross:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    tilde:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/></svg>',
    trophy:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v6a5 5 0 0 1-10 0V4z"/><path d="M17 4h3v3a3 3 0 0 1-3 3"/><path d="M7 4H4v3a3 3 0 0 0 3 3"/></svg>',
    flex:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13c2 0 3-1 3-3V5a2 2 0 0 1 4 0c0 4 1 6 5 6s4 4 0 5c-3 1-6 2-9 2s-6-1-7-3 1-2 4-2z"/></svg>',
    handshake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l2 2a2 2 0 0 0 3 0l4-4a2 2 0 0 0 0-3l-3-3"/><path d="M13 7l-2-2a2 2 0 0 0-3 0L4 9a2 2 0 0 0 0 3l3 3"/><path d="M9 13l3-3 3 3 3-3"/></svg>',

    /* === Sprint 10: aksiyon ikonları === */
    play:        '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    trash:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
    edit:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    refresh:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    swords:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" y1="14" x2="9" y2="18"/><line x1="7" y1="17" x2="4" y2="20"/><line x1="3" y1="19" x2="5" y2="21"/></svg>',
    share:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    link:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    whatsapp:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    star:        '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    clock:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
    sparkles:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4L12 3z"/><path d="M5 18l.6 1.4L7 20l-1.4.6L5 22l-.6-1.4L3 20l1.4-.6L5 18z"/><path d="M19 14l.5 1.2L21 16l-1.5.8L19 18l-.5-1.2L17 16l1.5-.8L19 14z"/></svg>',
    fire:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1 4 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4-1 4 2 4 2 0 0-1 0-3 0-4z"/><path d="M8 14a4 4 0 0 0 8 0c0-1-.5-2-1-3"/></svg>',
    target:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>',
    note:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',

    /* === Sprint 10: bağlam kategori ikonları === */
    coffee:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a3 3 0 0 1 0 6h-1"/><path d="M3 8h15v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/><line x1="6" y1="2" x2="6" y2="5"/><line x1="10" y1="2" x2="10" y2="5"/><line x1="14" y1="2" x2="14" y2="5"/></svg>',
    home:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5l9-7 9 7V21a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z"/></svg>',
    building:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="9" y1="22" x2="9" y2="18"/><line x1="15" y1="22" x2="15" y2="18"/><line x1="8" y1="6" x2="10" y2="6"/><line x1="14" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/></svg>',
    car:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 16H9m10 0h2v-3.5L19.4 9a2 2 0 0 0-1.85-1.25h-11.1A2 2 0 0 0 4.6 9L3 12.5V16h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
    run:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M4 22l3-8 4 1 1 6"/><path d="M7 14l-3-4 5-4 4 4 3-1"/></svg>',
    book:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    utensils:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V2"/><line x1="5" y1="11" x2="5" y2="22"/><path d="M17 2v20"/><path d="M17 13c-2.5 0-4-1.5-4-4 0-4 4-7 4-7"/></svg>',
    bed:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18V8h8a4 4 0 0 1 4 4v2h6v4"/><line x1="3" y1="18" x2="3" y2="21"/><line x1="21" y1="18" x2="21" y2="21"/><circle cx="7" cy="12" r="1.5"/></svg>',
    dumbbell:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6.5" y1="6.5" x2="17.5" y2="17.5"/><path d="M3 7l4-4 4 4-4 4z"/><path d="M21 17l-4 4-4-4 4-4z"/><path d="M2 12l3 3"/><path d="M19 9l3 3"/></svg>',
    headphones:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3v4z"/><path d="M3 19a2 2 0 0 0 2 2h1v-6H3v4z"/></svg>',
    tree:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-3 3-5 5-5 8a5 5 0 0 0 4 5v3"/><path d="M12 2c3 3 5 5 5 8a5 5 0 0 1-4 5v3"/><line x1="9" y1="22" x2="15" y2="22"/></svg>',
    train:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="3"/><line x1="4" y1="11" x2="20" y2="11"/><circle cx="8.5" cy="15.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><line x1="7" y1="22" x2="5" y2="20"/><line x1="17" y1="22" x2="19" y2="20"/></svg>',
    clockAlarm:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 14.5 14.5"/><path d="M5 3L2 6"/><path d="M19 3l3 3"/></svg>',
    plane:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
    cap:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 3 3 6 3s6-2 6-3v-5"/></svg>',
    briefcase:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    cart:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>',
    hospital:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="16" rx="2"/><path d="M9 6V2h6v4"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
    beach:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l8 4-3 3-5-2-5 2-3-3 8-4z"/><line x1="12" y1="8" x2="12" y2="20"/><path d="M3 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
    film:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>',
    gamepad:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>',
    palette:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="0.5"/><circle cx="17.5" cy="10.5" r="0.5"/><circle cx="8.5" cy="7.5" r="0.5"/><circle cx="6.5" cy="12.5" r="0.5"/><path d="M12 2a10 10 0 1 0 10 10c0-2-2-2-4-2h-1a2 2 0 0 1 0-4c2 0 2-2 2-2A10 10 0 0 0 12 2z"/></svg>',
    umbrella:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12a10 10 0 0 0-20 0z"/><path d="M12 12v8a2 2 0 0 0 4 0"/></svg>',
    snowflake:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M5 5l14 14"/><path d="M19 5L5 19"/><path d="M12 5l-2 2"/><path d="M12 5l2 2"/><path d="M12 19l-2-2"/><path d="M12 19l2-2"/></svg>',
    lightbulb:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 1 4 12c-1 1-1.5 2-1.5 3h-5c0-1-.5-2-1.5-3a7 7 0 0 1 4-12z"/></svg>',
    brain:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 .5 5 3 3 0 0 0 .5 5 3 3 0 0 0 3 3 3 3 0 0 0 2-1 3 3 0 0 0 2 1 3 3 0 0 0 3-3 3 3 0 0 0 .5-5 3 3 0 0 0 .5-5 3 3 0 0 0-3-3 3 3 0 0 0-3-3z"/></svg>',
    tea:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11h12v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M17 12h1a3 3 0 0 1 0 6h-1"/><path d="M8 5c1-1 2-1 3 0s2 1 3 0"/></svg>',
    sunrise:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/><polyline points="8 6 12 2 16 6"/></svg>',
    nightCity:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/><line x1="3" y1="22" x2="21" y2="22"/></svg>',
    pin:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>'
  };

  function IconEl(name, size) {
    var svg = ICONS[name] || '';
    var sz = (size || 22);
    return h('span', {
      className: 'icon icon-' + name,
      style: { width: sz + 'px', height: sz + 'px' },
      'aria-hidden': 'true',
      dangerouslySetInnerHTML: { __html: svg }
    });
  }

  /* ===== Sprint 10: Bağlam ikon kataloğu (eski emoji grid yerine) ===== */

  var CONTEXT_ICONS = [
    { id: 'coffee', label: 'Kafe' },
    { id: 'home', label: 'Ev' },
    { id: 'building', label: 'Ofis' },
    { id: 'car', label: 'Araba' },
    { id: 'run', label: 'Koşu' },
    { id: 'book', label: 'Kitap' },
    { id: 'utensils', label: 'Yemek' },
    { id: 'bed', label: 'Uyku' },
    { id: 'dumbbell', label: 'Spor' },
    { id: 'headphones', label: 'Müzik' },
    { id: 'tree', label: 'Doğa' },
    { id: 'train', label: 'Toplu taşıma' },
    { id: 'sun', label: 'Gün' },
    { id: 'moon', label: 'Gece' },
    { id: 'clockAlarm', label: 'Alarm' },
    { id: 'pin', label: 'Konum' },
    { id: 'plane', label: 'Seyahat' },
    { id: 'cap', label: 'Okul' },
    { id: 'briefcase', label: 'İş' },
    { id: 'cart', label: 'Alışveriş' },
    { id: 'hospital', label: 'Sağlık' },
    { id: 'beach', label: 'Tatil' },
    { id: 'film', label: 'Sinema' },
    { id: 'gamepad', label: 'Oyun' },
    { id: 'palette', label: 'Sanat' },
    { id: 'umbrella', label: 'Yağmur' },
    { id: 'snowflake', label: 'Kış' },
    { id: 'fire', label: 'Seri' },
    { id: 'star', label: 'Yıldız' },
    { id: 'lightbulb', label: 'Fikir' },
    { id: 'note', label: 'Not' },
    { id: 'brain', label: 'Düşünce' },
    { id: 'tea', label: 'Çay' },
    { id: 'sunrise', label: 'Sabah' },
    { id: 'nightCity', label: 'Şehir gecesi' },
    { id: 'target', label: 'Hedef' }
  ];

  // Sprint <=9'da kaydedilmiş emoji → Sprint 10 ikon ID eşlemesi
  var EMOJI_TO_ICON = {
    '☕': 'coffee', '🏠': 'home', '🏢': 'building', '🚗': 'car',
    '🏃': 'run', '📚': 'book', '🍽️': 'utensils', '🍽': 'utensils',
    '🛏️': 'bed', '🛏': 'bed', '🏋️': 'dumbbell', '🏋': 'dumbbell',
    '🎧': 'headphones', '🌳': 'tree', '🚇': 'train',
    '☀️': 'sun', '☀': 'sun', '🌙': 'moon', '⏰': 'clockAlarm',
    '📍': 'pin', '✈️': 'plane', '✈': 'plane', '🎓': 'cap',
    '💼': 'briefcase', '🛒': 'cart', '🏥': 'hospital',
    '🏖️': 'beach', '🏖': 'beach', '🎬': 'film', '🎮': 'gamepad',
    '🎨': 'palette', '☔': 'umbrella', '❄️': 'snowflake', '❄': 'snowflake',
    '🔥': 'fire', '⭐': 'star', '💡': 'lightbulb',
    '📝': 'note', '🧠': 'brain', '🍵': 'tea', '🌅': 'sunrise',
    '🌃': 'nightCity', '🎯': 'target'
  };
  function migrateContextIcon(emoji) {
    var key = String(emoji || '').trim();
    return EMOJI_TO_ICON[key] || 'pin';
  }
  // Bağlam görselini güvenli şekilde döndür: yeni icon → varsa onu, yoksa
  // eski emoji'yi map'ten dön. Sonuç her zaman geçerli bir ICONS anahtarıdır.
  function contextIconName(ctx) {
    if (ctx && typeof ctx.icon === 'string' && ICONS[ctx.icon]) return ctx.icon;
    return migrateContextIcon(ctx && ctx.emoji);
  }
  function renderContextIcon(ctx, size) {
    return IconEl(contextIconName(ctx), size || 18);
  }

  /* ===== Sprint 9: Konfeti (kutlama overlay) ===== */
  function Confetti(props) {
    useEffect(function () {
      var t = setTimeout(props.onDone || function () {}, 1500);
      return function () { clearTimeout(t); };
    }, []);
    if (!animationsAllowed()) return null;
    var pieces = [];
    for (var i = 0; i < 18; i++) {
      pieces.push(h('span', {
        key: i,
        className: 'cnf-piece cnf-c' + (i % 4),
        style: {
          left: Math.round(Math.random() * 100) + '%',
          animationDelay: Math.round(Math.random() * 600) + 'ms'
        }
      }));
    }
    return h('div', { className: 'confetti', 'aria-hidden': 'true' }, pieces);
  }

  /* ===== Sprint 4: Onboarding (3 ekran, route'tan bağımsız overlay) ===== */

  function OnboardingOverlay(props) {
    var stepH = useState(0); // 0..3 — localStorage'a YAZILMAZ (session-only)
    var step = stepH[0], setStep = stepH[1];
    // Sprint 7: günlük hedef + hatırlatma seçimi (4. ekran)
    var goalH = useState(20);
    var goal = goalH[0], setGoal = goalH[1];
    var remH = useState(false);
    var rem = remH[0], setRem = remH[1];
    var remTH = useState('20:00');
    var remT = remTH[0], setRemT = remTH[1];

    function finish(withSample) {
      // Sprint 7: hedef + (varsa) hatırlatma kaydet
      try {
        var st = loadRetentionState();
        st.dailyGoal.target = goal >= 5 ? goal : 20;
        if (rem) {
          st.reminder.enabled = true;
          if (/^\d{2}:\d{2}$/.test(remT)) st.reminder.time = remT;
        }
        saveRetentionState(st);
      } catch (e) {}
      if (withSample) props.onSample();
      props.onFinish();
    }

    var dots = h('div', { className: 'onb-dots' },
      [0, 1, 2, 3].map(function (i) {
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
        h('div', { className: 'onb-art' }, '🎯'),
        h('h2', { className: 'onb-title' }, 'Günlük hedef'),
        h('p', { className: 'onb-text' },
          'Her gün kaç kart çalışmak istersin? Küçük adımlar büyük seriler.'),
        h('div', { className: 'goal-presets' },
          [10, 20, 30].map(function (n) {
            return h('button', {
              key: n, type: 'button',
              className: 'goal-chip' + (goal === n ? ' sel' : ''),
              onClick: function () { setGoal(n); }
            }, n + ' kart');
          })
        ),
        h('div', { className: 'spacer-sm' }),
        h('label', { className: 'cm-ctx-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('span', null, '🔔 Günlük hatırlatma'),
          h('button', {
            className: 'toggle-sw' + (rem ? ' on' : ''), type: 'button',
            role: 'switch', 'aria-checked': rem ? 'true' : 'false',
            'aria-label': 'Günlük hatırlatma',
            onClick: function () { setRem(!rem); }
          }, h('span', { className: 'toggle-knob' }))
        ),
        rem
          ? h('div', { className: 'field', style: { marginTop: '12px' } },
              h('label', null, 'Saat'),
              h('input', {
                type: 'time', value: remT,
                onChange: function (e) { setRemT(e.target.value); }
              })
            )
          : null,
        h('div', { className: 'spacer-sm' }),
        h('button', { className: 'btn primary full lg', onClick: function () { setStep(3); } }, 'Devam')
      ),
      h('div', { className: 'onb-screen', key: 's3' },
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
                className: 'btn primary btn-icon-label',
                disabled: d.cards.length === 0,
                onClick: function () { props.onStudy(d.id); }
              }, IconEl('play', 14), h('span', null, 'Çalış')),
              h('button', { className: 'btn ghost', onClick: function () { props.onOpen(d.id); } }, 'Kartlar'),
              h('button', { className: 'linkbtn', onClick: function () { props.onRename(d); } }, 'Ad'),
              h('button', { className: 'linkbtn danger btn-icon-label', onClick: function () { props.onDelete(d); } }, IconEl('trash', 14), h('span', null, 'Sil'))
            )
          );
        })
      )
    );
  }

  // ---------- Deste detay (kart yönetimi) ----------

  function DeckDetailView(props) {
    var deck = props.deck;
    var learned = deckLearnedPercent(deck);
    return h('div', null,
      h('div', { className: 'section-head' },
        h('span', { className: 'lbl' }, deck.cards.length + ' kart'),
        h('button', { className: 'linkbtn', onClick: function () { props.onAddCard(); } }, '＋ Kart ekle')
      ),
      deck.cards.length > 0
        ? h('div', { className: 'deck-learned' },
            'Bu destenin ', h('strong', null, '%' + learned), '\'ini öğrendin')
        : null,
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
                  h('button', { className: 'linkbtn btn-icon-label', onClick: function () { props.onEditCard(c); } }, IconEl('edit', 14), h('span', null, 'Düzenle')),
                  h('button', { className: 'linkbtn danger btn-icon-label', onClick: function () { props.onDeleteCard(c); } }, IconEl('trash', 14), h('span', null, 'Sil'))
                )
              );
            }),
            h('div', { className: 'spacer-sm' }),
            h('button', {
              className: 'btn primary full lg btn-icon-label',
              disabled: deck.cards.length === 0,
              onClick: function () { props.onStudy(deck.id); }
            }, IconEl('play', 18), h('span', null, 'Bu desteyi çalış')),
            // Sprint 8: Meydan Oku
            h('div', { className: 'spacer-sm' }),
            h('button', {
              className: 'btn duel full lg btn-icon-label',
              disabled: deck.cards.length < 2,
              title: deck.cards.length < 2 ? 'En az 2 kart gerekli' : '',
              onClick: function () { props.onChallenge && props.onChallenge(deck.id); }
            }, IconEl('swords', 18), h('span', null, 'Meydan Oku'))
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

    // Sprint 9 + Sprint 12: cevap geri bildirimi (ses+haptik+flash sınıfı)
    // Sprint 12: 'maybe' artık nötr geri bildirim alır
    var fbSt = useState(null);  // null | 'good' | 'maybe' | 'bad'
    var feedback = fbSt[0], setFeedback = fbSt[1];
    var fbTimer = useRef(null);

    function advance(rating) {
      // rating: 'good' | 'maybe' | 'bad'
      setS(function (p) {
        // Sprint 7: SR alanlarını güncelle (deste modunda gerçek kart;
        // bağlam modunda 'deckId::cardId' bileşik id)
        if (p.current && props.onCardReview) {
          props.onCardReview(p.current.id, rating);
        }
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

      // Sprint 12: tüm üç rating için ses + haptik + görsel geri bildirim
      if (rating === 'good') {
        playSound('correct'); haptic(15);
        if (animationsAllowed()) setFeedback('good');
      } else if (rating === 'bad') {
        playSound('wrong'); haptic([10, 50, 10]);
        if (animationsAllowed()) setFeedback('bad');
      } else if (rating === 'maybe') {
        playSound('maybe'); haptic([8, 40, 8]);
        if (animationsAllowed()) setFeedback('maybe');
      }
      if (fbTimer.current) clearTimeout(fbTimer.current);
      fbTimer.current = setTimeout(function () { setFeedback(null); }, 480);

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
        if (fbTimer.current) clearTimeout(fbTimer.current);
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
          h('div', { className: 'seal' }, IconEl('sparkles', 56)),
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
          h('button', { className: 'btn ghost full btn-icon-label', onClick: props.onRestart }, IconEl('refresh', 16), h('span', null, 'Tekrar çalış'))
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
      (anim === 'leaving' ? ' leaving' : anim === 'entering' ? ' entering' : '') +
      (feedback === 'good' ? ' fb-good'
        : feedback === 'bad' ? ' fb-bad'
        : feedback === 'maybe' ? ' fb-maybe' : '');

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
              : h('div', { className: 'face-header-chip', 'aria-hidden': 'true' },
                  IconEl('note', 14), h('span', null, 'Soru')),
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
              h('span', { className: 'ic' }, IconEl('cross', 20)), h('span', null, 'Bilmiyorum')),
            h('button', { className: 'rate maybe', onClick: function (e) { e.stopPropagation(); requestAdvance('maybe'); } },
              h('span', { className: 'ic' }, IconEl('tilde', 20)), h('span', null, 'Kararsız')),
            h('button', { className: 'rate good', onClick: function (e) { e.stopPropagation(); requestAdvance('good'); } },
              h('span', { className: 'ic' }, IconEl('check', 20)), h('span', null, 'Biliyorum'))
          )
        : h('div', { className: 'tap-hint' }, 'Karta dokun, sonra kendini değerlendir')
    );
  }

  /* ===== Sprint 8: Challenge bileşenleri ===== */

  // Meydan oku başlatma modalı (deste detayından)
  function ChallengeSetupModal(props) {
    var initialName = '';
    try { initialName = localStorage.getItem(LAST_CHALLENGER_NAME_KEY) || ''; } catch (e) {}
    var nameH = useState(initialName);
    var name = nameH[0], setName = nameH[1];
    var maxCards = Math.min(props.deckSize, CHALLENGE_MAX_CARDS);
    var presetOptions = [5, 10, 15].filter(function (n) { return n <= maxCards; });
    if (presetOptions.length === 0) presetOptions = [maxCards];
    var initN = presetOptions.indexOf(10) >= 0 ? 10 : presetOptions[0];
    var nH = useState(initN);
    var n = nH[0], setN = nH[1];
    var inputRef = useRef(null);
    useEffect(function () {
      if (inputRef.current) inputRef.current.focus();
    }, []);
    function submit() {
      var nm = (name || '').trim().slice(0, 30);
      try {
        if (nm) localStorage.setItem(LAST_CHALLENGER_NAME_KEY, nm);
      } catch (e) {}
      props.onStart({ name: nm, cardCount: Math.min(n, maxCards) });
    }
    return h(Modal, { title: '⚔️ Meydan Oku', onClose: props.onClose },
      h('div', { className: 'field' },
        h('label', null, 'Adın'),
        h('input', {
          ref: inputRef, type: 'text', value: name, maxLength: 30,
          placeholder: 'Örn. Arda',
          onChange: function (e) { setName(e.target.value); },
          onKeyDown: function (e) { if (e.key === 'Enter') submit(); }
        }),
        h('div', { className: 'help', style: { marginTop: '6px', opacity: 0.7, fontSize: '13px' } },
          'Arkadaşın seni bu adla görecek')
      ),
      h('div', { className: 'field', style: { marginTop: '12px' } },
        h('label', null, 'Kaç kart?'),
        h('div', { className: 'goal-presets' },
          presetOptions.map(function (opt) {
            return h('button', {
              key: opt, type: 'button',
              className: 'goal-chip' + (n === opt ? ' sel' : ''),
              onClick: function () { setN(opt); }
            }, opt + ' kart');
          })
        ),
        maxCards < 15
          ? h('div', { className: 'help', style: { marginTop: '6px', opacity: 0.7, fontSize: '13px' } },
              'Bu destede ' + props.deckSize + ' kart var; en fazla ' + maxCards + ' seçilebilir.')
          : null
      ),
      h('div', { className: 'modal-actions' },
        h('button', { className: 'btn ghost', onClick: props.onClose }, 'Vazgeç'),
        h('button', { className: 'btn duel', onClick: submit }, '⚔️ Başla')
      )
    );
  }

  // Düello: kartları çöz (kronometre + Bildim/Bilemedim, basit, side-effect yok)
  function ChallengeStudyView(props) {
    var cards = props.cards;
    var stH = useState(function () {
      return { idx: 0, flipped: false, correct: 0, done: false };
    });
    var s = stH[0], setS = stH[1];

    var startedAtRef = useRef(Date.now());
    var elapsedH = useState(0);
    var elapsed = elapsedH[0], setElapsed = elapsedH[1];
    useEffect(function () {
      if (s.done) return;
      var t = setInterval(function () {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 1000);
      return function () { clearInterval(t); };
    }, [s.done]);

    // Sprint 9: cevap geri bildirimi
    var fbSt = useState(null); // null | 'good' | 'bad'
    var feedback = fbSt[0], setFeedback = fbSt[1];
    var fbTimer = useRef(null);
    useEffect(function () {
      return function () { if (fbTimer.current) clearTimeout(fbTimer.current); };
    }, []);

    function answer(isCorrect) {
      // Sprint 9: ses + haptik + flash sınıfı
      if (isCorrect) {
        playSound('correct'); haptic(15);
        if (animationsAllowed()) setFeedback('good');
      } else {
        playSound('wrong'); haptic([10, 50, 10]);
        if (animationsAllowed()) setFeedback('bad');
      }
      if (fbTimer.current) clearTimeout(fbTimer.current);
      fbTimer.current = setTimeout(function () { setFeedback(null); }, 420);

      setS(function (p) {
        var nextIdx = p.idx + 1;
        var nextCorrect = p.correct + (isCorrect ? 1 : 0);
        if (nextIdx >= cards.length) {
          var total = cards.length;
          var time = Math.floor((Date.now() - startedAtRef.current) / 1000);
          setTimeout(function () {
            props.onFinish({ score: nextCorrect, total: total, time: time });
          }, 0);
          return { idx: nextIdx, flipped: false, correct: nextCorrect, done: true };
        }
        return { idx: nextIdx, flipped: false, correct: nextCorrect, done: false };
      });
    }
    function flip() {
      setS(function (p) { return Object.assign({}, p, { flipped: !p.flipped }); });
    }

    useEffect(function () {
      function onKey(e) {
        if (s.done) return;
        if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); flip(); }
        else if (s.flipped && e.key === '1') answer(true);
        else if (s.flipped && e.key === '2') answer(false);
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, [s.flipped, s.done]);

    if (s.done) {
      // Sonuç ekranı dışarıdan render edilir (onFinish ile)
      return h('div', { className: 'study challenge-mode' },
        h('div', { className: 'challenge-finishing' }, 'Skor hesaplanıyor…')
      );
    }

    var card = cards[s.idx];
    var mmss = function (sec) {
      var m = Math.floor(sec / 60), r = sec % 60;
      return (m > 0 ? m + ':' + (r < 10 ? '0' : '') + r : r + ' sn');
    };

    return h('div', { className: 'study challenge-mode' },
      h('div', { className: 'study-top' },
        h('button', {
          className: 'iconbtn',
          onClick: props.onExit, 'aria-label': 'Düellodan çık'
        }, '✕'),
        h('div', { className: 'challenge-timer' },
          IconEl('clock', 14), h('span', null, ' ' + mmss(elapsed))),
        h('div', { className: 'progress-count' }, (s.idx + 1) + ' / ' + cards.length)
      ),
      h('div', { className: 'challenge-banner-mini' }, '⚔️ Düello modu'),
      h('div', {
        className: 'flip-area' +
          (feedback === 'good' ? ' fb-good' : feedback === 'bad' ? ' fb-bad' : ''),
        onClick: flip
      },
        h('div', { className: 'flashcard' + (s.flipped ? ' flipped' : ''), role: 'button' },
          h('div', { className: 'face front' },
            h('div', { className: 'tag' }, 'SORU'),
            h('div', { className: 'face-header-chip', 'aria-hidden': 'true' },
              IconEl('swords', 14), h('span', null, 'Düello')),
            h('div', { className: 'text' }, card ? card.q : ''),
            h('div', { className: 'hint' }, 'Cevabı görmek için dokun')
          ),
          h('div', { className: 'face back' },
            h('div', { className: 'tag' }, 'CEVAP'),
            h('div', { className: 'text' }, card ? card.a : '')
          )
        )
      ),
      s.flipped
        ? h('div', { className: 'rate-row challenge-rate' },
            h('button', {
              className: 'rate bad',
              onClick: function (e) { e.stopPropagation(); answer(false); }
            }, h('span', { className: 'ic' }, IconEl('cross', 20)), h('span', null, 'Bilemedim')),
            h('button', {
              className: 'rate good',
              onClick: function (e) { e.stopPropagation(); answer(true); }
            }, h('span', { className: 'ic' }, IconEl('check', 20)), h('span', null, 'Bildim'))
          )
        : h('div', { className: 'tap-hint' }, 'Karta dokun, sonra cevapla')
    );
  }

  // B (meydan okunan) → intro: "Arda sana meydan okuyor"
  function ChallengeIntroView(props) {
    var ch = props.challenge;
    var name = (ch.ch || '').trim() || 'Bir arkadaşın';
    var deckName = (ch.dn || '').trim() || 'bir deste';
    return h('div', { className: 'challenge-intro' },
      h('div', { className: 'ci-icon' }, '⚔️'),
      h('h2', { className: 'ci-title' }, name + ' sana meydan okuyor!'),
      h('p', { className: 'ci-text' },
        '“' + deckName + '” destesinde ',
        h('strong', null, ch.sc + '/' + ch.n),
        ' yapmış. Sıra sende — ',
        h('strong', null, ch.n + ' kart'),
        ', geçebilir misin?'),
      h('div', { className: 'ci-actions' },
        h('button', { className: 'btn duel full lg', onClick: props.onStart },
          '⚔️ Kabul Et ve Başla'),
        h('div', { className: 'spacer-sm' }),
        h('button', { className: 'btn ghost full', onClick: props.onSkip },
          'Şimdi Değil')
      )
    );
  }

  // Paylaşım modalı (challenger sonucu)
  function ChallengeShareModal(props) {
    var url = props.url;
    var msg = 'Kelime düellosu! ⚔️ Ben ' + props.score + '/' + props.total +
      ' yaptım, geçebilir misin?\n👉 ' + url;
    function shareWhatsApp() {
      window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
    }
    function copy() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          props.onCopied();
        }, function () {
          props.onCopied(false);
        });
      } else {
        // fallback: gizli textarea
        try {
          var ta = document.createElement('textarea');
          ta.value = url; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          props.onCopied();
        } catch (e) { props.onCopied(false); }
      }
    }
    function nativeShare() {
      if (navigator.share) {
        navigator.share({
          title: 'Kelime Düellosu',
          text: 'Beni geçebilir misin? ⚔️',
          url: url
        }).catch(function () {});
      }
    }
    return h(Modal, { title: 'Meydan okuman hazır! 🔥', onClose: props.onClose },
      h('p', { className: 'share-lead' },
        '“' + props.deckName + '” destesinde ',
        h('strong', null, props.score + '/' + props.total),
        ' yaptın. Arkadaşların geçebilir mi?'),
      h('div', { className: 'share-actions' },
        h('button', { className: 'btn duel full btn-icon-label', onClick: shareWhatsApp },
          IconEl('whatsapp', 18), h('span', null, 'WhatsApp\'ta Paylaş')),
        h('div', { className: 'spacer-sm' }),
        h('button', { className: 'btn primary full btn-icon-label', onClick: copy },
          IconEl('link', 18), h('span', null, 'Linki Kopyala')),
        navigator.share
          ? h('div', null,
              h('div', { className: 'spacer-sm' }),
              h('button', { className: 'btn ghost full btn-icon-label', onClick: nativeShare },
                IconEl('share', 18), h('span', null, 'Paylaş (sistem)')))
          : null
      ),
      h('div', { className: 'spacer-sm' }),
      h('button', { className: 'linkbtn', onClick: props.onClose }, 'Kapat')
    );
  }

  // Düello sonuç ekranı — challenger ya da friend
  function ChallengeResultView(props) {
    // mode: 'challenger' (paylaşılacak) | 'friend' (karşılaştırma)
    var mode = props.mode;
    var mine = props.mine; // {score,total,time}
    var theirs = props.theirs; // null veya {score, total, time, name}
    var deckName = props.deckName;
    var shareOpenH = useState(false);
    var shareOpen = shareOpenH[0], setShareOpen = shareOpenH[1];
    var copiedToastRef = useRef(null);

    // Sprint 9: mount'ta sonuca özel ses + haptik
    useEffect(function () {
      if (mode === 'friend' && theirs) {
        var oc = duelOutcome(
          { score: mine.score, time: mine.time },
          { score: theirs.score, time: theirs.time }
        );
        if (oc === 'win') { playSound('win'); haptic([15, 30, 15, 30, 30]); }
        else if (oc === 'loss') { playSound('loss'); haptic([10, 80, 10]); }
        else { playSound('draw'); }
      } else if (mode === 'challenger') {
        playSound('streak');
      }
    }, []);

    function mmss(sec) {
      sec = Number(sec) || 0;
      var m = Math.floor(sec / 60), r = sec % 60;
      return (m > 0 ? m + ':' + (r < 10 ? '0' : '') + r : r + ' sn');
    }

    if (mode === 'challenger') {
      return h('div', { className: 'challenge-result' },
        h('div', { className: 'cr-icon' }, IconEl('star', 56)),
        h('h2', { className: 'cr-title' }, 'Skorun hazır'),
        h('div', { className: 'cr-score' }, mine.score + ' / ' + mine.total),
        h('div', { className: 'cr-sub' },
          IconEl('clock', 14), h('span', null, ' ' + mmss(mine.time))),
        h('div', { className: 'spacer-sm' }),
        h('button', {
          className: 'btn duel full lg',
          onClick: function () { setShareOpen(true); }
        }, '⚔️  Arkadaşına Meydan Oku'),
        h('div', { className: 'spacer-sm' }),
        h('button', { className: 'btn ghost full', onClick: props.onExit }, 'Ana Ekran'),
        shareOpen
          ? h(ChallengeShareModal, {
              url: props.shareUrl,
              score: mine.score, total: mine.total,
              deckName: deckName,
              onClose: function () { setShareOpen(false); },
              onCopied: function (ok) {
                setShareOpen(false);
                if (props.onToast) props.onToast(ok === false ? 'Kopyalanamadı' : 'Link kopyalandı! 🔗');
              }
            })
          : null
      );
    }

    // friend mode
    var outcome = duelOutcome(
      { score: mine.score, time: mine.time },
      { score: theirs.score, time: theirs.time }
    );
    var titleTxt = outcome === 'win' ? 'KAZANDIN!' :
                   outcome === 'loss' ? 'Bu sefer kaybettin' : 'BERABERE';
    var iconName = outcome === 'win' ? 'trophy' : outcome === 'loss' ? 'flex' : 'handshake';
    var cls = 'challenge-result cr-' + outcome;

    return h('div', { className: cls },
      // Sprint 9: zafer ekranında konfeti
      outcome === 'win' ? h(Confetti, { onDone: function () {} }) : null,
      h('div', { className: 'cr-icon big' }, IconEl(iconName, 64)),
      h('h2', { className: 'cr-title' }, titleTxt),
      h('div', { className: 'cr-vs' },
        h('div', { className: 'cr-vs-row mine' },
          h('span', { className: 'cr-vs-name' }, 'Sen'),
          h('span', { className: 'cr-vs-score' }, mine.score + ' / ' + mine.total),
          h('span', { className: 'cr-vs-time' },
            IconEl('clock', 12), h('span', null, ' ' + mmss(mine.time)))
        ),
        h('div', { className: 'cr-vs-row theirs' },
          h('span', { className: 'cr-vs-name' }, theirs.name || 'Rakip'),
          h('span', { className: 'cr-vs-score' }, theirs.score + ' / ' + theirs.total),
          h('span', { className: 'cr-vs-time' },
            IconEl('clock', 12), h('span', null, ' ' + mmss(theirs.time)))
        )
      ),
      h('div', { className: 'spacer-sm' }),
      props.hasDeck
        ? h('button', { className: 'btn duel full lg', onClick: props.onRevanche },
            '⚔️  Rövanş İste')
        : h('div', { className: 'cr-no-deck' },
            h('div', { className: 'cr-no-deck-text' },
              'Rövanş için “' + deckName + '” destesi sende yok.'),
            h('button', { className: 'btn primary full', onClick: props.onDiscover },
              'Keşfet’te ara')
          ),
      h('div', { className: 'spacer-sm' }),
      h('button', { className: 'btn ghost full', onClick: props.onExit }, 'Ana Ekran')
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
      var d = deckById[id];
      return {
        name: d ? d.name : '(silinmiş deste)',
        sessions: p.sessions, seen: p.seen, correct: p.correct,
        pct: pct(p.correct, p.seen),
        learned: d ? deckLearnedPercent(d) : 0
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

    // Çubuk grafik mount animasyonu: ilk render'da 0, hemen ardından
    // gerçek değere geçince CSS height transition ile yükselir.
    var mSt = useState(false);
    var mounted = mSt[0], setMounted = mSt[1];
    useEffect(function () {
      var id = requestAnimationFrame(function () { setMounted(true); });
      return function () { cancelAnimationFrame(id); };
    }, []);

    var overall = pct(stats.totalCorrect, stats.totalSeen);

    // Sprint 7: streak + 30 günlük heatmap + haftalık özet
    var retention = props.retention || defaultRetention();
    var studyDateSet = {};
    (retention.streak.studyDates || []).forEach(function (s) { studyDateSet[s] = true; });
    // Son 30 gün (en eski → en yeni)
    var heatDays = [];
    var todayBase = new Date();
    todayBase.setHours(0, 0, 0, 0);
    for (var i = 29; i >= 0; i--) {
      var d = new Date(todayBase.getTime() - i * 86400000);
      var y = d.getFullYear();
      var m = d.getMonth() + 1;
      var dd = d.getDate();
      var s = y + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
      heatDays.push({ key: s, on: !!studyDateSet[s] });
    }
    // Haftalık özet (son 7 gün)
    var weekDays = 0;
    heatDays.slice(-7).forEach(function (d) { if (d.on) weekDays++; });

    return h('div', null,
      // Gradient kahraman kart: büyük genel başarı + satır içi 3'lü özet
      h('div', { className: 'stats-hero-card' },
        h('div', { className: 'shc-main' },
          h('div', { className: 'shc-pct' }, overall + '%'),
          h('div', { className: 'shc-cap' }, 'Genel başarı oranı')
        ),
        h('div', { className: 'shc-summary' },
          h('div', { className: 'shc-stat' },
            h('div', { className: 'v' }, stats.totalSessions),
            h('div', { className: 'k' }, 'Seans')),
          h('div', { className: 'shc-stat' },
            h('div', { className: 'v' }, stats.totalSeen),
            h('div', { className: 'k' }, 'Görülen')),
          h('div', { className: 'shc-stat' },
            h('div', { className: 'v' }, stats.totalCorrect),
            h('div', { className: 'k' }, 'Doğru'))
        )
      ),
      // Sprint 7: Streak + 30 günlük heatmap + haftalık özet
      h('div', { className: 'retention-stats-card' },
        h('div', { className: 'rs-row' },
          h('div', { className: 'rs-cell' },
            h('div', { className: 'rs-num' }, retention.streak.current),
            h('div', { className: 'rs-lbl' }, 'gün seri 🔥')
          ),
          h('div', { className: 'rs-cell' },
            h('div', { className: 'rs-num' }, retention.streak.longest),
            h('div', { className: 'rs-lbl' }, 'en uzun seri')
          ),
          h('div', { className: 'rs-cell' },
            h('div', { className: 'rs-num' }, weekDays),
            h('div', { className: 'rs-lbl' }, 'bu hafta gün')
          )
        ),
        h('div', { className: 'stats-card-head', style: { marginTop: '8px' } }, 'Son 30 gün'),
        h('div', { className: 'heatmap' },
          heatDays.map(function (d) {
            return h('div', {
              key: d.key,
              className: 'heatmap-cell' + (d.on ? ' on' : ''),
              title: d.key + (d.on ? ' — çalışıldı' : '')
            });
          })
        )
      ),
      perRows.length === 0
        ? h('div', { className: 'empty' },
            h('p', null, 'Henüz çalışma kaydı yok. Bir deste çalıştığınızda istatistikler burada görünecek.'))
        : h('div', { className: 'stats-split' },
            // Sol: animasyonlu çubuk grafik (deste başarı %)
            h('div', { className: 'stats-bars-card' },
              h('div', { className: 'stats-card-head' }, 'Deste başarısı'),
              h('div', { className: 'stats-bars' },
                perRows.map(function (r, i) {
                  return h('div', { className: 'bar-col', key: i },
                    h('div', { className: 'bar-track' },
                      h('div', {
                        className: 'bar-fill',
                        style: { height: (mounted ? Math.max(r.pct, 3) : 0) + '%' }
                      },
                        h('span', { className: 'bar-val' }, r.pct + '%')
                      )
                    ),
                    h('div', { className: 'bar-lbl', title: r.name }, r.name)
                  );
                })
              )
            ),
            // Sağ: deste listesi (seans/görülen/%)
            h('div', { className: 'stats-list-card' },
              h('div', { className: 'stats-card-head' }, 'Deste kırılımı'),
              perRows.map(function (r, i) {
                return h('div', { className: 'sl-row', key: i },
                  h('div', { className: 'sl-name' }, r.name),
                  h('div', { className: 'sl-meta' },
                    h('span', { className: 'sl-sub' },
                      r.sessions + ' sns · ' + r.seen + ' görü · ' +
                      'öğr %' + r.learned),
                    h('span', { className: 'sl-pct' }, r.pct + '%')
                  )
                );
              })
            )
          ),
      // Sprint 8: Düello istatistikleri
      (props.duels && props.duels.stats && props.duels.stats.totalPlayed > 0)
        ? (function () {
            var d = props.duels.stats;
            var winPct = d.totalPlayed > 0 ? Math.round((d.wins / d.totalPlayed) * 100) : 0;
            return h('div', { className: 'duel-stats-card', style: { marginTop: '16px' } },
              h('div', { className: 'stats-card-head' }, '⚔️ Düello İstatistikleri'),
              h('div', { className: 'rs-row' },
                h('div', { className: 'rs-cell' },
                  h('div', { className: 'rs-num' }, d.totalPlayed),
                  h('div', { className: 'rs-lbl' }, 'toplam düello')
                ),
                h('div', { className: 'rs-cell' },
                  h('div', { className: 'rs-num' }, winPct + '%'),
                  h('div', { className: 'rs-lbl' }, 'galibiyet oranı')
                ),
                h('div', { className: 'rs-cell' },
                  h('div', { className: 'rs-num' }, d.wins + '/' + d.losses + '/' + d.draws),
                  h('div', { className: 'rs-lbl' }, 'G / M / B')
                )
              )
            );
          })()
        : null,
      ctxActivity.length > 0
        ? h('div', { className: 'stats-list-card', style: { marginTop: '16px' } },
            h('div', { className: 'stats-card-head' }, 'Bağlam Aktivitesi (son 7 gün)'),
            ctxActivity.map(function (a) {
              var w = maxAct > 0 ? Math.round((a.count / maxAct) * 100) : 0;
              return h('div', { className: 'actrow', key: a.id },
                h('div', { className: 'actrow-top' },
                  h('span', { className: 'actrow-name' }, a.emoji + ' ' + a.name),
                  h('span', { className: 'actrow-n mono' }, a.count + ' seans')
                ),
                h('div', { className: 'actbar' },
                  h('div', { className: 'actbar-fill', style: { width: (mounted ? Math.max(w, 4) : 0) + '%' } })
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

  // Sprint 7: Hatırlatma + günlük hedef ayar paneli (DataView içinde)
  function ReminderSection(props) {
    var r = props.retention.reminder;
    var supported = notificationSupported();
    var disabled = !supported || props.notifPerm === 'denied';

    return h('div', { className: 'panel reminder-section' },
      h('h3', null, 'Hatırlatmalar'),
      h('p', null, 'Her gün belirlediğin saatte “çalışma zamanı” bildirimi al.'),
      h('label', { className: 'cm-ctx-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', null, 'Günlük çalışma hatırlatması'),
        h('button', {
          className: 'toggle-sw' + (r.enabled ? ' on' : ''),
          role: 'switch', 'aria-checked': r.enabled ? 'true' : 'false',
          'aria-label': 'Günlük hatırlatma',
          disabled: disabled,
          onClick: function () { props.onToggleReminder(!r.enabled); }
        }, h('span', { className: 'toggle-knob' }))
      ),
      r.enabled
        ? h('div', { className: 'field', style: { marginTop: '12px' } },
            h('label', null, 'Saat'),
            h('input', {
              type: 'time', value: r.time,
              onChange: function (e) { props.onSetReminderTime(e.target.value); }
            })
          )
        : null,
      !supported
        ? h('div', { className: 'hint-line' }, 'Tarayıcın bildirim desteklemiyor.')
        : props.notifPerm === 'denied'
          ? h('div', { className: 'hint-line' }, 'Bildirim izni reddedildi — tarayıcı/site ayarlarından açılabilir.')
          : h('div', { className: 'hint-line' }, 'Bildirimler uygulama açıkken veya açtığında çalışır.'),
      h('div', { className: 'field', style: { marginTop: '16px' } },
        h('label', null, 'Günlük hedef'),
        h('div', { className: 'goal-inline' },
          h('span', { className: 'mono goal-inline-val' },
            props.retention.dailyGoal.target + ' kart / gün'),
          h('button', {
            className: 'btn ghost', type: 'button',
            onClick: props.onOpenGoal
          }, 'Değiştir')
        )
      )
    );
  }

  function DataView(props) {
    var fileRef = useRef(null);
    // Sprint 11: Gelişmiş (yedekleme) bölümü varsayılan kapalı
    var advH = useState(false);
    var advOpen = advH[0], setAdvOpen = advH[1];

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
      // Bildirimler (yukarı taşındı: en sık kullanılanlar üstte)
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
      // Sprint 7: Hatırlatma + günlük hedef
      h(ReminderSection, {
        retention: props.retention,
        notifPerm: props.notifPerm,
        onToggleReminder: props.onToggleReminder,
        onSetReminderTime: props.onSetReminderTime,
        onOpenGoal: props.onOpenGoal
      }),
      // Sprint 11: MarketplaceSettings (GitHub URL) normal UI'dan gizlendi —
      // varsayılan repo URL'i kod içinde sabit. Geliştirici gerektiğinde
      // marketplaceBaseUrl() içinden değiştirebilir.
      // Sprint 9: Ses ve His ayarları
      h('div', { className: 'panel' },
        h('h3', null, 'Ses ve His'),
        h('label', { className: 'cm-ctx-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('span', null, 'Ses efektleri'),
          h('button', {
            className: 'toggle-sw' + (props.soundOn ? ' on' : ''),
            role: 'switch', 'aria-checked': props.soundOn ? 'true' : 'false',
            'aria-label': 'Ses efektleri',
            onClick: props.onToggleSound
          }, h('span', { className: 'toggle-knob' }))
        ),
        props.hapticSupported
          ? h('label', { className: 'cm-ctx-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' } },
              h('span', null, 'Titreşim'),
              h('button', {
                className: 'toggle-sw' + (props.hapticOn ? ' on' : ''),
                role: 'switch', 'aria-checked': props.hapticOn ? 'true' : 'false',
                'aria-label': 'Titreşim',
                onClick: props.onToggleHaptic
              }, h('span', { className: 'toggle-knob' }))
            )
          : h('div', { className: 'hint-line', style: { marginTop: '10px' } },
              'Titreşim bu cihazda desteklenmiyor.'),
        h('label', { className: 'cm-ctx-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' } },
          h('span', null, 'Animasyonlar'),
          h('button', {
            className: 'toggle-sw' + (props.animOn ? ' on' : ''),
            role: 'switch', 'aria-checked': props.animOn ? 'true' : 'false',
            'aria-label': 'Animasyonlar',
            onClick: props.onToggleAnim
          }, h('span', { className: 'toggle-knob' }))
        ),
        h('div', { className: 'hint-line', style: { marginTop: '10px' } },
          'Cihazın “hareketi azalt” ayarı açıksa animasyonlar otomatik kısıtlanır.')
      ),
      // Gizlilik
      h('div', { className: 'panel' },
        h('h3', null, 'Gizlilik'),
        h('p', null, '• Konum verilerin cihazından dışarı çıkmaz.'),
        h('p', null, '• Hiçbir veri sunucuya gönderilmez.'),
        h('p', null, '• Verilerini istediğin zaman dışa aktarabilir veya silebilirsin.')
      ),
      // Sprint 11: Gelişmiş — Yedekleme (katlanabilir, varsayılan kapalı)
      h('div', { className: 'panel advanced-panel' },
        h('button', {
          className: 'advanced-toggle' + (advOpen ? ' open' : ''),
          type: 'button',
          'aria-expanded': advOpen ? 'true' : 'false',
          onClick: function () { setAdvOpen(!advOpen); }
        },
          h('span', null, 'Gelişmiş — Yedekleme'),
          h('span', { className: 'advanced-caret', 'aria-hidden': 'true' }, '▾')
        ),
        advOpen
          ? h('div', { className: 'advanced-body' },
              h('div', { className: 'sub-panel' },
                h('h4', null, 'Yedeği dışa aktar'),
                h('p', null, 'Tüm desteler, kartlar, istatistikler ve bağlamlar tek bir JSON dosyasına indirilir. Telefon/cihaz değişiminde bu dosyayı içe aktarabilirsin.'),
                h('div', { className: 'mono', style: { fontSize: '12px', color: 'var(--ink-faint)', marginBottom: '12px' } },
                  props.state.decks.length + ' deste · ' + totalCards + ' kart · ' + props.ctxState.contexts.length + ' bağlam'),
                h('button', { className: 'btn primary btn-icon-label', onClick: doExport },
                  IconEl('data', 16), h('span', null, 'JSON dışa aktar'))
              ),
              h('div', { className: 'sub-panel' },
                h('h4', null, 'Yedeği içe aktar'),
                h('p', null, 'Daha önce aldığın bir JSON yedeği yükle. Mevcut verinin yerine geçsin mi yoksa birleştirilsin mi seçeceksin.'),
                h('input', { type: 'file', accept: 'application/json,.json', ref: fileRef, className: 'hidden-file', onChange: onFile }),
                h('button', {
                  className: 'btn ghost btn-icon-label',
                  onClick: function () { fileRef.current && fileRef.current.click(); }
                }, IconEl('data', 16), h('span', null, 'JSON dosyası seç'))
              )
            )
          : null
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
        renderContextIcon(ctx, 14),
        h('span', null,
          ' “' + ctx.name + '” zamanını kaçırdın — ' +
          item.dueCardCount + ' kart hâlâ bekliyor')
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
      // Sprint 11: konum izni link'i banner pill'inin içinde, ayrı pembe
      // şerit olarak değil. Tüm hint tek bir kart hissi verir.
      var showGeoAsk = needsLocation && geoStatus !== 'denied' && geoStatus !== 'unsupported';
      return h('div', { className: 'banner-hint-wrap' },
        h('div', { className: 'aurora-bg', 'aria-hidden': 'true' }),
        h('div', { className: 'banner-hint' },
          h('div', { className: 'banner-hint-main' },
            h('span', { className: 'banner-hint-pin' }, IconEl('pin', 14)),
            h('span', null, ' Şu an aktif bağlam yok'),
            showGeoAsk
              ? h('button', {
                  className: 'banner-geo-inline',
                  onClick: props.onAskLocation
                }, 'Konum izni ver')
              : null
          ),
          refreshBtn
        ),
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
        h('span', { className: 'banner-emoji' }, renderContextIcon(ctx, 22)),
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
          }, IconEl('play', 18), h('span', null, ' Bu bağlamla çalış'))
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
      var initialIcon = (c && typeof c.icon === 'string' && ICONS[c.icon])
        ? c.icon
        : migrateContextIcon(c.emoji || '📍');
      return {
        name: c.name || '',
        emoji: c.emoji || '📍',
        icon: initialIcon,
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
        icon: f.icon,
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
      // Sprint 10: İkon (eski emoji grid yerine SVG katalog)
      h('div', { className: 'field' },
        h('label', null, 'İkon'),
        h('div', { className: 'ctx-icon-lg' }, IconEl(f.icon, 40)),
        h('div', { className: 'icon-grid' },
          CONTEXT_ICONS.map(function (ic) {
            return h('button', {
              key: ic.id, type: 'button',
              className: 'icon-cell' + (f.icon === ic.id ? ' sel' : ''),
              title: ic.label, 'aria-label': ic.label,
              onClick: function () { set({ icon: ic.id }); }
            }, IconEl(ic.id, 24));
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

  // ---------- Sprint 7: Retention bileşenleri ----------

  function RetentionHeader(props) {
    var streak = props.retention.streak.current;
    var target = props.retention.dailyGoal.target;
    var today = getTodayString();
    var todayCount = (props.retention.dailyGoal.todayDate === today)
      ? props.retention.dailyGoal.todayCount : 0;
    var pctVal = target > 0 ? Math.min(100, Math.round(todayCount / target * 100)) : 0;
    var done = todayCount >= target;

    return h('div', { className: 'retention-header' },
      h('div', {
        className: 'streak-box' + (streak === 0 ? ' zero' : ''),
        role: 'group', 'aria-label': 'Çalışma serisi'
      },
        h('div', { className: 'streak-emoji' }, '🔥'),
        h('div', { className: 'streak-text' },
          streak === 0
            ? h('div', { className: 'streak-zero-msg' }, 'Bugün başla!')
            : h('div', null,
                h('div', { className: 'streak-num' }, streak),
                h('div', { className: 'streak-lbl' }, 'gün seri')
              )
        )
      ),
      h('button', {
        className: 'goal-box' + (done ? ' done' : ''),
        type: 'button', onClick: props.onOpenGoal,
        'aria-label': 'Günlük hedef ayarı'
      },
        h('div', { className: 'goal-top' },
          h('span', { className: 'goal-emoji' }, '🎯'),
          done
            ? h('span', { className: 'goal-done-text' }, '✓ Hedef tamam! 🎉')
            : h('span', { className: 'goal-frac' },
                h('strong', null, todayCount), '/', target)
        ),
        h('div', { className: 'goal-cap' },
          done ? 'Bugünkü hedef tamamlandı' : 'bugünkü hedef'),
        h('div', { className: 'goal-bar' },
          h('div', { className: 'goal-bar-fill', style: { width: pctVal + '%' } })
        )
      )
    );
  }

  function DailyGoalModal(props) {
    var initT = props.initial || 20;
    var presets = [10, 20, 30, 50];
    var matched = presets.indexOf(initT) >= 0;
    var modeH = useState(matched ? 'preset' : 'custom');
    var mode = modeH[0], setMode = modeH[1];
    var pH = useState(matched ? initT : 20);
    var p = pH[0], setP = pH[1];
    var cH = useState(matched ? '' : String(initT));
    var customStr = cH[0], setCustomStr = cH[1];

    function save() {
      var n;
      if (mode === 'preset') n = p;
      else {
        n = parseInt(customStr, 10);
        if (isNaN(n)) n = 20;
      }
      if (n < 5) n = 5;
      if (n > 500) n = 500;
      props.onSave(n);
    }

    return h(Modal, { title: 'Günlük hedef', onClose: props.onClose },
      h('p', { className: 'confirm-text' },
        'Her gün kaç kart çalışmak istersin? Hedefe ulaşınca 🎉'),
      h('div', { className: 'goal-presets' },
        presets.map(function (n) {
          return h('button', {
            key: n, type: 'button',
            className: 'goal-chip' + (mode === 'preset' && p === n ? ' sel' : ''),
            onClick: function () { setMode('preset'); setP(n); }
          }, n);
        }),
        h('button', {
          type: 'button',
          className: 'goal-chip' + (mode === 'custom' ? ' sel' : ''),
          onClick: function () { setMode('custom'); }
        }, 'Özel')
      ),
      mode === 'custom'
        ? h('div', { className: 'field', style: { marginTop: '12px' } },
            h('label', null, 'Özel hedef (5 – 500)'),
            h('input', {
              type: 'number', min: 5, max: 500, value: customStr,
              onChange: function (e) { setCustomStr(e.target.value); }
            })
          )
        : null,
      h('div', { className: 'modal-actions' },
        h('button', { className: 'btn ghost', onClick: props.onClose }, 'Vazgeç'),
        h('button', { className: 'btn primary', onClick: save }, 'Kaydet')
      )
    );
  }

  function StreakCelebrate(props) {
    useEffect(function () {
      // Sprint 9: tatlı "ta-da" + titreşim
      playSound('streak');
      haptic([15, 30, 15, 30, 30]);
      var t = setTimeout(props.onDone, 1800);
      return function () { clearTimeout(t); };
    }, []);
    return h('div', { className: 'streak-celebrate', role: 'status' },
      // Sprint 9: konfeti (animasyon kapalıysa otomatik gizlenir)
      h(Confetti, { onDone: function () {} }),
      h('div', { className: 'sc-emoji' }, '🔥'),
      h('div', { className: 'sc-text' },
        props.streak + ' günlük seri! Harikasın!')
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

    // Sprint 9: Ses / Haptik / Animasyon tercihleri (varsayılan AÇIK)
    var soundHook = useState(isSoundOn);
    var soundOn = soundHook[0], setSoundOn = soundHook[1];
    var hapticHook = useState(isHapticOn);
    var hapticOn = hapticHook[0], setHapticOn = hapticHook[1];
    var animHook = useState(isAnimOn);
    var animOn = animHook[0], setAnimOn = animHook[1];

    // catch-up: bu oturumda gizlenenler (sayfa yenilenince sıfır)
    var dismissedCatchupRef = useRef({});
    // bildirim zamanlama timer'ı
    var notifTimerRef = useRef(null);

    // Sprint 7: retention (streak/günlük hedef/hatırlatma) + kutlama toast
    var retentionHook = useState(loadRetentionState);
    var retention = retentionHook[0], setRetention = retentionHook[1];
    var celebrateHook = useState(null); // {streak, id} | null
    var celebrate = celebrateHook[0], setCelebrate = celebrateHook[1];
    var reminderTimerRef = useRef(null);
    var goalModalHook = useState(false);
    var goalModalOpen = goalModalHook[0], setGoalModalOpen = goalModalHook[1];

    // Sprint 8: düello (challenge) durumu — gönderilen/alınan + özet
    var duelsHook = useState(loadDuelsState);
    var duels = duelsHook[0], setDuels = duelsHook[1];

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
    // Sprint 8: düello sonuçları
    useEffect(function () { persistDuels(duels); }, [duels]);
    // Sprint 9: AudioContext'i ilk kullanıcı dokunuşuna kadar kilitle (autoplay)
    useEffect(function () { unlockAudioOnFirstGesture(); }, []);

    // Sprint 10: route'a göre <body> sınıfı (CSS blob arka planı için ipucu)
    useEffect(function () {
      var b = document.body;
      if (!b) return;
      var isStudyish = (route.name === 'study' ||
                       route.name === 'challengePlay' ||
                       route.name === 'challengeIntro' ||
                       route.name === 'challengeResult');
      b.classList.toggle('is-study', isStudyish);
    }, [route.name]);

    // Sprint 10: Animasyon tercihi değişince <body class="anim-off"> bayrağı
    useEffect(function () {
      var b = document.body;
      if (!b) return;
      b.classList.toggle('anim-off', !animationsAllowed());
    }, [animOn]);

    // Boot'ta bir kere: kırık (orphan) kart-bağlam linklerini sessizce temizle
    useEffect(function () { cleanupOrphanLinks(); }, []);

    // Sprint 7: Boot'ta streak kırılma kontrolü + hatırlatma planı
    useEffect(function () {
      var st = checkStreakBroken();
      setRetention(st);
      scheduleDailyReminder();
      return function () {
        if (reminderTimerRef.current) {
          clearTimeout(reminderTimerRef.current);
          reminderTimerRef.current = null;
        }
      };
    }, []);

    // Sprint 7: Sekme tekrar görünür olunca catch-up planlamayı yeniden çalıştır
    useEffect(function () {
      function onVis() {
        if (!document.hidden) {
          var st = checkStreakBroken();
          setRetention(st);
          scheduleDailyReminder();
        }
      }
      document.addEventListener('visibilitychange', onVis);
      return function () { document.removeEventListener('visibilitychange', onVis); };
    }, []);

    // Sprint 6: Keşfet'e ilk girişte manifest yükle (bir kez)
    useEffect(function () {
      if (route.name === 'discover' && !mpLoadedRef.current) {
        mpLoadedRef.current = true;
        loadMP(false);
      }
    }, [route.name]);

    // Sprint 4/7: deep-link (?action=study[&contextId=...]) — boot'ta bir kere
    useEffect(function () {
      try {
        var sp = new URLSearchParams(window.location.search);
        if (sp.get('action') === 'study') {
          var cid = sp.get('contextId');
          window.history.replaceState({}, '', window.location.pathname);
          if (cid) {
            var ctx = ctxState.contexts.filter(function (c) { return c.id === cid; })[0];
            if (ctx) startContextStudy(ctx);
          } else {
            // Sprint 7: günlük hatırlatma → ilk dolu desteyle çalış
            var firstDeck = state.decks.filter(function (d) {
              return d.cards.length > 0;
            })[0];
            if (firstDeck) {
              setRoute({ name: 'study', deckId: firstDeck.id, sessionKey: uid() });
            }
          }
        }
      } catch (e) {}
    }, []);

    // Sprint 8: #challenge=... hash'ı varsa challenge intro'ya götür (boot)
    useEffect(function () {
      try {
        var hash = window.location.hash || '';
        if (hash.indexOf('#challenge=') !== 0) return;
        var encoded = hash.substring('#challenge='.length);
        var ch;
        try { ch = decodeChallenge(encoded); }
        catch (parseErr) {
          showToast('Geçersiz meydan okuma linki.');
          window.history.replaceState(null, '', window.location.pathname);
          return;
        }
        // Hash'ı temizle ki yenileme tekrar tetiklemesin
        window.history.replaceState(null, '', window.location.pathname);

        if (!ch || ch.v !== CHALLENGE_VERSION) {
          showToast('Bu link daha yeni bir sürümle oluşturulmuş.');
          return;
        }
        if (!Array.isArray(ch.cards) || ch.cards.length === 0) {
          showToast('Bu meydan okuma boş görünüyor.');
          return;
        }
        setRoute({ name: 'challengeIntro', challenge: ch });
      } catch (e) {}
    }, []);

    // Sprint 4: SW'den notification-click mesajı
    useEffect(function () {
      if (!navigator.serviceWorker) return;
      function onMsg(e) {
        if (e.data && e.data.type === 'notification-click' && e.data.data) {
          var d = e.data.data;
          if (d.contextId) {
            var ctx = ctxState.contexts.filter(function (c) { return c.id === d.contextId; })[0];
            if (ctx) startContextStudy(ctx);
          } else if (d.action === 'study') {
            // Sprint 7: günlük hatırlatma — ilk dolu desteyle çalış
            var firstDeck = state.decks.filter(function (dk) {
              return dk.cards.length > 0;
            })[0];
            if (firstDeck) {
              setRoute({ name: 'study', deckId: firstDeck.id, sessionKey: uid() });
            }
          }
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
      // Sprint 12: gerçek mekanik ışık anahtarı "tık-tak"
      playSound('switch');
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
      applyRetentionAfterSession(seen);
    }

    // Sprint 7: Seans sonu — streak/günlük hedef güncelle, kutlama tetikle
    function applyRetentionAfterSession(cardsStudied) {
      if (!cardsStudied || cardsStudied < 1) return;
      var res = recordStudySession(cardsStudied);
      setRetention(res.state);
      if (res.didIncrement && res.newStreak >= 2) {
        setCelebrate({ streak: res.newStreak, id: uid() });
      } else if (res.newStreak === 1 && res.didIncrement) {
        // ilk gün — sade toast
        showToast('🔥 Seri başladı! İyi başlangıç.');
      }
    }

    // Sprint 7: Karta SR alanlarını yaz (SM-2 hafif uyarlama)
    function applyCardReview(cardId, rating) {
      // Bağlam modunda id 'deckId::cardId' bileşik
      var deckId, realId;
      var idx = cardId.indexOf('::');
      if (idx > 0) {
        deckId = cardId.substring(0, idx);
        realId = cardId.substring(idx + 2);
      } else {
        // Deste modu — cardId saf; deckId'yi route'tan bul
        realId = cardId;
        deckId = null;
      }
      update(function (n) {
        for (var di = 0; di < n.decks.length; di++) {
          var d = n.decks[di];
          if (deckId && d.id !== deckId) continue;
          for (var ci = 0; ci < d.cards.length; ci++) {
            var c = d.cards[ci];
            if (c.id !== realId) continue;
            var rep = Number(c.repetitions) || 0;
            var ivl = Number(c.intervalDays) || 0;
            var ease = Number(c.easeFactor) || 2.5;
            if (rating === 'good') {
              rep += 1;
              if (rep === 1) ivl = 1;
              else if (rep === 2) ivl = 3;
              else ivl = Math.max(1, Math.round(ivl * ease));
              ease = Math.min(2.8, ease + 0.1);
            } else if (rating === 'maybe') {
              ivl = Math.max(1, ivl);
            } else { // bad
              rep = 0;
              ivl = 0;
              ease = Math.max(1.3, ease - 0.2);
            }
            c.repetitions = rep;
            c.intervalDays = ivl;
            c.easeFactor = Math.round(ease * 100) / 100;
            c.lastReviewedAt = Date.now();
            return;
          }
          if (deckId) return;
        }
      });
    }

    function resetStats() {
      update(function (n) {
        n.stats = { totalSessions: 0, totalSeen: 0, totalCorrect: 0, perDeck: {} };
      });
      setModal(null);
      showToast('İstatistikler sıfırlandı');
    }

    /* ===== Sprint 8: Düello (challenge) iş mantığı ===== */

    // Deste detayından "⚔️ Meydan Oku" → ad/kart sayısı sor
    function openChallengeSetup(deckId) {
      var d = findDeck(deckId);
      if (!d || d.cards.length < 2) return;
      setModal({ type: 'challengeSetup', deckId: deckId });
    }

    // Meydan okuyan kartları çözmeye başlasın
    function startChallengeAsChallenger(deckId, opts) {
      var d = findDeck(deckId);
      if (!d || d.cards.length === 0) return;
      var max = Math.min(opts.cardCount || 10, CHALLENGE_MAX_CARDS, d.cards.length);
      var picked = shuffle(d.cards).slice(0, max);
      // Düello için kompakt kartlar (sadece q/a)
      var compact = picked.map(function (c) { return { q: c.q || '', a: c.a || '' }; });
      setModal(null);
      setRoute({
        name: 'challengePlay',
        mode: 'challenger',
        challengerName: (opts.name || '').trim(),
        deckId: deckId,
        deckName: d.name,
        cards: compact,
        sessionKey: uid()
      });
    }

    // Çözme bitti — sonuç ekranına geç ve düello geçmişine yaz
    function finishChallenge(result) {
      // result: { score, total, time }
      var r = route;
      if (!r) return;
      if (r.mode === 'challenger') {
        // payload + URL hazırla; URL çok uzunsa uyarı
        var payload = {
          v: CHALLENGE_VERSION,
          ch: (r.challengerName || '').slice(0, 30),
          dn: (r.deckName || '').slice(0, 60),
          sc: result.score,
          tt: result.time,
          n: result.total,
          cards: r.cards
        };
        var url = buildChallengeUrl(payload);
        var tooLong = url.length > CHALLENGE_URL_SAFE_LIMIT;

        // Düello geçmişine ekle (sent)
        setDuels(function (prev) {
          var next = {
            sent: prev.sent.concat([{
              deckName: r.deckName,
              score: result.score,
              total: result.total,
              timeSec: result.time,
              date: todayStamp()
            }]),
            received: prev.received,
            stats: prev.stats
          };
          return next;
        });

        setRoute({
          name: 'challengeResult',
          mode: 'challenger',
          mine: result,
          deckName: r.deckName,
          shareUrl: url,
          tooLong: tooLong
        });
        if (tooLong) showToast('Kartlar çok uzun, daha az kart seçmek gerekebilir.');
      } else {
        // friend — rakibin skoruyla karşılaştır
        var theirs = {
          name: (r.challengerName || '').trim() || 'Bir arkadaşın',
          score: r.theirScore,
          total: r.theirTotal,
          time: r.theirTime
        };
        var outcome = duelOutcome(
          { score: result.score, time: result.time },
          { score: theirs.score, time: theirs.time }
        );

        // İstatistiklere ve received geçmişine yaz
        setDuels(function (prev) {
          var s = prev.stats;
          var next = {
            sent: prev.sent,
            received: prev.received.concat([{
              challengerName: theirs.name,
              deckName: r.deckName || '',
              myScore: result.score, theirScore: theirs.score,
              myTime: result.time, theirTime: theirs.time,
              won: outcome,
              date: todayStamp()
            }]),
            stats: {
              totalPlayed: s.totalPlayed + 1,
              wins: s.wins + (outcome === 'win' ? 1 : 0),
              losses: s.losses + (outcome === 'loss' ? 1 : 0),
              draws: s.draws + (outcome === 'draw' ? 1 : 0)
            }
          };
          return next;
        });

        // B'nin o deste cihazında var mı? (rövanş için isim eşleşmesi)
        var ownsDeck = false;
        var ownDeckId = null;
        if (r.deckName) {
          for (var i = 0; i < state.decks.length; i++) {
            if (state.decks[i].name === r.deckName && state.decks[i].cards.length >= 2) {
              ownsDeck = true;
              ownDeckId = state.decks[i].id;
              break;
            }
          }
        }
        setRoute({
          name: 'challengeResult',
          mode: 'friend',
          mine: result,
          theirs: theirs,
          deckName: r.deckName || '',
          hasDeck: ownsDeck,
          ownDeckId: ownDeckId
        });
      }
    }

    // B (intro'da Kabul Et) → çözmeye başla
    function acceptChallenge(challenge) {
      setRoute({
        name: 'challengePlay',
        mode: 'friend',
        challengerName: challenge.ch || '',
        deckName: challenge.dn || '',
        cards: challenge.cards.map(function (c) {
          return { q: (c.f || c.q || ''), a: (c.b || c.a || '') };
        }),
        theirScore: Number(challenge.sc) || 0,
        theirTotal: Number(challenge.n) || (challenge.cards ? challenge.cards.length : 0),
        theirTime: Number(challenge.tt) || 0,
        sessionKey: uid()
      });
    }

    // Bağlam seansı: global istatistiğe yaz, perDeck'e DOKUNMA
    // (kartlar karışık destelerden — tek deste'ye atfetmek yanlış olur)
    function finishContextSession(_ignoredDeckId, seen, correct) {
      update(function (n) {
        n.stats.totalSessions += 1;
        n.stats.totalSeen += seen;
        n.stats.totalCorrect += correct;
      });
      applyRetentionAfterSession(seen);
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
        ctxStudy: { ctxId: ctx.id, name: ctx.name, emoji: ctx.emoji, icon: contextIconName(ctx), cards: cards }
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
        if (r === 'granted') {
          scheduleNextContextNotification();
          scheduleDailyReminder();
        }
      });
    }

    // Sprint 7: günlük hatırlatmayı planla (uygulama açıkken setTimeout;
    // saat geçmişse ve bugün atılmamışsa son 2 saatlik catch-up bildirimi).
    function scheduleDailyReminder() {
      if (reminderTimerRef.current) {
        clearTimeout(reminderTimerRef.current);
        reminderTimerRef.current = null;
      }
      var st = loadRetentionState();
      if (!st.reminder.enabled) return;
      if (notificationPermState() !== 'granted') return;
      var today = getTodayString();
      if (st.reminder.lastFiredDate === today) return;
      // Bugünkü hedef tamamlandıysa hatırlatma gerek yok
      if (st.dailyGoal.todayDate === today &&
          st.dailyGoal.todayCount >= st.dailyGoal.target) return;

      var parts = st.reminder.time.split(':');
      var h0 = parseInt(parts[0], 10) || 0;
      var m0 = parseInt(parts[1], 10) || 0;
      var now = new Date();
      var target = new Date();
      target.setHours(h0, m0, 0, 0);
      var delay = target.getTime() - now.getTime();

      function doFire() {
        var cur = loadRetentionState();
        var t2 = getTodayString();
        if (cur.reminder.lastFiredDate === t2) return;
        if (cur.dailyGoal.todayDate === t2 &&
            cur.dailyGoal.todayCount >= cur.dailyGoal.target) return;
        fireDailyReminder(cur);
        cur.reminder.lastFiredDate = t2;
        saveRetentionState(cur);
        setRetention(cur);
      }

      if (delay > 0) {
        reminderTimerRef.current = setTimeout(doFire, Math.min(delay, 86400000));
      } else if (delay > -2 * 3600000) {
        // Saat geçti ama son 2 saat içinde — hemen yetiş
        doFire();
      }
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

      // Sprint 8: Meydan oku setup (ad + kart sayısı)
      if (modal.type === 'challengeSetup') {
        var chDeck = findDeck(modal.deckId);
        if (!chDeck) { setModal(null); return null; }
        return h(ChallengeSetupModal, {
          deckSize: chDeck.cards.length,
          onClose: function () { setModal(null); },
          onStart: function (opts) { startChallengeAsChallenger(modal.deckId, opts); }
        });
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

    // Sprint 8: Challenge tam ekran modları (tab bar yok)
    if (route.name === 'challengeIntro') {
      var chIntro = route.challenge;
      return h('div', { className: 'app', style: { padding: 0 } },
        h(ChallengeIntroView, {
          challenge: chIntro,
          onStart: function () { acceptChallenge(chIntro); },
          onSkip: function () { setRoute({ name: 'list' }); }
        })
      );
    }
    if (route.name === 'challengePlay') {
      if (!route.cards || route.cards.length === 0) {
        setRoute({ name: 'list' });
        return null;
      }
      return h('div', { className: 'app', style: { padding: 0 } },
        h(ChallengeStudyView, {
          cards: route.cards,
          key: route.sessionKey,
          onExit: function () { setRoute({ name: 'list' }); },
          onFinish: finishChallenge
        })
      );
    }
    if (route.name === 'challengeResult') {
      return h('div', { className: 'app', style: { padding: 0 } },
        h(ChallengeResultView, {
          mode: route.mode,
          mine: route.mine,
          theirs: route.theirs || null,
          deckName: route.deckName,
          shareUrl: route.shareUrl,
          hasDeck: !!route.hasDeck,
          onExit: function () { setRoute({ name: 'list' }); },
          onRevanche: function () {
            if (!route.ownDeckId) { setRoute({ name: 'discover' }); return; }
            openChallengeSetup(route.ownDeckId);
          },
          onDiscover: function () { setRoute({ name: 'discover' }); },
          onToast: showToast
        })
      );
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
            onFinish: finishContextSession,
            onCardReview: applyCardReview
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
          onFinish: finishSession,
          onCardReview: function (cardId, rating) {
            // Deste modu — saf cardId; deckId'yi route'tan eklenmiş bileşik gönder
            applyCardReview(sd.id + '::' + cardId, rating);
          }
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
        h(RetentionHeader, {
          retention: retention,
          onOpenGoal: function () { setGoalModalOpen(true); }
        }),
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
        onStudy: function (id) { setRoute({ name: 'study', deckId: id, sessionKey: uid() }); },
        // Sprint 8: deste detayından düello başlat
        onChallenge: function (id) { openChallengeSetup(id); }
      });
    } else if (route.name === 'stats') {
      title = 'İstatistik';
      body = h(StatsView, {
        state: state,
        ctxState: ctxState,
        retention: retention,
        duels: duels,
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
        // Sprint 7: hatırlatma + günlük hedef
        retention: retention,
        onToggleReminder: function (v) {
          var st = loadRetentionState();
          if (v && notificationPermState() === 'default') {
            ensureNotificationPermission().then(function () {
              setNotifPerm(notificationPermState());
              var st2 = loadRetentionState();
              st2.reminder.enabled = (notificationPermState() === 'granted');
              saveRetentionState(st2);
              setRetention(st2);
              scheduleDailyReminder();
            });
          } else {
            st.reminder.enabled = v && (notificationPermState() === 'granted');
            saveRetentionState(st);
            setRetention(st);
            scheduleDailyReminder();
          }
        },
        onSetReminderTime: function (t) {
          if (!/^\d{2}:\d{2}$/.test(t)) return;
          var st = loadRetentionState();
          st.reminder.time = t;
          // saat değiştiyse bugün tekrar atabilsin
          if (st.reminder.lastFiredDate === getTodayString()) {
            st.reminder.lastFiredDate = null;
          }
          saveRetentionState(st);
          setRetention(st);
          scheduleDailyReminder();
        },
        onOpenGoal: function () { setGoalModalOpen(true); },
        onImport: function (norm, ctxNorm) {
          setPendingImport({ deckNorm: norm, ctxNorm: ctxNorm || null });
          setModal({ type: 'import' });
        },
        // Sprint 9: Ses ve His ayarları
        soundOn: soundOn,
        hapticOn: hapticOn,
        animOn: animOn,
        hapticSupported: hapticSupported(),
        onToggleSound: function () {
          var nv = !soundOn;
          setSoundOn(nv); writeBoolPref(SOUND_KEY, nv);
        },
        onToggleHaptic: function () {
          var nv = !hapticOn;
          setHapticOn(nv); writeBoolPref(HAPTIC_KEY, nv);
          if (nv) haptic(15); // mini ön izleme
        },
        onToggleAnim: function () {
          var nv = !animOn;
          setAnimOn(nv); writeBoolPref(ANIM_KEY, nv);
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
        // Sprint 11: güneş↔ay morph animasyonu (CSS-only)
        h('button', {
          className: 'iconbtn theme-toggle ' + (theme === 'light' ? 'is-light' : 'is-dark'),
          onClick: toggleTheme,
          'aria-label': theme === 'light' ? 'Koyu temaya geç' : 'Açık temaya geç',
          title: theme === 'light' ? 'Koyu tema' : 'Açık tema'
        },
          h('span', { className: 'tt-stack', 'aria-hidden': 'true' },
            h('span', { className: 'tt-icon tt-sun' }, IconEl('sun', 22)),
            h('span', { className: 'tt-icon tt-moon' }, IconEl('moon', 22))
          )
        ),
        route.name === 'list'
          ? h('button', { className: 'iconbtn accent', onClick: function () { setModal({ type: 'newDeck' }); }, 'aria-label': 'Yeni deste' }, IconEl('plus', 22))
          : null,
        route.name === 'contexts'
          ? h('button', { className: 'iconbtn accent', onClick: function () { setRoute({ name: 'contextEdit' }); }, 'aria-label': 'Yeni bağlam' }, IconEl('plus', 22))
          : null
      ),
      h('div', { className: 'content' }, body),
      h('div', { className: 'tabs' },
        Tab('list', IconEl('decks', 22), 'Desteler'),
        Tab('discover', IconEl('discover', 22), 'Keşfet'),
        Tab('contexts', IconEl('contexts', 22), 'Bağlamlar'),
        Tab('stats', IconEl('stats', 22), 'İstatistik'),
        Tab('data', IconEl('data', 22), 'Veri')
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
      toast ? h(Toast, { key: toast.id, text: toast.text, onDone: function () { setToast(null); } }) : null,
      // Sprint 7: streak kutlama toast'ı
      celebrate ? h(StreakCelebrate, {
        key: celebrate.id, streak: celebrate.streak,
        onDone: function () { setCelebrate(null); }
      }) : null,
      // Sprint 7: günlük hedef modal'ı
      goalModalOpen
        ? h(DailyGoalModal, {
            initial: retention.dailyGoal.target,
            onClose: function () { setGoalModalOpen(false); },
            onSave: function (n) {
              var st = loadRetentionState();
              st.dailyGoal.target = n;
              saveRetentionState(st);
              setRetention(st);
              setGoalModalOpen(false);
              showToast('Günlük hedef: ' + n + ' kart');
            }
          })
        : null
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
                }, renderContextIcon(c, 14), h('span', null, ' ' + c.name));
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
                  }, renderContextIcon(c, 14), h('span', null, ' ' + c.name));
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
