// =============================================================
// app.js – Menüplaner
// Auth, Navigation, Rezepte, Wochenplan, Auto-Vorschlag,
// Einkaufsliste, Historie, Einstellungen.
// Reine Logik (Datum, Aggregation, Vorschlag) liegt in logic.js.
// =============================================================
'use strict';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }, // Session bleibt im Browser
});

// ---------- Globaler Zustand ----------
const state = {
  view: 'plan',
  weekMonday: getMonday(new Date()), // gemeinsame Woche für Plan + Einkauf
  recipes: [],                       // inkl. ingredients
  lastCooked: new Map(),             // recipe_id -> ISO-Datum (letzte Vergangenheit)
  settings: { wiederholungssperre_wochen: 3, standard_personen: 4 },
  planEntries: [],                   // Einträge der angezeigten Woche
  recipeFilter: { typ: null, fav: false, tag: null, q: '' },
  picker: { typ: null, fav: false, q: '', onSelect: null },
  editorId: null,                    // null = neues Rezept
  shoppingChannel: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

const TYP_LABEL = { fleisch: 'Fleisch', vegi: 'Vegi', fisch: 'Fisch' };
const dotHtml = (typ) => `<i class="dot ${esc(typ)}" title="${TYP_LABEL[typ] || ''}"></i>`;

// =============================================================
// Auth
// =============================================================
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  setAuthed(!!session);
  sb.auth.onAuthStateChange((_event, s) => setAuthed(!!s));
}

function setAuthed(authed) {
  $('#view-login').classList.toggle('hidden', authed);
  $('#app').classList.toggle('hidden', !authed);
  if (authed) bootApp();
}

$('#login-btn').addEventListener('click', doLogin);
$('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
async function doLogin() {
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const err = $('#login-error');
  err.classList.add('hidden');
  if (!email || !password) { err.textContent = 'Bitte E-Mail und Passwort eingeben.'; err.classList.remove('hidden'); return; }
  $('#login-btn').disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $('#login-btn').disabled = false;
  if (error) {
    err.textContent = 'Anmeldung fehlgeschlagen. Bitte E-Mail und Passwort prüfen.';
    err.classList.remove('hidden');
  }
}

$('#logout-btn').addEventListener('click', async () => { await sb.auth.signOut(); });

// =============================================================
// App-Start nach Login
// =============================================================
let booted = false;
async function bootApp() {
  if (booted) return;
  booted = true;
  await loadSettings();
  await loadRecipes();
  subscribeShopping();
  showView('plan');
}

// =============================================================
// Navigation
// =============================================================
$$('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

function showView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  ['plan', 'recipes', 'shopping', 'history', 'settings'].forEach((v) => {
    $(`#view-${v}`).classList.toggle('hidden', v !== view);
  });
  if (view === 'plan') renderPlan();
  if (view === 'recipes') { refreshLastCooked().then(renderRecipeList); renderRecipeList(); }
  if (view === 'shopping') renderShopping();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
}

// =============================================================
// Einstellungen
// =============================================================
async function loadSettings() {
  const { data, error } = await sb.from('settings').select('*');
  if (error) { toast('Einstellungen konnten nicht geladen werden.'); return; }
  for (const row of data || []) {
    if (row.key === 'wiederholungssperre_wochen') state.settings.wiederholungssperre_wochen = parseInt(row.value, 10) || 0;
    if (row.key === 'standard_personen') state.settings.standard_personen = parseInt(row.value, 10) || 4;
  }
}

function renderSettings() {
  $('#set-sperre').value = state.settings.wiederholungssperre_wochen;
  $('#set-personen').value = state.settings.standard_personen;
}

$('#settings-save').addEventListener('click', async () => {
  const sperre = Math.max(0, parseInt($('#set-sperre').value, 10) || 0);
  const personen = Math.max(1, parseInt($('#set-personen').value, 10) || 4);
  const { error } = await sb.from('settings').upsert([
    { key: 'wiederholungssperre_wochen', value: String(sperre) },
    { key: 'standard_personen', value: String(personen) },
  ]);
  if (error) { toast('Speichern fehlgeschlagen.'); return; }
  state.settings.wiederholungssperre_wochen = sperre;
  state.settings.standard_personen = personen;
  toast('Einstellungen gespeichert.');
});

// =============================================================
// Rezepte laden / Liste / Formular
// =============================================================
async function loadRecipes() {
  const { data, error } = await sb
    .from('recipes')
    .select('*, ingredients(*)')
    .order('name');
  if (error) { toast('Rezepte konnten nicht geladen werden.'); return; }
  state.recipes = data || [];
}

/** "Zuletzt gekocht" pro Rezept aus der Historie (Einträge bis heute). */
async function refreshLastCooked() {
  const today = toISODate(new Date());
  const { data, error } = await sb
    .from('plan_entries')
    .select('recipe_id, datum')
    .lte('datum', today)
    .order('datum', { ascending: false })
    .limit(3000);
  if (error) return;
  state.lastCooked = new Map();
  for (const row of data || []) {
    if (!state.lastCooked.has(row.recipe_id)) state.lastCooked.set(row.recipe_id, row.datum);
  }
}

function fmtLastCooked(recipeId) {
  const iso = state.lastCooked.get(recipeId);
  if (!iso) return 'noch nie gekocht';
  const d = fromISODate(iso);
  return `zuletzt am ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

// --- Filter-Chips (Rezeptliste) ---
$$('#recipe-filters [data-filter-typ]').forEach((chip) => chip.addEventListener('click', () => {
  const typ = chip.dataset.filterTyp;
  state.recipeFilter.typ = state.recipeFilter.typ === typ ? null : typ;
  renderRecipeList();
}));
$('#filter-fav').addEventListener('click', () => {
  state.recipeFilter.fav = !state.recipeFilter.fav;
  renderRecipeList();
});
$('#recipe-search').addEventListener('input', (e) => {
  state.recipeFilter.q = e.target.value.trim().toLowerCase();
  renderRecipeList();
});

function filteredRecipes(f) {
  return state.recipes.filter((r) => {
    if (f.typ && r.typ !== f.typ) return false;
    if (f.fav && !r.favorit) return false;
    if (f.tag && !(r.tags || []).includes(f.tag)) return false;
    if (f.q && !r.name.toLowerCase().includes(f.q)) return false;
    return true;
  });
}

function renderRecipeList() {
  const f = state.recipeFilter;
  // Chip-Zustände
  $$('#recipe-filters [data-filter-typ]').forEach((c) => c.classList.toggle('active', c.dataset.filterTyp === f.typ));
  $('#filter-fav').classList.toggle('active', f.fav);

  // Tag-Chips aus allen Rezepten
  const tags = [...new Set(state.recipes.flatMap((r) => r.tags || []))].sort((a, b) => a.localeCompare(b, 'de'));
  $('#recipe-tagchips').innerHTML = tags.map((t) =>
    `<button class="chip ${f.tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
  $$('#recipe-tagchips .chip').forEach((c) => c.addEventListener('click', () => {
    state.recipeFilter.tag = state.recipeFilter.tag === c.dataset.tag ? null : c.dataset.tag;
    renderRecipeList();
  }));

  const list = filteredRecipes(f);
  const box = $('#recipe-list');
  if (state.recipes.length === 0) {
    box.innerHTML = `<div class="empty-note">Noch keine Rezepte.<br>Mit «+ Neu» das erste Rezept anlegen.</div>`;
    return;
  }
  if (list.length === 0) {
    box.innerHTML = `<div class="empty-note">Kein Rezept passt zu diesem Filter.</div>`;
    return;
  }
  box.innerHTML = list.map((r) => {
    const meta = [
      TYP_LABEL[r.typ],
      (r.tags || []).join(', '),
      fmtLastCooked(r.id),
    ].filter(Boolean).join(' · ');
    return `
    <div class="recipe-item" data-id="${r.id}">
      <div class="recipe-main">
        <div class="recipe-name">${dotHtml(r.typ)}<span>${esc(r.name)}</span>
          ${r.rezept_link ? `<a href="${esc(r.rezept_link)}" target="_blank" rel="noopener" title="Rezept öffnen" data-stop>↗</a>` : ''}
        </div>
        <div class="recipe-meta">${esc(meta)}</div>
      </div>
      <button class="star ${r.favorit ? 'on' : ''}" data-star="${r.id}" aria-label="Favorit umschalten">★</button>
    </div>`;
  }).join('');

  $$('#recipe-list .recipe-item').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-star]') || e.target.closest('[data-stop]')) return;
    openEditor(el.dataset.id);
  }));
  $$('#recipe-list [data-star]').forEach((el) => el.addEventListener('click', async () => {
    const r = state.recipes.find((x) => x.id === el.dataset.star);
    const { error } = await sb.from('recipes').update({ favorit: !r.favorit }).eq('id', r.id);
    if (!error) { r.favorit = !r.favorit; renderRecipeList(); }
  }));
}

// --- Rezept-Formular ---
$('#recipe-new').addEventListener('click', () => openEditor(null));
$$('[data-close]').forEach((b) => b.addEventListener('click', () => $(`#${b.dataset.close}`).classList.add('hidden')));
$('#ed-add-ingredient').addEventListener('click', () => addIngredientRow());
$$('#ed-typ button').forEach((b) => b.addEventListener('click', () => {
  $$('#ed-typ button').forEach((x) => x.classList.toggle('active', x === b));
}));

function addIngredientRow(ing = {}) {
  const row = document.createElement('div');
  row.className = 'ing-row';
  row.innerHTML = `
    <input class="ing-name" type="text" placeholder="Zutat" value="${esc(ing.name || '')}">
    <input class="ing-menge" type="number" step="any" min="0" inputmode="decimal" placeholder="Menge" value="${ing.menge ?? ''}">
    <input class="ing-einheit" type="text" placeholder="Einheit" value="${esc(ing.einheit || '')}">
    <button class="btn icon" aria-label="Zutat entfernen">✕</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('#ed-ingredients').appendChild(row);
}

function openEditor(recipeId) {
  state.editorId = recipeId;
  const r = recipeId ? state.recipes.find((x) => x.id === recipeId) : null;
  $('#editor-title').textContent = r ? 'Rezept bearbeiten' : 'Neues Rezept';
  $('#ed-name').value = r ? r.name : '';
  $('#ed-tags').value = r ? (r.tags || []).join(', ') : '';
  $('#ed-link').value = r ? (r.rezept_link || '') : '';
  $('#ed-portionen').value = r ? r.portionen_basis : state.settings.standard_personen;
  $('#ed-favorit').checked = r ? r.favorit : false;
  $$('#ed-typ button').forEach((b) => b.classList.toggle('active', r && b.dataset.typ === r.typ));
  $('#ed-ingredients').innerHTML = '';
  (r?.ingredients || []).forEach((i) => addIngredientRow(i));
  if (!r) addIngredientRow();
  $('#ed-delete').classList.toggle('hidden', !r);
  $('#editor-error').classList.add('hidden');
  $('#editor').classList.remove('hidden');
}

$('#ed-save').addEventListener('click', async () => {
  const name = $('#ed-name').value.trim();
  const typBtn = $('#ed-typ button.active');
  const err = $('#editor-error');
  err.classList.add('hidden');
  if (!name) { err.textContent = 'Bitte einen Namen angeben.'; err.classList.remove('hidden'); return; }
  if (!typBtn) { err.textContent = 'Bitte einen Typ wählen (Fleisch, Vegi oder Fisch).'; err.classList.remove('hidden'); return; }

  const recipe = {
    name,
    typ: typBtn.dataset.typ,
    tags: $('#ed-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
    rezept_link: $('#ed-link').value.trim() || null,
    portionen_basis: Math.max(1, parseInt($('#ed-portionen').value, 10) || 4),
    favorit: $('#ed-favorit').checked,
  };
  const ings = $$('#ed-ingredients .ing-row').map((row) => ({
    name: row.querySelector('.ing-name').value.trim(),
    menge: row.querySelector('.ing-menge').value === '' ? null : Number(row.querySelector('.ing-menge').value),
    einheit: row.querySelector('.ing-einheit').value.trim() || null,
  })).filter((i) => i.name);

  let recipeId = state.editorId;
  if (recipeId) {
    const { error } = await sb.from('recipes').update(recipe).eq('id', recipeId);
    if (error) { err.textContent = 'Speichern fehlgeschlagen.'; err.classList.remove('hidden'); return; }
    await sb.from('ingredients').delete().eq('recipe_id', recipeId); // Zutaten ersetzen
  } else {
    const { data, error } = await sb.from('recipes').insert(recipe).select('id').single();
    if (error) { err.textContent = 'Speichern fehlgeschlagen.'; err.classList.remove('hidden'); return; }
    recipeId = data.id;
  }
  if (ings.length) {
    const { error } = await sb.from('ingredients').insert(ings.map((i) => ({ ...i, recipe_id: recipeId })));
    if (error) { err.textContent = 'Zutaten konnten nicht gespeichert werden.'; err.classList.remove('hidden'); return; }
  }
  $('#editor').classList.add('hidden');
  await loadRecipes();
  renderRecipeList();
  toast('Rezept gespeichert.');
});

$('#ed-delete').addEventListener('click', async () => {
  if (!state.editorId) return;
  if (!confirm('Rezept wirklich löschen? Zugehörige Planeinträge (auch vergangene) werden mitgelöscht.')) return;
  const { error } = await sb.from('recipes').delete().eq('id', state.editorId);
  if (error) { toast('Löschen fehlgeschlagen.'); return; }
  $('#editor').classList.add('hidden');
  await loadRecipes();
  renderRecipeList();
  toast('Rezept gelöscht.');
});

// =============================================================
// Wochenplan
// =============================================================
$('#plan-prev').addEventListener('click', () => shiftWeek(-7));
$('#plan-next').addEventListener('click', () => shiftWeek(7));
$('#plan-today').addEventListener('click', () => { state.weekMonday = getMonday(new Date()); renderPlan(); });
$('#shop-prev').addEventListener('click', () => { shiftWeek(-7, 'shopping'); });
$('#shop-next').addEventListener('click', () => { shiftWeek(7, 'shopping'); });
$('#shop-today').addEventListener('click', () => { state.weekMonday = getMonday(new Date()); renderShopping(); });

function shiftWeek(days, view = 'plan') {
  state.weekMonday = addDays(state.weekMonday, days);
  view === 'plan' ? renderPlan() : renderShopping();
}

function weekLabel(mon) {
  const sun = addDays(mon, 6);
  return `${fmtShort(mon)} – ${fmtShort(sun)}${sun.getFullYear() !== new Date().getFullYear() ? sun.getFullYear() : ''}`;
}

async function loadWeekEntries(mon) {
  const { data, error } = await sb
    .from('plan_entries')
    .select('*, recipe:recipes(id, name, typ, rezept_link, portionen_basis, ingredients(*))')
    .gte('datum', toISODate(mon))
    .lte('datum', toISODate(addDays(mon, 6)))
    .order('datum');
  if (error) { toast('Wochenplan konnte nicht geladen werden.'); return []; }
  return data || [];
}

async function renderPlan() {
  const mon = state.weekMonday;
  $('#plan-week-label').textContent = weekLabel(mon);
  $('#topbar-context').textContent = '';
  state.planEntries = await loadWeekEntries(mon);

  // Typ-Mix-Anzeige
  $('#plan-mix').innerHTML = state.planEntries
    .filter((e) => e.recipe)
    .map((e) => dotHtml(e.recipe.typ)).join('');

  const todayIso = toISODate(new Date());
  const box = $('#plan-days');
  box.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const iso = toISODate(d);
    const card = document.createElement('div');
    card.className = 'day-card' + (iso === todayIso ? ' today' : '');
    card.innerHTML = `
      <div class="day-letter"><b>${WOCHENTAGE_KURZ[i]}</b><small>${fmtShort(d)}</small></div>
      <div class="day-slots">
        ${slotHtml(iso, 'mittag')}
        ${slotHtml(iso, 'abend')}
      </div>`;
    box.appendChild(card);
  }
  bindSlotActions();
}

function slotHtml(iso, mahlzeit) {
  const entry = state.planEntries.find((e) => e.datum === iso && e.mahlzeit === mahlzeit);
  const label = mahlzeit === 'mittag' ? 'Mittag' : 'Abend';
  if (!entry || !entry.recipe) {
    return `
    <div class="slot" data-datum="${iso}" data-mahlzeit="${mahlzeit}">
      <div class="slot-head">
        <span class="slot-label">${label}</span>
        <span class="slot-empty">–</span>
      </div>
      <div class="slot-actions">
        <button class="btn" data-act="pick">＋ Wählen</button>
        <button class="btn" data-act="suggest">✦ Vorschlag</button>
      </div>
    </div>`;
  }
  const r = entry.recipe;
  const nameHtml = r.rezept_link
    ? `<a href="${esc(r.rezept_link)}" target="_blank" rel="noopener">${esc(r.name)}</a>`
    : `<span class="rname">${esc(r.name)}</span>`;
  return `
  <div class="slot" data-datum="${iso}" data-mahlzeit="${mahlzeit}" data-entry="${entry.id}">
    <div class="slot-head">
      <span class="slot-label">${label}</span>
      <span class="slot-recipe">${dotHtml(r.typ)}${nameHtml}</span>
    </div>
    <div class="slot-actions">
      <span class="stepper">
        <button data-act="minus" aria-label="Weniger Personen">−</button>
        <span>${entry.personen} P.</span>
        <button data-act="plus" aria-label="Mehr Personen">＋</button>
      </span>
      <button class="btn" data-act="pick" aria-label="Rezept wechseln">✎</button>
      <button class="btn" data-act="suggest" aria-label="Neuer Vorschlag">✦</button>
      <button class="btn" data-act="remove" aria-label="Slot leeren">✕</button>
    </div>
  </div>`;
}

function bindSlotActions() {
  $$('#plan-days [data-act]').forEach((btn) => btn.addEventListener('click', async () => {
    const slot = btn.closest('.slot');
    const datum = slot.dataset.datum;
    const mahlzeit = slot.dataset.mahlzeit;
    const entryId = slot.dataset.entry || null;
    const act = btn.dataset.act;

    if (act === 'pick') {
      openPicker(`${WOCHENTAGE[fromISODate(datum).getDay() === 0 ? 6 : fromISODate(datum).getDay() - 1]} ${mahlzeit === 'mittag' ? 'Mittag' : 'Abend'}`,
        (recipe) => setSlot(datum, mahlzeit, recipe.id));
    }
    if (act === 'suggest') await suggestSlot(datum, mahlzeit);
    if (act === 'remove' && entryId) {
      await sb.from('plan_entries').delete().eq('id', entryId);
      renderPlan();
    }
    if ((act === 'plus' || act === 'minus') && entryId) {
      const entry = state.planEntries.find((e) => e.id === entryId);
      const p = Math.max(1, (entry.personen || 1) + (act === 'plus' ? 1 : -1));
      await sb.from('plan_entries').update({ personen: p }).eq('id', entryId);
      renderPlan();
    }
  }));
}

async function setSlot(datum, mahlzeit, recipeId, personen = null) {
  const p = personen ?? state.settings.standard_personen;
  const { error } = await sb.from('plan_entries')
    .upsert({ datum, mahlzeit, recipe_id: recipeId, personen: p }, { onConflict: 'datum,mahlzeit' });
  if (error) { toast('Slot konnte nicht gespeichert werden.'); return; }
  renderPlan();
}

// --- Auto-Vorschlag ---
async function loadHistoryForSuggestion(mon) {
  // Historie im relevanten Rückblick: Sperrfrist + Puffer vor Wochenstart
  const weeks = state.settings.wiederholungssperre_wochen;
  const from = toISODate(addDays(mon, -7 * (weeks + 1)));
  const to = toISODate(addDays(mon, 13)); // inkl. Folgewoche, falls vorgeplant
  const { data } = await sb.from('plan_entries')
    .select('datum, recipe_id, mahlzeit')
    .gte('datum', from).lte('datum', to);
  return data || [];
}

function weekOccupancy() {
  return state.planEntries
    .filter((e) => e.recipe)
    .map((e) => ({ recipe_id: e.recipe_id, typ: e.recipe.typ }));
}

async function suggestSlot(datum, mahlzeit) {
  if (state.recipes.length === 0) { toast('Zuerst Rezepte anlegen – die Datenbank ist noch leer.'); return; }
  const historie = await loadHistoryForSuggestion(state.weekMonday);
  // Einträge dieser Woche ohne den Ziel-Slot (der wird ja ersetzt)
  const belegung = state.planEntries
    .filter((e) => e.recipe && !(e.datum === datum && e.mahlzeit === mahlzeit))
    .map((e) => ({ recipe_id: e.recipe_id, typ: e.recipe.typ }));
  const res = chooseSuggestion({
    slotDatum: datum,
    rezepte: state.recipes,
    historie: historie.filter((h) => !(h.datum === datum && h.mahlzeit === mahlzeit)),
    wochenBelegung: belegung,
    sperrWochen: state.settings.wiederholungssperre_wochen,
  });
  if (!res) { toast('Kein Vorschlag möglich – alle Rezepte sind diese Woche bereits eingeplant.'); return; }
  if (res.gelockert) toast(`Hinweis: Rezeptpool knapp – Wiederholungssperre auf ${res.benutzteSperrWochen} Woche(n) gelockert.`);
  await setSlot(datum, mahlzeit, res.recipe.id);
}

$('#plan-autofill').addEventListener('click', async () => {
  if (state.recipes.length === 0) { toast('Zuerst Rezepte anlegen – die Datenbank ist noch leer.'); return; }
  const mon = state.weekMonday;
  const historie = await loadHistoryForSuggestion(mon);
  const belegung = weekOccupancy();
  let gelockert = false, gefuellt = 0, offen = 0;

  for (let i = 0; i < 7; i++) {
    const iso = toISODate(addDays(mon, i));
    for (const mahlzeit of ['mittag', 'abend']) {
      const exists = state.planEntries.some((e) => e.datum === iso && e.mahlzeit === mahlzeit);
      if (exists) continue;
      const res = chooseSuggestion({
        slotDatum: iso,
        rezepte: state.recipes,
        historie,
        wochenBelegung: belegung,
        sperrWochen: state.settings.wiederholungssperre_wochen,
      });
      if (!res) { offen++; continue; }
      if (res.gelockert) gelockert = true;
      const { error } = await sb.from('plan_entries').upsert(
        { datum: iso, mahlzeit, recipe_id: res.recipe.id, personen: state.settings.standard_personen },
        { onConflict: 'datum,mahlzeit' });
      if (!error) {
        gefuellt++;
        belegung.push({ recipe_id: res.recipe.id, typ: res.recipe.typ });
        historie.push({ datum: iso, recipe_id: res.recipe.id, mahlzeit });
      }
    }
  }
  await renderPlan();
  let msg = `${gefuellt} Slot(s) gefüllt.`;
  if (gelockert) msg += ' Rezeptpool knapp – Wiederholungssperre teilweise gelockert.';
  if (offen) msg += ` ${offen} Slot(s) blieben offen (zu wenig Rezepte).`;
  toast(msg, 4500);
});

// --- Picker ---
function openPicker(titleSuffix, onSelect) {
  state.picker = { typ: null, fav: false, q: '', onSelect };
  $('#picker-title').textContent = `Rezept wählen – ${titleSuffix}`;
  $('#picker-search').value = '';
  renderPickerList();
  $('#picker').classList.remove('hidden');
}
$('#picker-search').addEventListener('input', (e) => { state.picker.q = e.target.value.trim().toLowerCase(); renderPickerList(); });
$$('#picker-filters [data-picker-typ]').forEach((c) => c.addEventListener('click', () => {
  state.picker.typ = state.picker.typ === c.dataset.pickerTyp ? null : c.dataset.pickerTyp;
  renderPickerList();
}));
$('#picker-fav').addEventListener('click', () => { state.picker.fav = !state.picker.fav; renderPickerList(); });

function renderPickerList() {
  const f = state.picker;
  $$('#picker-filters [data-picker-typ]').forEach((c) => c.classList.toggle('active', c.dataset.pickerTyp === f.typ));
  $('#picker-fav').classList.toggle('active', f.fav);
  const list = filteredRecipes({ typ: f.typ, fav: f.fav, tag: null, q: f.q });
  const box = $('#picker-list');
  if (list.length === 0) {
    box.innerHTML = `<div class="empty-note">${state.recipes.length === 0 ? 'Noch keine Rezepte vorhanden.' : 'Kein Treffer.'}</div>`;
    return;
  }
  box.innerHTML = list.map((r) => `
    <button class="picker-item" data-id="${r.id}">
      ${dotHtml(r.typ)}<span>${esc(r.name)}${r.favorit ? ' ★' : ''}</span>
      <span class="pmeta">${esc(fmtLastCooked(r.id))}</span>
    </button>`).join('');
  $$('#picker-list .picker-item').forEach((el) => el.addEventListener('click', () => {
    const r = state.recipes.find((x) => x.id === el.dataset.id);
    $('#picker').classList.add('hidden');
    state.picker.onSelect?.(r);
  }));
}

// =============================================================
// Einkaufsliste
// =============================================================
async function renderShopping() {
  const mon = state.weekMonday;
  $('#shop-week-label').textContent = weekLabel(mon);
  const entries = (await loadWeekEntries(mon)).filter((e) => e.recipe);
  const items = aggregateShopping(entries.map((e) => ({
    personen: e.personen,
    recipe: e.recipe,
    ingredients: e.recipe.ingredients || [],
  })));

  const { data: stateRows } = await sb.from('shopping_state')
    .select('*').eq('week_start', toISODate(mon));
  const checked = new Map((stateRows || []).map((r) => [r.item_key, r.checked]));

  const box = $('#shop-list');
  if (items.length === 0) {
    box.innerHTML = `<div class="empty-note">Keine Zutaten – diese Woche sind keine Rezepte mit Zutaten geplant.</div>`;
    $('#shop-progress').textContent = '';
    return;
  }
  const done = items.filter((i) => checked.get(i.key)).length;
  $('#shop-progress').textContent = `${done} von ${items.length} erledigt`;

  box.innerHTML = items.map((i) => {
    const isDone = !!checked.get(i.key);
    const amount = i.menge !== null ? `${fmtMenge(i.menge)} ${esc(i.einheit)}` : '';
    return `
    <label class="shop-item ${isDone ? 'done' : ''}" data-key="${esc(i.key)}">
      <input type="checkbox" ${isDone ? 'checked' : ''}>
      <span class="amount">${amount}</span>
      <span class="iname">${esc(i.name)}<small>${esc(i.rezepte.join(', '))}</small></span>
    </label>`;
  }).join('');

  $$('#shop-list .shop-item input').forEach((cb) => cb.addEventListener('change', async (e) => {
    const key = e.target.closest('.shop-item').dataset.key;
    const { error } = await sb.from('shopping_state').upsert(
      { week_start: toISODate(mon), item_key: key, checked: e.target.checked },
      { onConflict: 'week_start,item_key' });
    if (error) { toast('Status konnte nicht gespeichert werden.'); e.target.checked = !e.target.checked; return; }
    e.target.closest('.shop-item').classList.toggle('done', e.target.checked);
    const doneNow = $$('#shop-list .shop-item input:checked').length;
    $('#shop-progress').textContent = `${doneNow} von ${items.length} erledigt`;
  }));
}

/** Realtime: Abhaken auf anderen Geräten sofort anzeigen. */
function subscribeShopping() {
  if (state.shoppingChannel) return;
  state.shoppingChannel = sb.channel('shopping-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shopping_state' }, () => {
      if (state.view === 'shopping') renderShopping();
    })
    .subscribe();
}

// =============================================================
// Historie
// =============================================================
async function renderHistory() {
  const mon = getMonday(new Date());
  const { data, error } = await sb
    .from('plan_entries')
    .select('datum, mahlzeit, personen, recipe:recipes(name, typ)')
    .lt('datum', toISODate(mon))
    .order('datum', { ascending: false })
    .limit(500);
  const box = $('#history-list');
  if (error) { box.innerHTML = `<div class="empty-note">Historie konnte nicht geladen werden.</div>`; return; }
  if (!data || data.length === 0) {
    box.innerHTML = `<div class="empty-note">Noch keine vergangenen Wochen.<br>Die Historie füllt sich automatisch aus dem Wochenplan.</div>`;
    return;
  }
  // Nach Woche gruppieren
  const groups = new Map();
  for (const e of data) {
    const wk = toISODate(getMonday(fromISODate(e.datum)));
    if (!groups.has(wk)) groups.set(wk, []);
    groups.get(wk).push(e);
  }
  box.innerHTML = [...groups.entries()].map(([wk, entries]) => {
    const monD = fromISODate(wk);
    entries.sort((a, b) => a.datum.localeCompare(b.datum) || (a.mahlzeit === 'mittag' ? -1 : 1));
    const rows = entries.map((e) => {
      const d = fromISODate(e.datum);
      const idx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      return `<div class="hist-row">
        <span class="hd">${WOCHENTAGE_KURZ[idx]} ${fmtShort(d)} ${e.mahlzeit === 'mittag' ? 'Mittag' : 'Abend'}</span>
        ${e.recipe ? dotHtml(e.recipe.typ) : ''}<span>${esc(e.recipe?.name || '(gelöschtes Rezept)')}</span>
      </div>`;
    }).join('');
    return `<div class="hist-week"><h3>Woche ${weekLabel(monD)}</h3>${rows}</div>`;
  }).join('');
}

// =============================================================
initAuth();
