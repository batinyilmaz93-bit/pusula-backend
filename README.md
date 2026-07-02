# Pusula Seyahat — Backend

Ajan 3'ün önerdiği mimarinin çalışan hâli: gerçek çok-cihazlı senkronizasyon
(WebSocket), sunucu taraflı proxy (CORS/sandbox sorununu bitirir, tüm trip
üyeleri için ortak cache) ve kalıcı veritabanı.

**Dev veritabanı:** Node'un yerleşik `node:sqlite` modülü — kurulum
gerektirmez, `npm install` sonrası direkt çalışır. **Prod veritabanı:**
`prisma/schema.prisma` — Postgres'e (Neon/Supabase) geçiş bire bir aynı
tablo yapısıyla, veri katmanını değiştirmek yeterli (bkz. DEPLOY.md).

## Hızlı başlangıç

```bash
cd server
npm install
cp .env.example .env      # JWT_SECRET'i değiştirmeyi unutma
npm start                 # http://localhost:4000
```

## Kimlik doğrulama

Hesap/şifre yok — grup seyahati mantığına uygun, "cihaz kimliği" var:

```
POST /api/auth/device   { "name": "Batın" }
→ { "token": "...", "user": { "id": "...", "name": "Batın" } }
```

Sonraki tüm isteklerde `Authorization: Bearer <token>` gönderilir. Token 180
gün geçerli, cihazda saklanır (artifact'te localStorage yerine aynı
window.storage kalıbı kullanılabilir).

## API referansı

| Metot | Yol | Açıklama |
|---|---|---|
| POST | `/api/trips` | Yeni seyahat oluştur (çağıran kişi admin olur) |
| GET | `/api/trips` | Üyesi olduğun tüm seyahatler |
| POST | `/api/trips/join` | `{ inviteCode }` ile bir seyahate katıl |
| GET | `/api/trips/:id` | Seyahat detayı (üyeler, harcamalar, notlar) |
| DELETE | `/api/trips/:id` | Seyahati sil (yalnız admin) |
| POST | `/api/trips/:id/members` | `{ name }` — misafir üye ekle |
| DELETE | `/api/trips/:id/members/:memberId` | Üye çıkar (harcamalarda kayıtlıysa 409 döner) |
| POST | `/api/trips/:id/expenses` | `{ desc, amount, category, paidBy, splitAmong[] }` |
| DELETE | `/api/trips/:id/expenses/:expenseId` | Harcama sil |
| POST | `/api/trips/:id/settle` | `{ from, to, amount }` — borcu öde |
| POST | `/api/trips/:id/hazards` | `{ text }` — güvenlik notu ekle |
| DELETE | `/api/trips/:id/hazards/:hazardId` | Güvenlik notu sil |
| GET | `/api/proxy/geocode?city=&country=` | Şehir → koordinat (cache 24s) |
| GET | `/api/proxy/weather?lat=&lon=&timezone=` | Anlık hava (cache 5dk) |
| GET | `/api/proxy/fx?country=` | Ülke → para birimi + TL kuru (cache 3dk) |
| GET | `/api/proxy/poi?lat=&lon=` | Restoran/cafe/müze/alışveriş (cache 30dk) |
| GET | `/api/proxy/news?country=` | Son dakika haberleri (cache 3dk) |

Tüm `/api/trips/*` uçları (join hariç) `Authorization` header'ı ve
o seyahatin üyesi olmayı gerektirir.

## Gerçek zamanlı senkronizasyon (Socket.IO)

```js
const socket = io("https://your-backend.example.com");
socket.emit("trip:join", tripId);
socket.on("trip:update", (freshTrip) => { /* state'i güncelle */ });
socket.on("trip:deleted", ({ id }) => { /* listeden çıkar */ });
```

Her mutasyon (harcama/üye/not ekleme-silme, ödeme) o seyahatin odasındaki
tüm bağlı cihazlara anında yayınlanır — artık herkes kendi telefonundan aynı
seyahati canlı görebiliyor, tek cihaza/tarayıcıya bağlı kalmıyor.

## Test edildi

Bu depoyu teslim etmeden önce uçtan uca test ettim: cihaz kaydı → seyahat
oluşturma → üye ekleme → harcama ekleme → **harcamada kayıtlı üyeyi silmeye
çalışma (beklenen: 409, doğrulandı)** → borç ödeme → proxy endpoint hata
yönetimi. Hepsi beklendiği gibi çalıştı.
