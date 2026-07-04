// countryCurrency.js — static country-name → ISO 4217 currency code table.
//
// This used to be resolved by calling restcountries.com on every request.
// That was an architecture mistake: a country's currency is static reference
// data, not something that needs a live API call at all — but relying on
// restcountries.com meant every currency lookup depended on a third public
// API's uptime, and it turned out to be unreliable enough that it was
// silently causing "canlı kur" to fail far more often than actual Render
// cold-starts did. Removing the live dependency for this specific lookup
// removes that whole failure mode. Only the actual exchange RATE (which
// really does change) still hits a live API (Frankfurter/ECB).
//
// Keys are normalized (lowercase, Turkish diacritics folded) so lookups are
// forgiving of accents/casing. Covers the countries people realistically
// type when planning a trip; unmatched countries fall back to restcountries
// as a secondary attempt so obscure destinations still have a chance.

export const normalizeTxt = (s) => (s || "")
  .toLocaleLowerCase("tr-TR")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/ı/g, "i")
  .trim();

const TABLE = {
  turkiye: "TRY", turkey: "TRY",
  yunanistan: "EUR", greece: "EUR",
  italya: "EUR", italy: "EUR",
  ispanya: "EUR", spain: "EUR",
  fransa: "EUR", france: "EUR",
  almanya: "EUR", germany: "EUR",
  hollanda: "EUR", netherlands: "EUR",
  belcika: "EUR", belgium: "EUR",
  portekiz: "EUR", portugal: "EUR",
  avusturya: "EUR", austria: "EUR",
  irlanda: "EUR", ireland: "EUR",
  finlandiya: "EUR", finland: "EUR",
  malta: "EUR",
  kibris: "EUR", cyprus: "EUR",
  slovenya: "EUR", slovenia: "EUR",
  slovakya: "EUR", slovakia: "EUR",
  estonya: "EUR", estonia: "EUR",
  letonya: "EUR", latvia: "EUR",
  litvanya: "EUR", lithuania: "EUR",
  luksemburg: "EUR", luxembourg: "EUR",

  isvicre: "CHF", switzerland: "CHF",
  ingiltere: "GBP", "birlesik krallik": "GBP", uk: "GBP", "united kingdom": "GBP", england: "GBP",
  norvec: "NOK", norway: "NOK",
  isvec: "SEK", sweden: "SEK",
  danimarka: "DKK", denmark: "DKK",
  izlanda: "ISK", iceland: "ISK",
  polonya: "PLN", poland: "PLN",
  cekya: "CZK", "cek cumhuriyeti": "CZK", czechia: "CZK",
  macaristan: "HUF", hungary: "HUF",
  hirvatistan: "EUR", croatia: "EUR",
  sirbistan: "RSD", serbia: "RSD",
  bulgaristan: "BGN", bulgaria: "BGN",
  romanya: "RON", romania: "RON",
  arnavutluk: "ALL", albania: "ALL",
  karadag: "EUR", montenegro: "EUR",
  bosna: "BAM", "bosna hersek": "BAM", bosnia: "BAM",
  makedonya: "MKD", "kuzey makedonya": "MKD",
  ukrayna: "UAH", ukraine: "UAH",
  rusya: "RUB", russia: "RUB",
  gurcistan: "GEL", georgia: "GEL",
  azerbaycan: "AZN", azerbaijan: "AZN",
  ermenistan: "AMD", armenia: "AMD",

  amerika: "USD", "abd": "USD", "amerika birlesik devletleri": "USD", usa: "USD", "united states": "USD",
  kanada: "USD", canada: "CAD",
  meksika: "MXN", mexico: "MXN",
  brezilya: "BRL", brazil: "BRL",
  arjantin: "ARS", argentina: "ARS",
  sili: "CLP", chile: "CLP",
  peru: "PEN",
  kolombiya: "COP", colombia: "COP",

  japonya: "JPY", japan: "JPY",
  cin: "CNY", china: "CNY",
  "guney kore": "KRW", "south korea": "KRW",
  tayland: "THB", thailand: "THB",
  vietnam: "VND",
  endonezya: "IDR", indonesia: "IDR",
  malezya: "MYR", malaysia: "MYR",
  singapur: "SGD", singapore: "SGD",
  filipinler: "PHP", philippines: "PHP",
  hindistan: "INR", india: "INR",
  pakistan: "PKR",
  "sri lanka": "LKR",
  nepal: "NPR",

  "birlesik arap emirlikleri": "AED", "bae": "AED", "dubai": "AED", uae: "AED",
  katar: "QAR", qatar: "QAR",
  "suudi arabistan": "SAR", "saudi arabia": "SAR",
  umman: "OMR", oman: "OMR",
  bahreyn: "BHD", bahrain: "BHD",
  kuveyt: "KWD", kuwait: "KWD",
   urdun: "JOD", jordan: "JOD",
  lubnan: "LBP", lebanon: "LBP",
  israil: "ILS", israel: "ILS",
  misir: "EGP", egypt: "EGP",
  fas: "MAD", morocco: "MAD",
  tunus: "TND", tunisia: "TND",
  "guney afrika": "ZAR", "south africa": "ZAR",
  kenya: "KES",
  fas2: "MAD",

  avustralya: "AUD", australia: "AUD",
  "yeni zelanda": "NZD", "new zealand": "NZD",
};

export function lookupCurrency(country) {
  const key = normalizeTxt(country);
  if (TABLE[key]) return TABLE[key];
  // fuzzy: try substring match either direction (e.g. "birleşik krallık (i̇ngiltere)")
  const found = Object.keys(TABLE).find(k => key.includes(k) || k.includes(key));
  return found ? TABLE[found] : null;
}
