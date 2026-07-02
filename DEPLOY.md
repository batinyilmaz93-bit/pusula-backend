# Deploy — Pusula Seyahat Backend

## 1) En hızlı yol: Render / Railway / Fly.io

Üçü de Node projelerini doğrudan GitHub reposundan build edip host eder.

1. Bu `server/` klasörünü GitHub'a push et.
2. Render/Railway'de "New Web Service" → repoyu bağla.
3. Build command: `npm install` · Start command: `npm start`
4. Environment variables: `JWT_SECRET` (rastgele uzun bir string), `PORT`
   genelde platform tarafından otomatik verilir.
5. SQLite dosyası container'ın diskinde tutulur — **tek instance** için
   sorunsuz çalışır. Birden fazla instance/otomatik ölçeklendirme
   istiyorsan adım 2'ye geç.

## 2) Ölçeklenebilir hâle getirme: Postgres'e geçiş

SQLite tek dosyaya yazdığı için birden fazla sunucu instance'ı paylaşamaz.
Gerçek prod için:

1. Neon veya Supabase'te ücretsiz bir Postgres veritabanı aç, `DATABASE_URL`'i al.
2. `npm i -D prisma && npm i @prisma/client`
3. `npx prisma migrate dev --name init` (şema zaten `prisma/schema.prisma` içinde hazır)
4. `src/db.js` içindeki fonksiyonları aynı imzalarla Prisma sorgularına
   çevir — her fonksiyonun üstünde zaten karşılık gelen SQL/Prisma yorumu
   var, satır satır eşleşiyor.
5. Cache katmanını (`src/cache.js`) Redis'e taşı (Upstash'in ücretsiz
   planı yeterli) — birden fazla instance cache'i paylaşsın.

## 3) Mevcut React artifact'ini bu backend'e bağlamak

Şu anki `seyahat-butce.jsx` tamamen istemci taraflı çalışıyor
(`window.storage` + doğrudan dış API çağrıları). Bu backend'e bağlamak için
değişmesi gereken tek katman, verinin nereden geldiği — UI bileşenlerinin
neredeyse hiçbiri değişmiyor:

| Artifact'teki fonksiyon | Backend karşılığı |
|---|---|
| `loadTrips()` / `saveTrips()` | `GET /api/trips` (artık tüm cihazlarda ortak) |
| `geocodeCity()` | `GET /api/proxy/geocode` |
| `fetchWeatherTime()` | `GET /api/proxy/weather` |
| `fetchCurrencyCode()` + `fetchExchangeRate()` | `GET /api/proxy/fx` |
| `fetchPOI()` | `GET /api/proxy/poi` |
| `fetchNews()` | `GET /api/proxy/news` |
| `updateTrip()` içindeki her mutasyon | ilgili `POST/DELETE /api/trips/:id/...` çağrısı |
| offline fallback (OFFLINE_CITIES/OFFLINE_RATES) | aynen kalır — backend de ulaşamazsa son çare olarak devrede |

Ayrıca `useEffect` içindeki interval'ler yerini `socket.on("trip:update", ...)`
dinleyicisine bırakır — polling yerine gerçek zamanlı güncelleme.

İstersen bir sonraki adımda bu bağlama katmanını (`api-client.js`) yazıp
artifact'i gerçekten bu backend'e bağlayabilirim; bu, artifact'in
claude.ai içinde tek başına çalışma özelliğini kaybettirir (dış bir
backend'e bağımlı hale gelir) — o yüzden ayrı bir onay istiyorum.
