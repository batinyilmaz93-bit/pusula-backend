// routes/proxy.js — server-side proxy + cache for third-party data.
//
// Why this exists: in the standalone browser artifact, every one of these
// calls happened directly from the client, which is exactly what breaks
// inside a sandboxed preview (outbound fetch blocked) and is fragile even in
// a real browser (CORS on some upstreams, no shared caching between users of
// the same trip, no rate-limit protection for the free Overpass endpoint).
// Routing it through the server fixes all four at once: it always has
// network access, cached responses are shared across every client watching
// the same trip, and a single slow/blocked upstream degrades gracefully
// instead of hanging the UI.

import { Router } from "express";
import { cacheGet, cacheSet } from "../cache.js";
import { lookupCurrency } from "../countryCurrency.js";

const router = Router();

const WEATHER_TTL = 5 * 60 * 1000;   // matches the app's 5-minute weather refresh
const FX_TTL = 3 * 60 * 1000;        // matches the app's 3-minute currency refresh
const POI_TTL = 30 * 60 * 1000;      // place listings barely change; cache generously
const NEWS_TTL = 3 * 60 * 1000;
const GEOCODE_TTL = 24 * 60 * 60 * 1000;

async function fetchJson(url, init, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, init, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// TCMB (T.C. Merkez Bankası) publishes an official daily XML feed of buy/sell
// rates — the authoritative source for TRY conversions. No API key, no rate
// limiting concerns (it's a government data feed, not a metered API).
async function fetchTcmbRate(code) {
  const xml = await fetchText("https://www.tcmb.gov.tr/kurlar/today.xml", {}, 8000);
  const block = xml.match(new RegExp(`<Currency[^>]*Kod="${code}"[^>]*>([\\s\\S]*?)</Currency>`));
  if (!block) throw new Error("TCMB listesinde bu para birimi yok");
  const unit = parseFloat((block[1].match(/<Unit>([\d.]+)<\/Unit>/) || [])[1] || "1");
  const sellStr = (block[1].match(/<ForexSelling>([\d.,]+)<\/ForexSelling>/) || [])[1];
  if (!sellStr) throw new Error("TCMB satış kuru bulunamadı");
  const sell = parseFloat(sellStr.replace(",", "."));
  if (!sell) throw new Error("TCMB kuru geçersiz");
  return sell / unit;
}

router.get("/geocode", async (req, res) => {
  const { city, country } = req.query;
  if (!city) return res.status(400).json({ error: "city gerekli" });
  const key = `geo:${city}:${country || ""}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ...cached, cached: true });
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=8&language=tr&format=json`;
    const data = await fetchJson(url);
    if (!data.results?.length) return res.status(404).json({ error: "Şehir bulunamadı" });
    const cLower = (country || "").toLocaleLowerCase("tr-TR");
    const best = data.results.find(r => (r.country || "").toLocaleLowerCase("tr-TR").includes(cLower)
      || cLower.includes((r.country || "").toLocaleLowerCase("tr-TR"))) || data.results[0];
    const out = { lat: best.latitude, lon: best.longitude, timezone: best.timezone, resolvedCity: best.name, resolvedCountry: best.country };
    cacheSet(key, out, GEOCODE_TTL);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Geocoding servisine ulaşılamadı", detail: String(e) });
  }
});

router.get("/weather", async (req, res) => {
  const { lat, lon, timezone } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat/lon gerekli" });
  const key = `weather:${lat}:${lon}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ...cached, cached: true });
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
      `&forecast_days=7&timezone=${encodeURIComponent(timezone || "auto")}`;
    const data = await fetchJson(url);
    const daily = (data.daily?.time || []).map((date, i) => ({
      date,
      code: data.daily.weather_code?.[i],
      tempMax: data.daily.temperature_2m_max?.[i],
      tempMin: data.daily.temperature_2m_min?.[i],
      precipitationChance: data.daily.precipitation_probability_max?.[i],
      windMax: data.daily.wind_speed_10m_max?.[i],
    }));
    const out = {
      temp: data.current?.temperature_2m, code: data.current?.weather_code,
      humidity: data.current?.relative_humidity_2m, wind: data.current?.wind_speed_10m,
      localTime: data.current?.time, timezone: data.timezone,
      daily,
    };
    cacheSet(key, out, WEATHER_TTL);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Hava durumu servisine ulaşılamadı", detail: String(e) });
  }
});

router.get("/fx", async (req, res) => {
  const { country } = req.query;
  if (!country) return res.status(400).json({ error: "country gerekli" });
  const key = `fx:${country}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ...cached, cached: true });
  try {
    let code = lookupCurrency(country);
    if (!code) {
      // Not in the static table (uncommon country) — try the live lookup as
      // a secondary attempt only, since it's known to be occasionally flaky.
      try {
        const curUrl = `https://restcountries.com/v3.1/name/${encodeURIComponent(country)}?fields=currencies,name`;
        const curData = await fetchJson(curUrl);
        const arr = Array.isArray(curData) ? curData : [curData];
        const match = arr.find(c => (c.name?.common || "").toLocaleLowerCase("tr-TR") === country.toLocaleLowerCase("tr-TR")) || arr[0];
        code = Object.keys(match.currencies || {})[0];
      } catch { /* fall through to 404 below */ }
    }
    if (!code) return res.status(404).json({ error: "Para birimi bulunamadı" });
    if (code === "TRY") {
      const out = { code, rate: 1, inverse: 1, source: "TRY" };
      cacheSet(key, out, FX_TTL);
      return res.json(out);
    }
    let rate, source;
    try {
      rate = await fetchTcmbRate(code);
      source = "TCMB";
    } catch {
      // TCMB doesn't list every currency (mainly majors) and can occasionally
      // be unreachable — three independent, architecturally different rate
      // sources raced in parallel as a fallback. The jsDelivr one isn't a
      // live API at all — it's a static JSON file on a CDN (the same
      // infrastructure npm packages are served from), updated daily via
      // GitHub Actions, which is far harder to rate-limit/block than a
      // normal API server.
      const lc = code.toLowerCase();
      rate = await Promise.any([
        fetchJson(`https://api.frankfurter.app/latest?from=${code}&to=TRY`, {}, 8000)
          .then(d => d.rates?.TRY).then(r => { if (!r) throw new Error("no rate"); return r; }),
        fetchJson(`https://open.er-api.com/v6/latest/${code}`, {}, 8000)
          .then(d => d.rates?.TRY).then(r => { if (!r) throw new Error("no rate"); return r; }),
        fetchJson(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${lc}.json`, {}, 8000)
          .then(d => d[lc]?.try).then(r => { if (!r) throw new Error("no rate"); return r; }),
      ]);
      source = "diger";
    }
    const out = { code, rate, inverse: 1 / rate, source };
    cacheSet(key, out, FX_TTL);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Kur servisine ulaşılamadı", detail: String(e) });
  }
});

router.get("/poi", async (req, res) => {
  const { lat, lon, nocache } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat/lon gerekli" });
  const key = `poi:${lat}:${lon}`;
  if (!nocache) {
    const cached = cacheGet(key);
    if (cached) return res.json({ ...cached, cached: true });
  }
  const query = `[out:json][timeout:18];(
    node["amenity"="restaurant"](around:4000,${lat},${lon});
    node["amenity"="cafe"](around:4000,${lat},${lon});
    node["amenity"="bar"](around:4000,${lat},${lon});
    node["amenity"="pub"](around:4000,${lat},${lon});
    node["tourism"="museum"](around:4000,${lat},${lon});
    node["tourism"="attraction"](around:4000,${lat},${lon});
    node["tourism"="hotel"](around:4000,${lat},${lon});
    node["tourism"="hostel"](around:4000,${lat},${lon});
    node["tourism"="guest_house"](around:4000,${lat},${lon});
    node["shop"~"mall|department_store|clothes|general"](around:4000,${lat},${lon});
    node["shop"~"gift|souvenir"](around:4000,${lat},${lon});
  );out body 180;`;
  const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.openstreetmap.ru/api/interpreter"];

  function categorizeOverpass(data) {
    const cats = { restaurant: [], cafe: [], bar: [], museum: [], attraction: [], lodging: [], shopping: [], gift: [] };
    for (const el of data.elements || []) {
      const name = el.tags?.name;
      if (!name) continue;
      if (el.tags.amenity === "restaurant") cats.restaurant.push(name);
      else if (el.tags.amenity === "cafe") cats.cafe.push(name);
      else if (el.tags.amenity === "bar" || el.tags.amenity === "pub") cats.bar.push(name);
      else if (el.tags.tourism === "museum") cats.museum.push(name);
      else if (el.tags.tourism === "attraction") cats.attraction.push(name);
      else if (["hotel", "hostel", "guest_house"].includes(el.tags.tourism)) cats.lodging.push(name);
      else if (el.tags.shop === "gift" || el.tags.shop === "souvenir") cats.gift.push(name);
      else if (el.tags.shop) cats.shopping.push(name);
    }
    Object.keys(cats).forEach(k => cats[k] = [...new Set(cats[k])].slice(0, 30));
    return { ...cats, _source: "overpass" };
  }

  // Geoapify Places — a key-based alternative to Overpass. Free tier (no
  // credit card): https://myprojects.geoapify.com. Unlike keyless Overpass,
  // a per-key API is far less likely to be blanket-blocked for a whole
  // hosting provider's IP range, since abuse is tied to individual keys
  // rather than shared anonymous traffic. Only participates in the race
  // below if GEOAPIFY_API_KEY is actually set.
  async function fetchGeoapify() {
    const apiKey = process.env.GEOAPIFY_API_KEY;
    if (!apiKey) throw new Error("Geoapify not configured");
    // Broadened from narrow subcategories (e.g. only "accommodation.hotel")
    // to their parent categories — Geoapify nests many subtypes under each
    // (apartments, chalets, department stores, marketplaces, etc.) that the
    // narrow list was silently missing, which is why lodging/shopping were
    // coming back thin even with a working key. Also uses a bigger radius
    // than Overpass (8km vs 4km) since Geoapify isn't at risk of the same
    // blocking/timeout issues that keep the OSM query radius conservative.
    const categories = [
      "catering.restaurant", "catering.cafe", "catering.bar", "catering.pub",
      "entertainment.museum", "entertainment.culture", "tourism.sights",
      "accommodation",
      "commercial.gift_and_souvenir", "commercial",
    ].join(",");
    const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=circle:${lon},${lat},8000&limit=150&apiKey=${apiKey}`;
    const data = await fetchJson(url, {}, 10000);
    const cats = { restaurant: [], cafe: [], bar: [], museum: [], attraction: [], lodging: [], shopping: [], gift: [] };
    for (const f of data.features || []) {
      const p = f.properties || {};
      const name = p.name;
      if (!name) continue;
      const c = p.categories || [];
      if (c.includes("catering.restaurant")) cats.restaurant.push(name);
      else if (c.includes("catering.cafe")) cats.cafe.push(name);
      else if (c.some(x => x === "catering.bar" || x === "catering.pub")) cats.bar.push(name);
      else if (c.some(x => x === "entertainment.museum" || x === "entertainment.culture")) cats.museum.push(name);
      else if (c.includes("tourism.sights")) cats.attraction.push(name);
      else if (c.some(x => x.startsWith("accommodation"))) cats.lodging.push(name);
      else if (c.includes("commercial.gift_and_souvenir")) cats.gift.push(name);
      else if (c.some(x => x.startsWith("commercial"))) cats.shopping.push(name);
    }
    Object.keys(cats).forEach(k => cats[k] = [...new Set(cats[k])].slice(0, 30));
    return { ...cats, _source: "geoapify" };
  }

  try {
    // Race every available source at once — whichever answers first (and
    // isn't blocked) wins. Geoapify only enters the race if a key is set.
    const racers = endpoints.map(ep =>
      fetchJson(ep, { method: "POST", body: "data=" + encodeURIComponent(query) }, 16000).then(categorizeOverpass)
    );
    racers.push(fetchGeoapify());
    const cats = await Promise.any(racers);
    cacheSet(key, cats, POI_TTL);
    return res.json(cats);
  } catch { /* every source failed — try Wikipedia as a last, partial resort */
    try {
      // Wikipedia runs on entirely different infrastructure than the OSM/
      // Overpass ecosystem, so if all three Overpass mirrors are down/
      // throttled together (they can share upstream issues), this is a
      // genuinely separate fallback rather than another flavor of the same
      // failure. It only covers landmarks (Wikipedia has no restaurant/cafe
      // data), so those categories stay empty here. Also: Wikipedia gives us
      // no way to tell a museum apart from a historical event or a strait,
      // so we do NOT fake-split results into "museum" vs "attraction" —
      // that produced things like "Battle of Chios" mislabeled as a museum.
      // A light keyword filter drops the most obviously non-visitable
      // articles instead, and everything that passes goes into one
      // honestly-labeled "attraction" bucket.
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=8000&gslimit=30&format=json&origin=*`;
      const wikiData = await fetchJson(wikiUrl, {}, 8000);
      const EXCLUDE_PATTERN = /\b(battle|war|massacre|strait|siege|earthquake|election|list of|demograph)\b/i;
      const names = (wikiData.query?.geosearch || [])
        .map(p => p.title)
        .filter(t => !EXCLUDE_PATTERN.test(t));
      if (names.length) {
        const cats = { restaurant: [], cafe: [], bar: [], museum: [], attraction: names.slice(0, 30), lodging: [], shopping: [], gift: [] };
        cacheSet(key, cats, POI_TTL);
        return res.json(cats);
      }
    } catch { /* fall through to 502 below */ }
  }
  res.status(502).json({ error: "Yer servisine ulaşılamadı" });
});

router.get("/news", async (req, res) => {
  const { country } = req.query;
  if (!country) return res.status(400).json({ error: "country gerekli" });
  const key = `news:${country}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ items: cached, cached: true });
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(country)}&hl=tr&gl=TR&ceid=TR:tr`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res2 = await fetch(rssUrl, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!res2.ok) throw new Error(`upstream ${res2.status}`);
    const text = await res2.text();
    const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(m => {
      const block = m[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      return { title: title.replace(/^<!\[CDATA\[|\]\]>$/g, ""), link };
    });
    cacheSet(key, items, NEWS_TTL);
    res.json({ items });
  } catch (e) {
    res.status(502).json({ error: "Haber servisine ulaşılamadı", detail: String(e) });
  }
});

export default router;
