# FC 26 Career Mode Player Dataset Directory

`catalog_players` starts empty by default because FC26 AI Manager does not scrape external sites or fabricate player ratings.

## Importing Your FC 26 Player Dataset

Use either:
1. **FC26 Database Center -> Import & Update History** inside the desktop application (upload `.csv` or `.json`, inspect preview and validation errors, then confirm).
2. **CLI Batch Import**:
   ```bash
   npx tsx scripts/data-import/import-players.ts path/to/fc26_players.csv
   ```

## Supported Columns (`template_players.csv`)

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
