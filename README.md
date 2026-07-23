# KPSS Ön Lisans 2026 — Çalışma Platformu

Kişisel çalışma uygulaması: konuya göre geçmiş yıl KPSS soruları, cevapları ve
konu başına YouTube videoları. Tamamen tarayıcıda çalışır, sunucu tarafı yoktur.

## Ne var?

- **1737 soru** — 2008-2020 arası 16 ÖSYM kitapçığından, konu konu etiketlenmiş
- Her sorunun **cevabı** (resmî cevap anahtarından) ve **kaynağı**
  (ör. `2020 KPSS ÖN LİSANS • GENEL YETENEK • SORU 31`)
- Kendi **soru fotoğraflarını** ve konuya göre **YouTube videolarını** ekleme
- Sınava kalan gün sayacı, Dışa/İçe Aktar, soruyu başka konuya taşıma

| Ders | Soru |
|---|---|
| Türkçe | 456 |
| Tarih | 399 |
| Matematik | 394 |
| Coğrafya | 252 |
| Vatandaşlık | 128 |
| Güncel Bilgiler | 60 |
| Geometri | 48 |

## Çalıştırma

**Web (önerilen).** Statik site; kurulum gerekmez. Sunulduğunda uygulama
`data/manifest.json`'ı okur ve açılan dersin soru paketini **o an** indirir
(ör. Türkçe 19 MB). İndirilen paket tarayıcıda saklanır, tekrar inmez.

**Çevrimdışı.** `index.html` dosyasını Chrome/Edge ile aç. `file://` üzerinde
tarayıcı `fetch`'e izin vermediği için sorular otomatik yüklenmez; bu durumda
**⬆ İçe Aktar** ile `import-*.json` dosyaları elle yüklenir.

## Veriler nerede duruyor?

Sorular, eklenen fotoğraflar ve videolar tarayıcının **IndexedDB**'sinde tutulur;
hiçbir şey sunucuya gönderilmez. Veri tarayıcıya ve adrese özeldir — bu yüzden
`file://` ile açılan sürüm ile web sürümü aynı veriyi paylaşmaz. Aktarmak için
**⬇ Dışa Aktar** / **⬆ İçe Aktar** kullanılabilir.

## Dosyalar

| Yol | Açıklama |
|---|---|
| `index.html`, `app.js`, `styles.css` | Uygulama (~35 KB) |
| `syllabus.js` | KPSS Ön Lisans ders/konu ağacı |
| `data/*.json` | Ders başına soru paketleri + `manifest.json` |
| `exams/` | PDF'ler ve çıkarma hattı (repoda yok, yereldedir) |

## Sorular nasıl çıkarıldı?

`exams/extract.py` her soruyu PDF'ten **görüntü olarak kırpar** — matematik
formülleri ve şekiller PDF içinde gömülü resim olduğundan düz metin çıkarımı
bunları kaybederdi. Cevaplar resmî cevap anahtarından okunur. Her aday soru,
gerçekten A–E şıkları içerip içermediğine göre doğrulanır; sınav kuralları gibi
numaralı ama soru olmayan sayfalar böylece elenir.
