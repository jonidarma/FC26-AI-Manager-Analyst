# FC 26 Career Mode Player Dataset Directory

`catalog_players` starts empty by default because FC26 AI Manager does not scrape external sites or fabricate player ratings.

## Importing Your FC 26 Player Dataset

Use either:
1. **FC26 Database Center -> Import & Update History** inside the desktop application (upload `.csv` or `.json`, inspect preview and validation errors, then confirm).
2. **CLI Batch Import**:
   ```bash
   npx tsx scripts/data-import/import-players.ts path/to/fc26_players.csv
   ```

## Supported Import Formats

Both UI and CLI (`scripts/data-import/import-players.ts`) share the same source-detection and normalization adapter (`server/services/playerImportAdapters/eafc26DataHub.ts`).

### 1. FC26 AI Manager Standard CSV / JSON (`template_players.csv`)

Required:
- `full_name` (or `name`)
- `primary_position` (or `position` — one of `GK, CB, LB, RB, LWB, RWB, CDM, CM, CAM, LM, RM, LW, RW, CF, ST`)

Recommended / Optional (missing values remain `null` — never guessed):
- `external_source_id` (recommended for idempotent re-imports/updates)
- `short_name`
- `club_name` / `club_external_id`
- `league_name` / `league_external_id`
- `nation_name` / `nation_external_id`
- `secondary_positions` (pipe `|` or semicolon `;` separated, e.g. `RW|CAM`)
- `age`, `overall_rating`, `potential_rating`, `growth`
- `pace`, `shooting`, `passing`, `dribbling`, `defending`, `physicality`
- `preferred_foot` (`Right` | `Left` | `Both`), `weak_foot` (1-5), `skill_moves` (1-5)
- `height_cm`, `weight_kg`
- `market_value_eur`, `wage_eur`, `contract_expiry`

### 2. EAFC26 DataHub / SoFIFA-Style CSV (`players.csv`)

Automatically detected when headers such as `long_name`, `player_positions`, `nationality_name`, `physic`, `value_eur`, or `club_contract_valid_until_year` are present.

| EAFC26 DataHub Column | Canonical Field |
| --- | --- |
| `player_id` | `external_source_id` (`eafc26_datahub_<player_id>`) |
| `long_name` (fallback `short_name`) | `full_name` |
| `short_name` | `short_name` |
| `player_positions` (e.g. `"LW, LM"`) | First valid FC 26 code → `primary_position`; remainder → `secondary_positions` |
| `club_name`, `league_name`, `nationality_name` | `club_name`, `league_name`, `nation_name` |
| `overall`, `potential`, `physic` | `overall_rating`, `potential_rating`, `physicality` |
| `value_eur`, `wage_eur`, `club_contract_valid_until_year` | `market_value_eur`, `wage_eur`, `contract_expiry` |
| 90+ extended attributes (`attacking_*`, `skill_*`, `movement_*`, `power_*`, `mentality_*`, `defending_*`, `goalkeeping_*`, `player_traits`, `work_rate`, positional matrix ratings, etc.) | Preserved inside `catalog_players.attributes_json` (blanks/nulls stored as JSON `null`) |
| Third-party image URLs (`player_face_url`, `club_logo_url`, `nation_flag_url`, etc.) | Explicitly ignored (never stored or hotlinked) |

**Source Provenance Notice (`eafc26_datahub_player_data`)**: The EAFC26 DataHub player CSV is a community-distributed, Kaggle-derived dataset and is **not** an official EA SPORTS export. Verify upstream Kaggle and repository license/usage terms before redistributing any dataset file.
