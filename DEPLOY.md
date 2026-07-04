# Deploy — Pusula Seyahat Backend

## Zaten Render'da bir servisin varsa (mevcut durumun)

Sadece 3 adım, yeniden kurmana gerek yok:

1. [neon.tech](https://neon.tech) → ücretsiz Postgres oluştur → bağlantı
   adresini kopyala.
2. Render Dashboard → `pusula-backend` servisin → **Environment** sekmesi →
   **Add Environment Variable** → Key: `DATABASE_URL`, Value: Neon'dan
   aldığın adres.
3. Bu klasördeki güncel dosyaları (özellikle `src/db.js`, `src/auth.js`,
   `src/routes/`) GitHub'daki `pusula-backend` reposuna tekrar yükle (Add
   file → Upload files). Render otomatik yeniden deploy eder.

Deploy bitince Render'ın **Logs** sekmesinde `Pusula seyahat backend
http://localhost:...` satırını görmelisin — bu, veritabanı bağlantısının
başarılı olduğu ve tabloların oluşturulduğu anlamına gelir. Hata görürsen
`DATABASE_URL`'i yanlış kopyalamış olabilirsin, tekrar kontrol et.

Bu andan itibaren eski "Geçersiz oturum" sorunu bir daha çıkmaz — çünkü
artık veriler Render'ın değil, Neon'un (ayrı, her zaman açık) sunucusunda
duruyor.

## Sıfırdan kuruyorsan

1. Önce Neon'da veritabanını oluştur (yukarıdaki adım 1).
2. Render → New → Web Service → `pusula-backend` reposunu bağla.
3. Build command: `npm install` · Start command: `npm start`
4. Environment variables: `JWT_SECRET` (rastgele uzun bir string) ve
   `DATABASE_URL` (Neon adresin).
5. Create Web Service → birkaç dakika içinde adresin hazır.

## Notlar

- Render'ın ücretsiz planı 15 dakika hareketsizlikten sonra "uykuya"
  girer; ilk istek ~30-60 saniye gecikebilir (sonraki istekler hızlı).
  Bu artık veri kaybına yol açmıyor, sadece ilk açılışta küçük bir
  bekleme demek.
- Neon'un ücretsiz planı süresizdir (30 günde silinen bir şey yok), kredi
  kartı istemez. Veritabanı 5 dakika hareketsizlikten sonra "uykuya" girer
  ama bu sadece bir sonraki sorguda ~300-500ms'lik küçük bir gecikme
  demek — Render'daki gibi veri kaybı **olmaz**, çünkü uyuyan şey compute,
  diskteki veri değil. Bu uygulamanın trafiği için aylık ücretsiz kotayı
  aşman neredeyse imkansız.
