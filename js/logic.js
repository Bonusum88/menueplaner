// =============================================================
// logic.js – reine Logikfunktionen ohne DOM/Supabase-Abhängigkeit.
// Wird im Browser geladen und kann in Node getestet werden.
// =============================================================

/** Montag der Woche des übergebenen Datums (lokale Zeit). */
function getMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=So, 1=Mo, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Datum als ISO-String yyyy-mm-dd (lokale Zeit, ohne Zeitzone-Verschiebung). */
function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO-String -> Date (lokale Zeit). */
function fromISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Datum um n Tage verschieben (neues Date-Objekt). */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Anzeigeformat z.B. "Mo 7.7." */
const WOCHENTAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WOCHENTAGE_KURZ = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
function fmtShort(d) {
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}

/** Schlüssel für die Zusammenfassung gleicher Zutaten (Name + Einheit, normalisiert). */
function ingredientKey(name, einheit) {
  const n = (name || '').trim().toLowerCase();
  const e = (einheit || '').trim().toLowerCase();
  return `${n}|${e}`;
}

/**
 * Einkaufsliste aus Plan-Einträgen berechnen.
 * entries: [{ personen, recipe: { name, portionen_basis }, ingredients: [{name, menge, einheit}] }]
 * Skalierung: menge × personen / portionen_basis.
 * Rückgabe: sortierte Liste [{ key, name, einheit, menge|null, rezepte: [..] }]
 */
function aggregateShopping(entries) {
  const map = new Map();
  for (const entry of entries) {
    const basis = entry.recipe && entry.recipe.portionen_basis > 0 ? entry.recipe.portionen_basis : 4;
    const faktor = (entry.personen || basis) / basis;
    for (const ing of entry.ingredients || []) {
      if (!ing.name || !ing.name.trim()) continue;
      const key = ingredientKey(ing.name, ing.einheit);
      let item = map.get(key);
      if (!item) {
        item = {
          key,
          name: ing.name.trim(),
          einheit: (ing.einheit || '').trim(),
          menge: null,
          rezepte: new Set(),
        };
        map.set(key, item);
      }
      if (ing.menge !== null && ing.menge !== undefined && ing.menge !== '') {
        const skaliert = Number(ing.menge) * faktor;
        item.menge = (item.menge || 0) + skaliert;
      }
      if (entry.recipe && entry.recipe.name) item.rezepte.add(entry.recipe.name);
    }
  }
  const list = [...map.values()].map((i) => ({ ...i, rezepte: [...i.rezepte] }));
  list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return list;
}

/** Menge hübsch formatieren (max. 2 Dezimalstellen, ohne Nachnullen). */
function fmtMenge(m) {
  if (m === null || m === undefined) return '';
  const r = Math.round(m * 100) / 100;
  return String(r).replace('.', ',');
}

/**
 * Auto-Vorschlag für einen Slot.
 *
 * @param {Object} p
 * @param {string} p.slotDatum        ISO-Datum des Slots
 * @param {Array}  p.rezepte          alle Rezepte [{id, typ, favorit, ...}]
 * @param {Array}  p.historie         vergangene/aktuelle Plan-Einträge [{datum, recipe_id}]
 * @param {Array}  p.wochenBelegung   Einträge der gerade geplanten Woche [{recipe_id, typ}]
 * @param {number} p.sperrWochen      eingestellte Wiederholungssperre in Wochen
 * @returns {null | {recipe, benutzteSperrWochen, gelockert}}
 *
 * Regeln:
 *  - Kein Rezept, das innerhalb der Sperrfrist vor dem Slot-Datum bereits geplant war.
 *  - Kein Rezept, das in der aktuellen Woche schon eingeplant ist.
 *  - Typ-Balance: bevorzugt den in der Woche am wenigsten vertretenen Typ.
 *  - Reicht der Pool nicht, wird die Sperre schrittweise gelockert (W-1, W-2, ... 0);
 *    das Ergebnis meldet, ob und wie stark gelockert wurde.
 */
function chooseSuggestion({ slotDatum, rezepte, historie, wochenBelegung, sperrWochen }) {
  if (!rezepte || rezepte.length === 0) return null;
  const slot = fromISODate(slotDatum);
  const belegteIds = new Set((wochenBelegung || []).map((e) => e.recipe_id));

  // Typ-Zähler der Woche für die Balance
  const typCount = { fleisch: 0, vegi: 0, fisch: 0 };
  for (const e of wochenBelegung || []) {
    if (e.typ && typCount[e.typ] !== undefined) typCount[e.typ]++;
  }
  // Nur Typen berücksichtigen, für die es überhaupt Rezepte gibt
  const vorhandeneTypen = [...new Set(rezepte.map((r) => r.typ))];
  const typReihenfolge = vorhandeneTypen
    .map((t) => ({ t, c: typCount[t] || 0, rnd: Math.random() }))
    .sort((a, b) => a.c - b.c || a.rnd - b.rnd)
    .map((x) => x.t);

  for (let w = sperrWochen; w >= 0; w--) {
    const grenze = addDays(slot, -7 * w);
    const gesperrt = new Set();
    for (const h of historie || []) {
      const d = fromISODate(h.datum);
      if (w > 0 && d >= grenze && d <= slot) gesperrt.add(h.recipe_id);
    }
    const pool = rezepte.filter((r) => !gesperrt.has(r.id) && !belegteIds.has(r.id));
    if (pool.length === 0) continue;

    for (const typ of typReihenfolge) {
      const typPool = pool.filter((r) => r.typ === typ);
      if (typPool.length > 0) {
        const recipe = typPool[Math.floor(Math.random() * typPool.length)];
        return { recipe, benutzteSperrWochen: w, gelockert: w < sperrWochen };
      }
    }
    // (theoretisch unerreichbar, da pool nicht leer)
    const recipe = pool[Math.floor(Math.random() * pool.length)];
    return { recipe, benutzteSperrWochen: w, gelockert: w < sperrWochen };
  }
  // Alles belegt/gesperrt selbst bei Sperre 0 (z.B. alle Rezepte schon in dieser Woche)
  return null;
}

// Export für Node-Tests (im Browser wirkungslos)
if (typeof module !== 'undefined') {
  module.exports = {
    getMonday, toISODate, fromISODate, addDays, ingredientKey,
    aggregateShopping, fmtMenge, chooseSuggestion, WOCHENTAGE, WOCHENTAGE_KURZ, fmtShort,
  };
}
