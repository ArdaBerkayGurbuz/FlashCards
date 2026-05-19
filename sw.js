/* ============================================================
   FlashCards — Service Worker
   App shell cache-first + çevrimdışı yedek
   ============================================================ */

var CACHE = 'flashcards-v10';
// Sprint 6: indirilen marketplace görselleri (çevrimdışı çalışsın)
var MP_IMG = 'flashcards-mp-images-v1';

// Göreli yollar — GitHub Pages alt-dizininde de çalışır.
var APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/flashcards_icons/pwa/icon-192.png',
  './icons/flashcards_icons/pwa/icon-512.png',
  './icons/flashcards_icons/pwa/icon-512-maskable.png',
  './icons/flashcards_icons/ios/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Her dosya tek tek; biri 404 olsa bile kurulum çökmesin.
      return Promise.all(APP_SHELL.map(function (url) {
        return cache.add(url).catch(function (e) {
          console.warn('Önbelleğe alınamadı:', url, e);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // MP_IMG korunur — indirilen görseller silinmesin
        if (k !== CACHE && k !== MP_IMG) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;

  // Sprint 6: marketplace görselleri — cache-first (çevrimdışı çalışır).
  // githubusercontent.com üzerindeki /images/ yolları.
  if (!sameOrigin &&
      url.hostname.indexOf('githubusercontent.com') >= 0 &&
      url.pathname.indexOf('/images/') >= 0) {
    event.respondWith(
      caches.open(MP_IMG).then(function (cache) {
        return cache.match(req).then(function (cached) {
          if (cached) return cached;
          return fetch(req).then(function (res) {
            if (res && (res.status === 200 || res.type === 'opaque')) {
              cache.put(req, res.clone());
            }
            return res;
          });
        });
      })
    );
    return;
  }

  if (sameOrigin) {
    // App shell: cache-first, ağ varsa arkada güncelle (stale-while-revalidate)
    event.respondWith(
      caches.match(req).then(function (cached) {
        var network = fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      }).catch(function () {
        // Gezinme isteğinde çevrimdışıysa index'e düş
        if (req.mode === 'navigate') return caches.match('./index.html');
      })
    );
  } else {
    // Çapraz köken (Google Fonts vb.): network-first, başarısızsa cache
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
  }
});

// Sprint 4: bildirime tıklanınca uygulamayı aç/odakla, bağlamla çalış
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          client.postMessage({ type: 'notification-click', data: data });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        var url = data.contextId
          ? './?action=study&contextId=' + encodeURIComponent(data.contextId)
          : './';
        return clients.openWindow(url);
      }
    })
  );
});
