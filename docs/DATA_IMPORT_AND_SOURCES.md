# FC26 AI Manager — Master Data Sources, Schema & Import Guide

This document describes the EA SPORTS FC 26 Master Reference Database introduced in **Phase 1.2** (`SQLite Migration v2`), its authoritative source provenance, legal/ethical data boundaries, local file formats, CLI batch import scripts, and exact dataset completeness.

---

## 1. Authoritative Data Sources & Compliance Policy

FC26 AI Manager is a local-first Windows desktop application. To respect third-party terms of service, `robots.txt` policies, and copyright boundaries:

- **No automated web scraping**: The application does not scrape third-party websites or bypass rate limits/bot protection.
- **No redistributed third-party media**: Club crests, league logos, nation flags, and player headshots are not bundled or hotlinked.
- **Zero fabrication**: Missing fields remain `NULL` in SQLite. Player records are never fabricated or padded with synthetic placeholders.
- **User-controlled local imports**: Bulk player/club/league/nation catalogs can be imported locally from verified CSV or JSON files via the **FC26 Database Center** UI or the CLI batch scripts under `scripts/data-import/`.

### Reference Sources Tracked in `catalog_sources`

| Source Key | Reference | Scope |
| --- | --- | --- |
| `ea_fc26_pitch_notes` | EA SPORTS FC 26 Gameplay Deep Dive / Pitch Notes | Verified FC IQ Roles (29 roles incl. `Ball-Playing Keeper`, `Wide Back`, `Inverted Wingback`, `Box Crasher`), 10 Focuses, position-specific Role–Focus compatibility |
| `futbin_fc26_roles` | FUTBIN FC 26 Roles & Focuses Reference | Cross-verification of position-specific Role–Focus pairs (e.g. `Half-Winger` CM `Support` vs CAM `Roaming`) |
| `fifplay_fc26_formations` | FIFPlay FC 26 Formations Reference | All 34 verified FC 26 formations (Back 3, Back 4, Back 5) and 11-slot positional layouts |
| `fifplay_fc26_clubs` | FIFPlay FC 26 Clubs Directory | Men's and women's clubs tracked as strictly separate club entities |
| `futwiz_fc26_career` | FUTWIZ FC 26 Career Mode Players, Leagues & Nations | Career Mode player ratings/potential/contracts schema, leagues, and nations |

---

## 2. Honest Dataset Completeness Status

On a clean install, `bootstrapLocalReferenceCatalogs()` loads only verified local JSON files from `data/fc26/`:

| Dataset | Initial Rows | Completeness Status | Notes |
| --- | ---: | --- | --- |
| **Positions** (`catalog_positions`) | 15 | `verified_complete` | All 15 FC 26 positions (`GK`, `LB`, `CB`, `RB`, `LWB`, `RWB`, `CDM`, `CM`, `CAM`, `LM`, `RM`, `LW`, `RW`, `CF`, `ST`) |
| **Player Roles** (`catalog_roles`) | 29 | `verified_complete` | Includes all 4 FC 26 additions: `Ball-Playing Keeper`, `Wide Back`, `Inverted Wingback`, `Box Crasher` |
| **Player Focuses** (`catalog_focuses`) | 10 | `verified_complete` | All 10 verified FC 26 focuses + position-specific compatibility rows |
| **Formations** (`catalog_formations`) | 34 | `verified_complete` | 34 verified FC 26 formations × 11 coordinate slots (`374` slot records) |
| **Nations** (`catalog_nations`) | 60 | `partial_baseline` | Major footballing nations with source name, display name, ISO code, and region |
| **Leagues** (`catalog_leagues`) | 26 | `partial_baseline` | Major men's and women's leagues across Europe, Americas, Asia, and Oceania |
| **Clubs** (`catalog_clubs`) | 64 | `partial_baseline` | Men's and women's clubs kept strictly separate (e.g. `Arsenal` vs `Arsenal Women`, `FC Barcelona` vs `FC Barcelona Femení`) |
| **Players** (`catalog_players`) | 0 | `empty_awaiting_user_import` | Starts at `0` by design; import your own CSV/JSON export (supports 20,000+ rows) |

---

## 3. SQLite Migration v2 Architecture

Migration `v2` (`fc26_master_catalog_v2`) is transactional and strictly preserves all existing Phase 1 / 1.1 operational tables (`clubs`, `career_profiles`, `players`, `opponents`, `matches`, `tactical_configurations`, `halftime_reports`, `tactical_memory`, etc.).

### Master Reference Tables Added in v2 (14 tables)

1. `catalog_sources` — Authoritative source provenance and license notes
2. `catalog_import_runs` — Audit log of every import (dataset, format, SHA-256 checksum, inserted/updated/rejected counts, error JSON, rollback status)
3. `catalog_nations` — Nations with `source_name`, `display_name`, `iso_code`, `region`
4. `catalog_leagues` — Men's, women's, and mixed competitions linked to `catalog_nations`
5. `catalog_clubs` — Separate men's (`team_category = 'mens'`) and women's (`team_category = 'womens'`) clubs linked to leagues & nations
6. `catalog_positions` — All 15 FC 26 positions and tactical lines
7. `catalog_players` — Indexed master player catalog (name, primary position, OVR, POT, growth, age, 6 face stats, foot, weak foot, skill moves, height/weight, market value, wage, contract expiry, extensible `attributes_json`)
8. `catalog_player_positions` — Normalized secondary positions (`many-to-many`) for fast multi-position search
9. `catalog_formations` — Formations with defensive/attacking shapes, game mode applicability, `career_mode_status`, `layout_verified`, `is_user_adjusted`
10. `catalog_formation_slots` — 11 ordered positional slots `(slot_order, position_code, position_label, x, y, tactical_line, is_user_adjusted)`
11. `catalog_roles` — FC IQ player roles with `is_fc26_new` and `verification_status`
12. `catalog_focuses` — FC IQ player focuses with `is_fc26_updated` and `verification_status`
13. `catalog_role_positions` — Eligible positions per FC IQ role
14. `catalog_role_focus_compatibility` — **Position-specific** `(role_id, position_code, focus_id)` compatibility rules

### Non-Destructive Operational Table Links

- `clubs`: added `catalog_club_id`, `nation`
- `players`: added `catalog_player_id`, `potential_rating`, `age`, `contract_expiry`, `market_value_eur`, `wage_eur`, `player_focus`
- `opponents`: added `catalog_club_id`

**Master Catalog Immutability**: Importing a player from `catalog_players` into a Career Mode club copies baseline attributes into `players` with a nullable `catalog_player_id`. Subsequent Career Mode edits (growth, OVR, position, contract, custom notes) or deletions never mutate `catalog_players`.

---

## 4. Supported CSV & JSON Import Schemas

All imports follow a safe **Preview → Confirm → Transactional Upsert → Rollback** workflow with SHA-256 deduplication and row-level validation.

### Players (`players`)
Template file: `data/fc26/players/template_players.csv`

| Column | Required | Type / Format |
| --- | --- | --- |
| `external_source_id` | Recommended | Unique ID (e.g. `futwiz_231747`); auto-derived if omitted |
| `full_name` | Yes | Player full name |
| `short_name` | Optional | Display short name (defaults to `full_name`) |
| `club_name` | Optional | Matched against `catalog_clubs` (men's/women's preserved) |
| `league_name` | Optional | Matched against `catalog_leagues` |
| `nation_name` | Optional | Matched against `catalog_nations` (`source_name` or `display_name`) |
| `primary_position` | Yes | Valid FC 26 position code (`GK`, `CB`, `CM`, `ST`, etc.) |
| `secondary_positions` | Optional | Pipe- or semicolon-delimited codes (e.g. `LW|RW`) |
| `age` | Optional | Integer `14–55` (blank → `NULL`) |
| `overall_rating` | Optional | Integer `1–99` (blank → `NULL`) |
| `potential_rating` | Optional | Integer `1–99` (blank → `NULL`) |
| `pace`, `shooting`, `passing`, `dribbling`, `defending`, `physicality` | Optional | Integer `1–99` (blank → `NULL`) |
| `preferred_foot` | Optional | `Right`, `Left`, or `Both` |
| `weak_foot`, `skill_moves` | Optional | Integer `1–5` |
| `height_cm`, `weight_kg` | Optional | Numeric |
| `market_value_eur`, `wage_eur` | Optional | Integer EUR |
| `contract_expiry` | Optional | Year or ISO date (e.g. `2029`) |

### Clubs (`clubs`)
Required fields: `name`, `team_category` (`mens` or `womens`). Optional: `external_source_id`, `short_name`, `league_name`, `nation_name`.

### Leagues (`leagues`)
Required fields: `name`. Optional: `external_source_id`, `country_name`, `tier`, `category` (`mens` | `womens` | `mixed`).

### Nations (`nations`)
Required fields: `source_name`, `display_name`. Optional: `external_source_id`, `iso_code`, `region`.

### Formations (`formations`), Positions (`positions`), Roles (`roles`), Focuses (`focuses`)
JSON schemas matching the verified baseline files under `data/fc26/formations/formations.json`, `data/fc26/roles/positions.json`, `data/fc26/roles/roles.json`, and `data/fc26/focuses/focuses.json`.

---

## 5. CLI Batch Import Scripts

Run from the project root (or set `FC26_USER_DATA_DIR` to target a custom SQLite data directory):

```bash
# Bootstrap / re-sync all local reference catalogs idempotently
npm run import:fc26

# Dry-run preview of a custom player CSV before writing to SQLite
npx tsx scripts/data-import/import-players.ts ./path/to/fc26_players.csv --dry-run

# Execute transactional import (upsert mode, supports 20,000+ players)
npx tsx scripts/data-import/import-players.ts ./path/to/fc26_players.csv

# Individual dataset scripts
npx tsx scripts/data-import/import-nations.ts ./data/fc26/nations/nations.json
npx tsx scripts/data-import/import-leagues.ts ./data/fc26/leagues/leagues.json
npx tsx scripts/data-import/import-clubs.ts ./data/fc26/clubs/clubs.json
npx tsx scripts/data-import/import-formations.ts ./data/fc26/formations/formations.json
npx tsx scripts/data-import/import-tactics.ts
```

Every import records an entry in `catalog_import_runs` and can be rolled back from **FC26 Database Center → Import & History**.

---

## 6. Backup & Restore Compatibility

- **Export (`GET /api/database/backup`)**: Generates `fc26-ai-manager-backup-v2` JSON containing all 33 tables (both operational Career Mode tables and `catalog_*` master reference tables).
- **Restore (`POST /api/database/restore`)**: Accepts both **v1** (`fc26-ai-manager-backup-v1`) and **v2** (`fc26-ai-manager-backup-v2`) backup files inside a single SQLite transaction, preserving backwards compatibility with Phase 1 / 1.1 backups.
