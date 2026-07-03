# Pusula Seyahat — Backend

Gerçek çok-cihazlı senkronizasyon (WebSocket), sunucu taraflı proxy
(CORS/sandbox sorununu bitirir, tüm trip üyeleri için ortak cache), ve
**kalıcı Postgres veritabanı**.

## ⚠️ Neden Postgres (SQLite değil)?

İlk sürüm Node'un yerleşik `node:sqlite`'ını kullanıyordu — kurulumsuz,
hızlı başlangıç için iyiydi. Ama Render'ın ücretsiz planında **dosya
sistemi kalıcı değil**: servis her 15 dakika hareketsizlik sonrası
"uykuya" girip tekrar uyandığında (veya her yeniden deploy'da) yerel
dosyalar sıfırlanıyor. Bu da SQLite dosyasındaki tüm kullanıcı/seyahat
verisinin silinmesi, tarayıcıda kayıtlı eski oturumun "Geçersiz oturum"
hatası vermesi anlamına geliyordu. Postgres ayrı, her zaman açık bir
servis olduğu için bu sorunu tamamen ortadan kaldırıyor.

## Hızlı başlangıç

### 1. Ücretsiz bir Postgres veritabanı al

[neon.tech](https://neon.tech) → ücretsiz kayıt ol → "Create Project" →
sana bir bağlantı adresi (connection string) verir, şuna benzer:
```
postgresql://user:pass@ep-xxxx.us-east-2.aws.neon.tech/pusula?sslmode=require
```
Bunu kopyala.

### 2. Yerel geliştirme

```bash
cd server
npm install
cp .env.example .env
# .env dosyasını aç, DATABASE_URL satırına Neon'dan aldığın adresi yapıştır
# JWT_SECRET'i de değiştir
npm start                 # http://localhost:4000
```

İlk açılışta tablolar otomatik oluşturulur (`initSchema`), elle bir şey
yapmana gerek yok.

### 3. Render'da (veya başka bir host'ta) canlıya alma

Render → servisinin **Environment** sekmesine git → `DATABASE_URL`
değişkenini ekle/güncelle → Neon'dan aldığın adresi yapıştır → kaydet.
Render otomatik yeniden deploy eder. Bu andan itibaren oturumlar ve
seyahatler artık kalıcı — servis uyusa da veriler silinmiyor.

## Kimlik doğrulama

Hesap/şifre yok — grup seyahati mantığına uygun, "cihaz kimliği" var:

```
POST /api/auth/device   { "name": "Batın" }
→ { "token": "...", "user": { "id": "...", "name": "Batın" } }
```

Sonraki tüm isteklerde `Authorization: Bearer <token>` gönderilir. Token 180
gün geçerli, cihazda saklanır.

## API referansı

| Metot | Yol | Açıklama |
|---|---|---|
| POST | `/api/trips` | Yeni seyahat oluştur (çağıran kişi admin olur) |
| GET | `/api/trips` | Üyesi olduğun tüm seyahatler |
| POST | `/api/trips/join` | `{ inviteCode }` ile bir seyahate katıl |
| GET | `/api/trips/:id` | Seyahat detayı (üyeler, harcamalar, notlar) |
| DELETE | `/api/trips/:id` | Seyahati sil (yalnız admin) |
| POST | `/api/trips/:id/members` | `{ name }` — misafir üye ekle |
| DELETE | `/api/trips/:id/members/:memberId` | Üye çıkar (sadece admin ya da kendisi; harcamalarda kayıtlıysa 409) |
| POST | `/api/trips/:id/expenses` | `{ desc, amount, category, paidBy, splitAmong[] }` |
| DELETE | `/api/trips/:id/expenses/:expenseId` | Harcama sil |
| POST | `/api/trips/:id/settle` | `{ from, to, amount }` — borcu öde |
| POST | `/api/trips/:id/hazards` | `{ text }` — güvenlik notu ekle |
| DELETE | `/api/trips/:id/hazards/:hazardId` | Güvenlik notu sil |
| GET | `/api/proxy/geocode?city=&country=` | Şehir → koordinat (cache 24s) |
| GET | `/api/proxy/weather?lat=&lon=&timezone=` | Anlık hava (cache 5dk) |
| GET | `/api/proxy/fx?country=` | Ülke → para birimi + TL kuru (cache 3dk) |
| GET | `/api/proxy/poi?lat=&lon=` | Restoran/cafe/müze/alışveriş, 30'a kadar (cache 30dk) |
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

## Test edildi

Postgres'e geçişten sonra tüm akışı gerçek bir Postgres-uyumlu motora karşı
uçtan uca test ettim: cihaz kaydı → seyahat oluşturma → **seyahat listeleme
(önceki "geçersiz oturum" hatasının tam olarak koptuğu adım)** → arkadaş
katılımı → harcama ekleme → yetki kontrolü (409/403 senaryoları) → borç
ödeme. Hepsi doğru çalıştı.
