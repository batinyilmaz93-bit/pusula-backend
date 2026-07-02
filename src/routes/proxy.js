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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m&timezone=${encodeURIComponent(timezone || "auto")}`;
    const data = await fetchJson(url);
    const out = {
      temp: data.current?.temperature_2m, code: data.current?.weather_code,
      humidity: data.current?.relative_humidity_2m, wind: data.current?.wind_speed_10m,
      localTime: data.current?.time, timezone: data.timezone,
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
    const curUrl = `https://restcountries.com/v3.1/name/${encodeURIComponent(country)}?fields=currencies,name`;
    const curData = await fetchJson(curUrl);
    const arr = Array.isArray(curData) ? curData : [curData];
    const match = arr.find(c => (c.name?.common || "").toLocaleLowerCase("tr-TR") === country.toLocaleLowerCase("tr-TR")) || arr[0];
    const code = Object.keys(match.currencies || {})[0];
    if (!code) return res.status(404).json({ error: "Para birimi bulunamadı" });
    let rate = 1, inverse = 1;
    if (code !== "TRY") {
      const rateData = await fetchJson(`https://api.frankfurter.app/latest?from=${code}&to=TRY`);
      rate = rateData.rates?.TRY;
      if (!rate) return res.status(502).json({ error: "Kur bulunamadı" });
      inverse = 1 / rate;
    }
    const out = { code, rate, inverse };
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
  const query = `[out:json][timeout:25];(
    node["amenity"="restaurant"](around:5000,${lat},${lon});
    node["amenity"="cafe"](around:5000,${lat},${lon});
    node["tourism"="museum"](around:5000,${lat},${lon});
    node["shop"~"mall|department_store|clothes|gift|general"](around:5000,${lat},${lon});
  );out body 150;`;
  const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  for (const ep of endpoints) {
    try {
      const data = await fetchJson(ep, { method: "POST", body: "data=" + encodeURIComponent(query) }, 15000);
      const cats = { restaurant: [], cafe: [], museum: [], shopping: [] };
      for (const el of data.elements || []) {
        const name = el.tags?.name;
        if (!name) continue;
        if (el.tags.amenity === "restaurant") cats.restaurant.push(name);
        else if (el.tags.amenity === "cafe") cats.cafe.push(name);
        else if (el.tags.tourism === "museum") cats.museum.push(name);
        else if (el.tags.shop) cats.shopping.push(name);
      }
      Object.keys(cats).forEach(k => cats[k] = [...new Set(cats[k])].slice(0, 30));
      cacheSet(key, cats, POI_TTL);
      return res.json(cats);
    } catch { /* try next endpoint */ }
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
