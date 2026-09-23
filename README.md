# Menüplaner

Web-App für die wöchentliche Menüplanung unserer Familie: eigene Rezeptdatenbank,
Wochenpläne für Mittag- und Abendessen, automatische Vorschläge und eine daraus
generierte Einkaufsliste. Zugriff nur mit dem gemeinsamen Familien-Passwort.

## Architektur

- **Frontend:** Statisches HTML/CSS/Vanilla-JS (dieses Repo), gehostet auf GitHub Pages.
- **Backend:** Supabase (PostgreSQL + Auth + Row Level Security), Free Tier, Region Zürich.
- **Sicherheit:** Ohne Login sind keinerlei Daten abrufbar. Alle Tabellen haben RLS
  (nur Rolle `authenticated`); die `anon`-Rolle hat zusätzlich sämtliche Rechte entzogen.
  Im Repo liegen nur die Supabase-URL und der Publishable Key – beides ist bei aktiver
  RLS unkritisch. **Keine Secrets, kein Service-Role-Key, kein Passwort im Code.**

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Alle Views (Wochenplan, Rezepte, Einkauf, Historie, Einstellungen) |
| `css/style.css` | Layout mobile-first, Bottom-Tab-Navigation |
| `js/config.js` | Supabase-URL + Publishable Key (öffentlich unbedenklich) |
| `js/logic.js` | Reine Logik: Datum, Einkaufsaggregation, Auto-Vorschlag (in Node testbar) |
| `js/app.js` | Auth, Views, Datenbankzugriffe |
| `tests/logic.test.js` | Logik-Tests: `node tests/logic.test.js` |

## Datenbankschema (für Befüllung via Claude Code / SQL)

Projekt-Referenz: `dbyxdxuegtjqdztwzjva`

### Enums
- `rezept_typ`: `'fleisch' | 'vegi' | 'fisch'`
- `mahlzeit_typ`: `'mittag' | 'abend'`

### Tabellen

**recipes** – Rezepte
| Spalte | Typ | Bemerkung |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| name | text | Pflicht |
| typ | rezept_typ | Pflicht |
| tags | text[] | frei, default `{}` (z.B. `{Pasta,Asiatisch}`) |
| rezept_link | text | optional, URL zum Originalrezept |
| portionen_basis | integer | default 4, > 0 |
| favorit | boolean | default false |
| created_at | timestamptz | default now() |

**ingredients** – Zutaten eines Rezepts
| Spalte | Typ | Bemerkung |
|---|---|---|
| id | uuid | PK |
| recipe_id | uuid | FK → recipes.id, `on delete cascade` |
| name | text | Pflicht |
| menge | numeric | optional (Basis-Menge für `portionen_basis` Personen) |
| einheit | text | optional (z.B. g, dl, Stk) |

**plan_entries** – Wochenplan (Historie = vergangene Einträge)
| Spalte | Typ | Bemerkung |
|---|---|---|
| id | uuid | PK |
| datum | date | Pflicht |
| mahlzeit | mahlzeit_typ | Pflicht; `unique(datum, mahlzeit)` |
| recipe_id | uuid | FK → recipes.id, `on delete cascade`; `null` bei Buffet |
| personen | integer | default 4, > 0 |
| buffet | boolean | default false; Resten-Essen ohne Rezept. Check: `buffet` ⇔ `recipe_id is null` |
| created_at | timestamptz | default now() |

**shopping_state** – Abhak-Status der Einkaufsliste (Liste selbst wird berechnet)
| Spalte | Typ | Bemerkung |
|---|---|---|
| id | uuid | PK |
| week_start | date | Montag der Woche |
| item_key | text | `lower(name)\|lower(einheit)`; `unique(week_start, item_key)` |
| checked | boolean | default false |

**settings** – Key-Value
| key | Bedeutung | Default |
|---|---|---|
| `wiederholungssperre_wochen` | Auto-Vorschlag: keine Wiederholung innert n Wochen | `3` |
| `standard_personen` | Vorgabe Personenzahl pro Slot | `4` |

### Beispiel: Rezept per SQL einfügen

```sql
with r as (
  insert into recipes (name, typ, tags, rezept_link, portionen_basis)
  values ('Spaghetti Carbonara', 'fleisch', '{Pasta,Italienisch}',
          'https://example.com/carbonara', 4)
  returning id
)
insert into ingredients (recipe_id, name, menge, einheit)
select id, x.name, x.menge, x.einheit from r,
(values ('Spaghetti', 400, 'g'), ('Eier', 4, 'Stk'),
        ('Speckwürfeli', 150, 'g'), ('Parmesan', 80, 'g'))
as x(name, menge, einheit);
```

## Logik-Regeln

- **Einkaufsliste:** Menge = `menge × personen / portionen_basis`, gleiche Zutaten
  (Name + Einheit, Gross-/Kleinschreibung egal) werden über die Woche summiert.
- **Auto-Vorschlag:** keine Wiederholung innerhalb der Sperrfrist (gegen die Historie
  geprüft), kein Rezept doppelt in derselben Woche, ausgewogener Typ-Mix (der in der
  Woche am wenigsten vertretene Typ wird bevorzugt). Reicht der Rezeptpool nicht,
  wird die Sperre schrittweise gelockert und ein Hinweis angezeigt.
- **Buffet (Resten):** Jeder Slot kann jederzeit und beliebig oft als «♻ Buffet»
  markiert werden. Buffet hat kein Rezept, unterliegt keiner Wiederholungssperre,
  zählt nicht zum Typ-Mix, erzeugt keine Einkäufe und wird vom Auto-Füllen nie
  gesetzt oder überschrieben.

## Verwaltung

- **Passwort ändern:** Supabase-Dashboard → Authentication → Users → Benutzer wählen
  → «Reset password» / neues Passwort setzen.
- **Selbstregistrierung:** ist deaktiviert (Dashboard → Authentication → Sign In/Up).
