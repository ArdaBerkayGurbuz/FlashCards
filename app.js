/* ============================================================
   Kartlar — Bilgi Kartları PWA
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

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
              return {
                id: typeof c.id === 'string' ? c.id : uid(),
                q: String(c.q == null ? '' : c.q),
                a: String(c.a == null ? '' : c.a),
                createdAt: c.createdAt || Date.now()
              };
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

  // İlk açılışta örnek bir deste (kullanıcı silebilir)
  function seedState() {
    var st = emptyState();
    var did = uid();
    st.decks.push({
      id: did,
      name: 'Örnek Deste',
      createdAt: Date.now(),
      lastStudied: null,
      cards: [
        { id: uid(), q: 'Kartlar nasıl çevrilir?', a: 'Karta dokunarak veya boşluk tuşuyla.', createdAt: Date.now() },
        { id: uid(), q: 'Verilerim nerede saklanır?', a: 'Sadece bu cihazda, tarayıcının localStorage alanında.', createdAt: Date.now() },
        { id: uid(), q: 'Başka cihaza nasıl taşırım?', a: 'Veri ekranından JSON dışa aktar, diğer cihazda içe aktar.', createdAt: Date.now() }
      ]
    });
    return st;
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

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
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
    // queue: ana kuyruk, requeue: bilmiyorum denenler
    var initial = useMemo(function () { return shuffle(deck.cards); }, [deck.id]);
    var st = useState(function () {
      return {
        queue: initial.slice(),
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

    function toggleFlip() {
      setS(function (p) { return Object.assign({}, p, { flipped: !p.flipped }); });
    }

    // Klavye: boşluk = çevir, 1/2/3 = değerlendir
    useEffect(function () {
      function onKey(e) {
        if (s.done) return;
        if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); toggleFlip(); }
        else if (s.flipped && (e.key === '1')) advance('bad');
        else if (s.flipped && (e.key === '2')) advance('maybe');
        else if (s.flipped && (e.key === '3')) advance('good');
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, [s.flipped, s.done]);

    // Seans bitince istatistikleri kaydet (bir kez)
    var savedRef = useRef(false);
    useEffect(function () {
      if (s.done && !savedRef.current) {
        savedRef.current = true;
        props.onFinish(deck.id, s.seen, s.correct);
      }
    }, [s.done]);

    if (s.done) {
      return h('div', { className: 'study' },
        h('div', { className: 'summary' },
          h('div', { className: 'seal' }, '✓'),
          h('h2', null, 'Seans tamamlandı'),
          h('div', { className: 'lead' }, deck.name),
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
        h('div', { className: 'flashcard' + (s.flipped ? ' flipped' : ''), role: 'button', 'aria-label': 'Kartı çevir' },
          h('div', { className: 'face front' },
            h('div', { className: 'tag' }, 'SORU'),
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
        ? h('div', { className: 'rate-row' },
            h('button', { className: 'rate bad', onClick: function (e) { e.stopPropagation(); advance('bad'); } },
              h('span', { className: 'ic' }, '✕'), h('span', null, 'Bilmiyorum')),
            h('button', { className: 'rate maybe', onClick: function (e) { e.stopPropagation(); advance('maybe'); } },
              h('span', { className: 'ic' }, '~'), h('span', null, 'Kararsız')),
            h('button', { className: 'rate good', onClick: function (e) { e.stopPropagation(); advance('good'); } },
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
      h('div', { className: 'spacer-sm' }),
      h('button', { className: 'linkbtn danger', onClick: props.onReset }, 'İstatistikleri sıfırla')
    );
  }

  // ---------- Veri ekranı (JSON dışa/içe) ----------

  function DataView(props) {
    var fileRef = useRef(null);

    function doExport() {
      try {
        var data = JSON.stringify(props.state, null, 2);
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
            props.toast('Geçersiz dosya: deste verisi bulunamadı');
            return;
          }
          props.onImport(norm);
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
        h('p', null, 'Tüm desteler, kartlar ve istatistikler tek bir JSON dosyasına indirilir. Bu dosyayı başka bir cihaza taşıyıp içe aktarabilirsiniz.'),
        h('div', { className: 'mono', style: { fontSize: '12px', color: 'var(--ink-faint)', marginBottom: '12px' } },
          props.state.decks.length + ' deste · ' + totalCards + ' kart'),
        h('button', { className: 'btn primary', onClick: doExport }, '⤓  JSON dışa aktar')
      ),
      h('div', { className: 'panel' },
        h('h3', null, 'Yedeği içe aktar'),
        h('p', null, 'Daha önce aldığınız bir JSON yedeğini yükleyin. Mevcut verinin yerine geçsin mi yoksa birleştirilsin mi seçeceksiniz.'),
        h('input', { type: 'file', accept: 'application/json,.json', ref: fileRef, className: 'hidden-file', onChange: onFile }),
        h('button', { className: 'btn ghost', onClick: function () { fileRef.current && fileRef.current.click(); } }, '⤒  JSON dosyası seç')
      ),
      h('div', { className: 'hint-line' },
        'Veriler yalnızca bu cihazda, tarayıcı depolamasında tutulur. Tarayıcı verilerini temizlerseniz silinir.')
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

    // her değişimde kaydet
    useEffect(function () { persist(state); }, [state]);

    function showToast(text) { setToast({ text: text, id: uid() }); }

    function update(mutator) {
      setState(function (prev) {
        var next = JSON.parse(JSON.stringify(prev));
        mutator(next);
        return next;
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
      setModal(null);
      setRoute({ name: 'list' });
      showToast('Deste silindi');
    }

    // ----- Kart işlemleri -----
    function addCard(deckId, q, a) {
      update(function (n) {
        n.decks.forEach(function (d) {
          if (d.id === deckId) d.cards.push({ id: uid(), q: q, a: a, createdAt: Date.now() });
        });
      });
      setModal(null);
    }
    function editCard(deckId, cardId, q, a) {
      update(function (n) {
        n.decks.forEach(function (d) {
          if (d.id === deckId) d.cards.forEach(function (c) {
            if (c.id === cardId) { c.q = q; c.a = a; }
          });
        });
      });
      setModal(null);
    }
    function deleteCard(deckId, cardId) {
      update(function (n) {
        n.decks.forEach(function (d) {
          if (d.id === deckId) d.cards = d.cards.filter(function (c) { return c.id !== cardId; });
        });
      });
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

    // ----- İçe aktarma -----
    function applyImport(mode) {
      var incoming = pendingImport;
      if (!incoming) return;
      update(function (n) {
        if (mode === 'replace') {
          n.decks = incoming.decks;
          n.stats = incoming.stats;
        } else { // merge
          var existingIds = {};
          n.decks.forEach(function (d) { existingIds[d.id] = true; });
          incoming.decks.forEach(function (d) {
            if (existingIds[d.id]) d.id = uid(); // çakışmayı önle
            n.decks.push(d);
          });
          n.stats.totalSessions += incoming.stats.totalSessions;
          n.stats.totalSeen += incoming.stats.totalSeen;
          n.stats.totalCorrect += incoming.stats.totalCorrect;
          Object.keys(incoming.stats.perDeck).forEach(function (k) {
            if (!n.stats.perDeck[k]) { n.stats.perDeck[k] = incoming.stats.perDeck[k]; }
          });
        }
      });
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
        return h(CardModal, {
          title: isAdd ? 'Yeni kart' : 'Kartı düzenle',
          initialQ: isAdd ? '' : modal.card.q,
          initialA: isAdd ? '' : modal.card.a,
          onClose: function () { setModal(null); },
          onSubmit: function (q, a) {
            if (isAdd) addCard(modal.deckId, q, a);
            else editCard(modal.deckId, modal.card.id, q, a);
          }
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

      if (modal.type === 'import') {
        var inc = pendingImport;
        var nCards = inc ? inc.decks.reduce(function (a, d) { return a + d.cards.length; }, 0) : 0;
        return h(Modal, { title: 'Yedeği içe aktar', onClose: function () { setModal(null); setPendingImport(null); } },
          h('p', { className: 'confirm-text' },
            'Dosyada ' + (inc ? inc.decks.length : 0) + ' deste ve ' + nCards + ' kart bulundu. Nasıl uygulansın?'),
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

    // Çalışma modu tam ekran (tab bar yok)
    if (route.name === 'study') {
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

    var title = 'Kartlar';
    var body = null;
    var showBack = false;

    if (route.name === 'list') {
      body = h(DeckListView, {
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
        toast: showToast,
        onImport: function (norm) {
          setPendingImport(norm);
          setModal({ type: 'import' });
        }
      });
    }

    function Tab(name, icon, label) {
      return h('button', {
        className: route.name === name ? 'active' : '',
        onClick: function () { setRoute({ name: name }); }
      }, h('span', { className: 'ic' }, icon), h('span', null, label));
    }

    return h('div', { className: 'app' },
      h('div', { className: 'topbar' },
        showBack
          ? h('button', { className: 'back', onClick: function () { setRoute({ name: 'list' }); } }, '‹ Desteler')
          : null,
        h('h1', null, title),
        route.name === 'list'
          ? h('button', { className: 'iconbtn accent', onClick: function () { setModal({ type: 'newDeck' }); }, 'aria-label': 'Yeni deste' }, '＋')
          : null
      ),
      h('div', { className: 'content' }, body),
      h('div', { className: 'tabs' },
        Tab('list', '▤', 'Desteler'),
        Tab('stats', '◷', 'İstatistik'),
        Tab('data', '⇅', 'Veri')
      ),
      renderModal(),
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

  // ---------- Modal: kart ekle/düzenle ----------
  function CardModal(props) {
    var qh = useState(props.initialQ || '');
    var ah = useState(props.initialA || '');
    var q = qh[0], setQ = qh[1];
    var a = ah[0], setA = ah[1];
    var qRef = useRef(null);
    useEffect(function () { if (qRef.current) qRef.current.focus(); }, []);
    function submit() {
      if (!q.trim() && !a.trim()) { if (qRef.current) qRef.current.focus(); return; }
      props.onSubmit(q.trim(), a.trim());
    }
    return h(Modal, { title: props.title, onClose: props.onClose },
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
