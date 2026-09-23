// Einfache Tests ohne Framework: node tests/logic.test.js
const L = require('../js/logic.js');

let fails = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { fails++; console.error(`FAIL ${msg}\n  erwartet: ${e}\n  erhalten: ${a}`); }
  else console.log(`ok   ${msg}`);
}
function ok(cond, msg) {
  if (!cond) { fails++; console.error(`FAIL ${msg}`); } else console.log(`ok   ${msg}`);
}

// --- Datum ---
eq(L.toISODate(L.getMonday(new Date(2026, 6, 7))), '2026-07-06', 'Montag von Di 7.7.2026');
eq(L.toISODate(L.getMonday(new Date(2026, 6, 12))), '2026-07-06', 'Montag von So 12.7.2026');
eq(L.toISODate(L.getMonday(new Date(2026, 6, 6))), '2026-07-06', 'Montag von Mo selbst');
eq(L.toISODate(L.addDays(L.fromISODate('2026-07-06'), 6)), '2026-07-12', 'addDays +6');

// --- Einkaufsliste: Skalierung und Zusammenfassung ---
const entries = [
  { // Spaghetti für 6 Personen, Basis 4 -> Faktor 1.5
    personen: 6,
    recipe: { name: 'Spaghetti', portionen_basis: 4 },
    ingredients: [
      { name: 'Spaghetti', menge: 400, einheit: 'g' },
      { name: 'Tomaten', menge: 2, einheit: 'Dosen' },
      { name: 'Parmesan', menge: null, einheit: '' },
    ],
  },
  { // Salat für 2 Personen, Basis 4 -> Faktor 0.5
    personen: 2,
    recipe: { name: 'Salat', portionen_basis: 4 },
    ingredients: [
      { name: 'tomaten', menge: 4, einheit: 'dosen' }, // gleiche Zutat, andere Schreibweise
      { name: 'Gurke', menge: 1, einheit: 'Stk' },
    ],
  },
];
const list = L.aggregateShopping(entries);
const tomaten = list.find((i) => i.key === 'tomaten|dosen');
ok(tomaten, 'Tomaten zusammengefasst (Name+Einheit case-insensitiv)');
eq(tomaten.menge, 2 * 1.5 + 4 * 0.5, 'Tomaten: 2×1.5 + 4×0.5 = 5');
eq(list.find((i) => i.key === 'spaghetti|g').menge, 600, 'Spaghetti 400g × 6/4 = 600g');
eq(list.find((i) => i.key === 'gurke|stk').menge, 0.5, 'Gurke 1 × 2/4 = 0.5');
eq(list.find((i) => i.key === 'parmesan|').menge, null, 'Zutat ohne Menge bleibt ohne Menge');
eq(L.fmtMenge(0.5), '0,5', 'Mengenformat Komma');
eq(L.fmtMenge(600), '600', 'Mengenformat ganzzahlig');
ok(tomaten.rezepte.includes('Spaghetti') && tomaten.rezepte.includes('Salat'), 'Rezept-Herkunft gesammelt');

// --- Auto-Vorschlag ---
const rezepte = [
  { id: 'r1', typ: 'fleisch' },
  { id: 'r2', typ: 'vegi' },
  { id: 'r3', typ: 'fisch' },
  { id: 'r4', typ: 'vegi' },
];

// Sperrfrist blockiert kürzlich Gekochtes
let res = L.chooseSuggestion({
  slotDatum: '2026-07-08',
  rezepte,
  historie: [
    { datum: '2026-07-01', recipe_id: 'r1' }, // vor 7 Tagen -> gesperrt bei 3 Wochen
    { datum: '2026-05-01', recipe_id: 'r3' }, // lange her -> frei
  ],
  wochenBelegung: [],
  sperrWochen: 3,
});
ok(res && res.recipe.id !== 'r1', 'Rezept in Sperrfrist wird nicht vorgeschlagen');
ok(res && res.gelockert === false, 'keine Lockerung nötig');

// Balance: Woche voller Fleisch -> nicht Fleisch vorschlagen
res = L.chooseSuggestion({
  slotDatum: '2026-07-08',
  rezepte,
  historie: [],
  wochenBelegung: [ { recipe_id: 'x1', typ: 'fleisch' }, { recipe_id: 'x2', typ: 'fleisch' } ],
  sperrWochen: 3,
});
ok(res && res.recipe.typ !== 'fleisch', 'Typ-Balance: dominanter Typ wird gemieden');

// Bereits in der Woche geplantes Rezept nie doppelt
res = L.chooseSuggestion({
  slotDatum: '2026-07-08',
  rezepte: [{ id: 'r1', typ: 'vegi' }, { id: 'r2', typ: 'vegi' }],
  historie: [],
  wochenBelegung: [{ recipe_id: 'r1', typ: 'vegi' }],
  sperrWochen: 3,
});
eq(res.recipe.id, 'r2', 'kein Duplikat innerhalb der Woche');

// Pool zu klein -> Sperre wird gelockert statt leer zu lassen
res = L.chooseSuggestion({
  slotDatum: '2026-07-08',
  rezepte: [{ id: 'r1', typ: 'vegi' }],
  historie: [{ datum: '2026-07-01', recipe_id: 'r1' }],
  wochenBelegung: [],
  sperrWochen: 3,
});
ok(res && res.recipe.id === 'r1' && res.gelockert === true, 'Sperre wird gelockert, Hinweis gesetzt');

// Gar nichts verfügbar (einziges Rezept schon in der Woche) -> null
res = L.chooseSuggestion({
  slotDatum: '2026-07-08',
  rezepte: [{ id: 'r1', typ: 'vegi' }],
  historie: [],
  wochenBelegung: [{ recipe_id: 'r1', typ: 'vegi' }],
  sperrWochen: 3,
});
eq(res, null, 'kein Vorschlag möglich -> null');

// Buffet-Einträge (recipe_id null) in der Historie sperren nichts und lockern nichts
res = L.chooseSuggestion({
  slotDatum: '2026-07-08',
  rezepte: [{ id: 'r1', typ: 'vegi' }],
  historie: [
    { datum: '2026-07-06', recipe_id: null },
    { datum: '2026-07-07', recipe_id: null },
  ],
  wochenBelegung: [],
  sperrWochen: 3,
});
ok(res && res.recipe.id === 'r1' && res.gelockert === false, 'Buffet in der Historie beeinflusst die Sperre nicht');

console.log(fails === 0 ? '\nAlle Tests bestanden.' : `\n${fails} Test(s) fehlgeschlagen.`);
process.exit(fails === 0 ? 0 : 1);
