# FlashCards — Icon Paketi

Üç kart yığını konsepti. Koyu mor zemin, magenta + krem kartlar, italik **F** + accent nokta.

## Klasör yapısı

```
flashcards_icons/
├── playstore/                    ← Play Store'a yüklenenler
│   ├── ic_launcher_512.png       ← Store listing icon (512×512, zorunlu)
│   └── feature_graphic_1024x500.png  ← Mağaza üst banner (zorunlu)
│
├── android_adaptive/             ← Android adaptive icon (Android 8+)
│   ├── ic_launcher_foreground.png    → res/drawable/
│   ├── ic_launcher_background.png    → res/drawable/
│   └── ic_launcher.xml               → res/mipmap-anydpi-v26/
│
├── android_mipmap/               ← Legacy launcher icons
│   ├── mipmap-mdpi/ic_launcher.png      (48px)
│   ├── mipmap-hdpi/ic_launcher.png      (72px)
│   ├── mipmap-xhdpi/ic_launcher.png     (96px)
│   ├── mipmap-xxhdpi/ic_launcher.png    (144px)
│   └── mipmap-xxxhdpi/ic_launcher.png   (192px)
│
├── ios/                          ← iPhone PWA / native iOS
│   ├── apple-touch-icon.png          (180px)
│   ├── icon-152.png                  (iPad)
│   ├── icon-167.png                  (iPad Pro)
│   └── icon-180.png                  (iPhone)
│
├── pwa/                          ← PWA manifest
│   ├── icon-192.png
│   ├── icon-512.png
│   └── icon-512-maskable.png
│
└── preview/
    ├── preview-1024.png
    └── launcher-preview.png
```

## Nereye Ne Yüklenir?

### Play Store

| Yer | Dosya | Boyut |
|-----|-------|-------|
| App icon | `playstore/ic_launcher_512.png` | 512×512 |
| Feature graphic | `playstore/feature_graphic_1024x500.png` | 1024×500 |

### Android Studio projesi

**Adaptive icon (Android 8.0+):**
- `android_adaptive/ic_launcher_foreground.png` → `app/src/main/res/drawable/`
- `android_adaptive/ic_launcher_background.png` → `app/src/main/res/drawable/`
- `android_adaptive/ic_launcher.xml` → `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`

**Legacy fallback:**
- `android_mipmap/mipmap-*/` → tamamı `app/src/main/res/` altına kopyalanır

### PWA + iPhone

PWA klasöründeki `icons/` içine kopyala:
- `pwa/icon-192.png` → `kartlar/icons/icon-192.png`
- `pwa/icon-512.png` → `kartlar/icons/icon-512.png`
- `pwa/icon-512-maskable.png` → `kartlar/icons/icon-512-maskable.png`
- `ios/apple-touch-icon.png` → `kartlar/icons/apple-touch-icon.png`

> **Önemli:** Uygulamanın HTML'inde "Kartlar." yazıyor. Marka olarak "FlashCards" kullanacaksan `app.js` ve `index.html`'deki başlıkları da güncellemen gerekir. Aşağıda bunun için hızlı bir rehber var.

## Marka adını HTML'de güncelle

`index.html` içinde:
```html
<title>FlashCards</title>
<meta name="apple-mobile-web-app-title" content="FlashCards" />
```

`manifest.json` içinde:
```json
"name": "FlashCards",
"short_name": "FlashCards"
```

`app.js` içinde:
```javascript
h('div', { className: 'brand' }, 'FlashCards', h('span', { className: 'dot' }, '.')),
```

## Renk Paleti

```
Arkaplan üst:    #201637
Arkaplan alt:    #120C26
Kart arka:       #823C82
Kart orta:       #D74B91
Kart ön:         #FAF0DC
F harfi:         #281946
Accent nokta:    #B8472E
```
