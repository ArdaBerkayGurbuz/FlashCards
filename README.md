# FlashCards — Bilgi Kartları PWA

**Sürüm: v1.0**

Koyu temalı, **çevrimdışı çalışan**, Türkçe bir bilgi kartı (flash card)
uygulaması. Build adımı yok — saf HTML + React (CDN) + vanilla CSS. Veriler
yalnızca cihazınızda tutulur; cihazlar arası taşıma JSON ile yapılır.
Canlı: https://ardaberkaygurbuz.github.io/FlashCards/

## Özellikler

- 📚 **Çoklu deste**: oluştur, yeniden adlandır, sil
- 🃏 **Soru-cevap kartları**: her destede ekle / düzenle / sil
- 🎴 **Çalışma modu**: kartlar karıştırılır, dokununca 3B çevrilir,
  *Bilmiyorum / Kararsız / Biliyorum* ile değerlendirilir.
  "Bilmiyorum" denen kartlar seans sonunda yeniden sorulur.
- 📊 **İstatistik**: toplam seans, görülen kart, doğru cevap, başarı yüzdesi
  ve deste bazlı kırılım
- 💾 **Yerel depolama**: `localStorage`, sadece bu cihazda
- 🔄 **JSON dışa/içe aktarma**: cihazlar arası taşıma (değiştir veya birleştir)
- 📱 **PWA**: iPhone/Android ana ekranına eklenebilir, çevrimdışı çalışır

> Başarı yüzdesi = `Biliyorum / Görülen × 100`. "Kararsız" görülen sayılır
> ama doğru sayılmaz.

## Dosya Yapısı

```
FlashCards/
├── index.html        # giriş; React/font/manifest bağlar, SW kaydeder
├── styles.css        # tasarım sistemi (koyu tema)
├── app.js            # React uygulaması (h() helper, JSX yok)
├── manifest.json     # PWA manifesti
├── sw.js             # service worker (offline app shell)
├── icons/            # flashcards_icons/ — PWA + iOS + Android + Play görselleri
└── README.md
```

> Bu klasör (depo kökü) `github.com/ArdaBerkayGurbuz/FlashCards` reposuna
> push edilir. Play Store / TWA adımları için ayrıca `../twa/KURULUM.md`.

## Hızlı Yol (Önerilen): Doğrudan GitHub Pages

PC'de bir sunucu kurmaya gerek yok. En pratik akış:

1. Aşağıdaki **GitHub Pages'e Yükleme** adımlarını izle.
2. Yayınlanan adresi iPhone'da **Safari** ile aç.
3. Safari'de **Ana Ekrana Ekle** → tam ekran, çevrimdışı uygulama hazır.

iPhone'un asıl uygulamayı çalıştıracağı yer burası; PC'de yerel test
zorunlu değil.

## Yerel Test (İsteğe Bağlı, Windows)

Service worker yalnızca `http(s)://` üzerinden kaydolur — dosyaya çift
tıklayıp `file://` ile açarsanız PWA/offline kısmı çalışmaz, bir yerel
sunucu gerekir. Bu projede **Python yok varsayımıyla** Windows'ta çalışan
seçenekler:

**A) Node ile (Node kuruluysa, kurulum gerektirmez):**

```powershell
cd FlashCards
npx --yes serve -l 8080 .
# Tarayıcı: http://localhost:8080
```

**B) VS Code "Live Server" eklentisi:** `index.html` → sağ tık →
*Open with Live Server*.

**C) PC ve iPhone aynı Wi-Fi'deyse, telefondan yerel teste bak:**
A şıkkındaki sunucuyu çalıştırırken PC'nin yerel IP'sini öğren
(`ipconfig` → IPv4, örn. `192.168.1.20`) ve iPhone Safari'de
`http://192.168.1.20:8080` adresini aç. Not: bu `http://` (TLS yok)
olduğu için iOS Safari service worker'ı kaydetmeyebilir; **offline/PWA**
davranışını gerçek anlamda test etmek için GitHub Pages (`https://`)
adresini kullan.

## GitHub Pages'e Yükleme

### 1. Depoyu hazırlayın

```bash
cd FlashCards
git init
git add .
git commit -m "FlashCards PWA"
git branch -M main
git remote add origin https://github.com/<KULLANICI>/<DEPO>.git
git push -u origin main
```

> Bu projede `FlashCards/` klasörünün **içeriği deponun kökünde** (yani
> `index.html` repo kökünde). Tüm yollar görelidir; alt dizinde de çalışır.

### 2. Pages'i açın

1. GitHub'da depo → **Settings → Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `main`, klasör `/ (root)` → **Save**
4. 1-2 dakika sonra adresiniz hazır:
   `https://<kullanıcı>.github.io/<depo>/`
   (bu proje: https://ardaberkaygurbuz.github.io/FlashCards/)

Tüm yollar göreli (`./`) ve `start_url: "./"` olduğu için **alt dizinde de
sorunsuz** çalışır.

### 3. iPhone Ana Ekranına Ekleme

1. Siteyi **Safari** ile açın (Chrome iOS'ta "Ana Ekrana Ekle" sınırlıdır).
2. Paylaş simgesi (kare + yukarı ok) → **Ana Ekrana Ekle**.
3. İsmi onaylayıp **Ekle** deyin.
4. Artık tam ekran, adres çubuğu olmadan, çevrimdışı açılır.

> İlk açılışta tüm dosyalar önbelleğe alınır. Sonra internet olmasa bile
> uygulama açılır ve tüm desteleriniz çalışır.

### Android (Chrome)

Siteyi açın → menü (⋮) → **Uygulamayı yükle / Ana ekrana ekle**.

## Cihazlar Arası Taşıma

Veriler sunucuda **tutulmaz**; her cihaz kendi `localStorage`'ını kullanır.
Taşımak için:

1. Eski cihaz: **Veri** sekmesi → *JSON dışa aktar* →
   `flashcards-yedek-YYYYAAGG.json` indirilir.
2. Dosyayı yeni cihaza aktarın (e-posta, AirDrop, bulut vb.).
3. Yeni cihaz: **Veri** sekmesi → *JSON dosyası seç* →
   **Yerine koy** veya **Birleştir** seçin.

## Notlar / Sınırlamalar

- Tarayıcı verilerini/siteyi temizlerseniz desteler silinir — düzenli
  **JSON yedeği** alın.
- Fontlar (Fraunces / Inter Tight / JetBrains Mono) Google Fonts'tan gelir
  ve ilk yüklemede önbelleğe alınır. Hiç çevrimiçi olunmadıysa sistem
  yazı tipine düşülür (işlevsellik etkilenmez).
- Değişiklik yaptığınızda yeni sürümün gelmesi için `sw.js` içindeki
  `CACHE = 'flashcards-v3'` değerini artırın (örn. `flashcards-v4`).
- Play Store / TWA paketleme: `../twa/KURULUM.md`.

## 🆕 Bağlamsal Hatırlatma

Kartlarını konum/zaman/duruma göre etiketleyebilirsin. Uygulamayı açtığında
o anki bağlamla eşleşen kartlar Home ekranında öne çıkar.

- **Bağlam oluştur**: Bağlamlar sekmesi → + Yeni Bağlam
- **Karta ata**: Kartı düzenle → Bağlamlar bölümünden seç
- **Çalış**: Home banner'da "Hadi Başla" veya bağlamın detayından

> PWA sınırı: konum sadece uygulama açıkken kontrol edilir, arka planda
> takip edilmez. Bildirimler en iyi Android Chrome'da çalışır.

## Bildirimler

Uygulama, bağlam zamanına yaklaşıldığında bildirim göndermeyi dener. PWA
platform sınırları nedeniyle davranış cihaza göre değişir:

| Senaryo | Android Chrome | iOS Safari (ana ekrana ekli) |
|---|---|---|
| Uygulama açıkken bildirim | ✅ | ✅ (iOS 16.4+) |
| Zamanlanmış bildirim | ⚠️ Uygulama açıkken/dönünce yakalanır | ⚠️ Daha kısıtlı |
| Push (sunucudan) | ❌ (backend yok) | ❌ (backend yok) |
| Arka planda konum | ❌ | ❌ |

Kaçırılan zaman bağlamları, uygulamayı tekrar açtığında Home'da bir
**catch-up şeridi** ile hatırlatılır. Bildirim izni yalnız bir bağlamı
"bildirim açık" kaydederken veya Ayarlar'dan manuel istenir.

## Lisans

Kişisel kullanım için serbest.

---

### Yol haritası (V2 — bu sürümde yok)

Capacitor ile native (gerçek arka plan geofence), sunucu sync (çoklu
cihaz), AI ile kart üretimi, sesli/podcast mod, co-op çalışma, görsel
hafıza sarayı. Şu an saf statik PWA kapsamı dışındadır.
