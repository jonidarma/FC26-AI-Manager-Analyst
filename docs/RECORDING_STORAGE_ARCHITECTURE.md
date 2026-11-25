# FC26 AI Manager — Recording Storage Architecture (Layout v2 & Legacy v1)

**Version:** 3.0.1  
**Applies to:** Windows 10/11 Native Electron Desktop Runtime & Local Express Backend

---

## 1. Design Principles

1. **SQLite Remains Authoritative** — `database/fc26_manager.db` inside Electron `userData` (`%APPDATA%\fc26-ai-manager\database\fc26_manager.db`) is never moved, replaced, or subordinated to filesystem JSON files. All JSON artifacts (`match-metadata.json`, `recording-manifest.json`, `AI Analysis/*.json`, `Diagnostics/*.json`) are secret-scrubbed human-readable mirrors.
2. **Zero Auto-Migration / Zero Breaking Changes** — Existing Phase 2–3 recordings under `%APPDATA%\fc26-ai-manager\recordings\{matchId}\{sessionId}\segment_001.mp4` (`storage_layout_version = 1`) remain untouched in place and continue to resolve and analyze cleanly.
3. **Human-Readable Career Mode Structure (Layout v2)** — All new recordings starting in v3.0.1 are organized directly under the authoritative application storage root (`app.getPath('userData')` in Electron) using official Career Mode club, opponent, competition, in-game match date, and formation metadata.
4. **Zero `process.cwd()` Dependency** — Media path resolution, containment checks, and FFmpeg/FFprobe binary lookups never rely on the backend working directory.

---

## 2. Directory Tree (Windows 10/11 Electron Layout)

```text
%APPDATA%\fc26-ai-manager\
├── database\
│   └── fc26_manager.db                                          # Authoritative SQLite DB (unchanged)
├── recordings\                                                  # Legacy Layout v1 (preserved read/analyze in place)
│   └── {matchId}\
│       └── {sessionId}\
│           ├── manifest.json
│           └── segment_001.mp4
└── Chelsea-Career-Mode\                                         # Structured Layout v2 (new recordings)
    └── Chelsea-vs-Sunderland (Premier League) 2027-09-11\
        ├── First Half\
        │   ├── Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 1.mp4
        │   ├── Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 2.mp4
        │   ├── recording-manifest.json
        │   └── diagnostics.jsonl
        ├── Second Half\
        │   ├── Chelsea vs Sunderland (Premier League) 4-3-3 Holding 2027-09-11 Part 1.mp4
        │   ├── recording-manifest.json
        │   └── diagnostics.jsonl
        ├── Evidence Frames\
        │   ├── First Half\
        │   │   └── frame_001_00-04.jpg
        │   └── Second Half\
        │       └── frame_001_00-06.jpg
        ├── AI Analysis\
        │   ├── first-half-analysis.json
        │   ├── second-half-analysis.json
        │   └── match-comparison.json
        ├── Diagnostics\
        │   ├── first-half-recording-diagnostics.json
        │   └── second-half-recording-diagnostics.json
        └── match-metadata.json
```

---

## 3. Naming Templates & Deterministic Rules

| Artifact | Template | Example |
|---|---|---|
| Career Mode Folder | `{ClubName}-Career-Mode` | `Chelsea-Career-Mode` |
| Duplicate Career Profile | `{ClubName}-Career-Mode ({Season})` | `Chelsea-Career-Mode (2028-29)` |
| Match Folder | `{UserClub}-vs-{OpponentClub} ({Competition}) {MatchDate}` | `Chelsea-vs-Sunderland (Premier League) 2027-09-11` |
| Duplicate Match Same Day | `{MatchFolder} [Match 02]` | `Chelsea-vs-Sunderland (Premier League) 2027-09-11 [Match 02]` |
| Video Segment | `{UserClub} vs {OpponentClub} ({Competition}) {Formation} {MatchDate} Part {N}.mp4` | `Chelsea vs Sunderland (Premier League) 4-2-3-1 Wide 2027-09-11 Part 1.mp4` |
| Re-recorded Half Session | `{HalfFolder}/Session 02/` | `First Half/Session 02/... Part 1.mp4` |

### 3.1 In-Game Fixture Date Policy
- `{MatchDate}` always comes from the Career Mode in-game fixture date entered in Match Preparation (`YYYY-MM-DD`).
- The system **never silently substitutes** the computer's real-world clock date.
- If the in-game date is missing or invalid, the planner outputs `Date-Unknown` and displays a warning banner in Match Preparation.

### 3.2 Confirmed-Only Second-Half Formation Policy
- **First Half** video filenames always use the immutable pre-match tactical snapshot formation (`snapshot_type = 'pre_match'`).
- **Second Half** video filenames check for an `in_match_adjustment` tactical snapshot where `applied_in_game_confirmed = 1`.
- Unconfirmed AI proposals (`applied_in_game_confirmed = 0`) **never** alter the second-half video filename; the planner falls back to the pre-match formation and records `formationSource = 'fallback_pre_match_unconfirmed'`.

### 3.3 Safe Temp-Staging & Atomic Post-Close Rename
- While FFmpeg is actively writing a v2 segment, it writes to a hidden staging filename (`.fc26_seg_001.mp4`, `.fc26_seg_002.mp4`, etc.).
- Only **after** FFmpeg closes the file and FFprobe validates integrity does `CaptureSessionEngine.finalizeStructuredSegmentFile()` atomically rename the file into the human-readable `Part N.mp4` filename.
- If the target filename already exists, the engine throws `RECORDING_FILENAME_COLLISION` and refuses to overwrite existing footage.

### 3.4 Windows Filesystem Safety
- Invalid Windows characters (`< > : " / \ | ? *`), control characters, and `..` sequences are sanitized while preserving valid Unicode club names (e.g., `Bayern München`, `Atlético Madrid`, `São Paulo`).
- Trailing periods and spaces are stripped.
- Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) are suffixed with `_Item`.
- Full paths exceeding `WINDOWS_SAFE_MAX_PATH` (240 characters) are deterministically compacted using stable short hashes before directory creation.

---

## 4. Canonical Media Path Resolution & Security Containment

Shared module: `shared/recordingStorage.ts`  
Server resolver: `server/services/recordingMediaResolver.ts`

1. **Ownership Validation**: Verifies `session.matchId === matchId`, `session.half === expectedHalf`, and `segment.sessionId === session.id` (`RECORDING_SESSION_MISMATCH`).
2. **Traversal & Null-Byte Rejection**: Rejects `..`, null bytes, and absolute paths inside `relative_media_path` (`MEDIA_PATH_SECURITY_VIOLATION`).
3. **Dual Containment Check**: Every candidate path is validated both lexically and via `fs.realpathSync` (walking up to the nearest existing ancestor when creating new files) so symlinks and Windows directory junctions cannot escape approved storage roots (`MEDIA_PATH_SECURITY_VIOLATION`).
4. **Resolution Precedence** (never uses `process.cwd()`):
   - `relative_media_path` anchored to `appStorageRoot`
   - Confined absolute `file_path`
   - Relative `file_path` anchored to `session_directory`, `output_directory`, `{match_directory}/{Half}`, `{legacyRecordingsRoot}/{matchId}/{sessionId}`, `{dataDir}/recordings/{matchId}/{sessionId}`, or `appStorageRoot`
   - Safe basename fallback inside verified session directories
5. **Trusted Folder IPC**: The renderer never sends raw filesystem paths to Electron `shell.openPath()`. Instead, it sends semantic identifiers (`{ kind, matchId, sessionId }`), which the Express backend resolves and confines via `POST /api/storage/resolve-trusted-folder` before Electron Main re-verifies realpath containment and opens File Explorer.

---

## 5. Error Code Taxonomy

Local media and storage errors are preserved cleanly and never misclassified as `GEMINI_ANALYSIS_ERROR`:

| Error Code | Meaning |
|---|---|
| `MEDIA_PATH_SECURITY_VIOLATION` | Path traversal, null byte, symlink/junction escape, or path outside approved roots |
| `MEDIA_FILE_NOT_FOUND` | Confined segment file or requested folder does not exist on disk |
| `MEDIA_INTEGRITY_FAILED` | File exists and is confined, but FFprobe validation failed (corrupted / 0-byte / non-video) |
| `RECORDING_SESSION_MISMATCH` | Session or segment does not belong to the requested match or half |
| `MEDIA_PATH_RESOLUTION_FAILED` | Missing path metadata or target is not a regular file/directory |
| `RECORDING_FILENAME_COLLISION` | Final human-readable filename already exists; refused to prevent overwrite |
| `RECORDING_PATH_TOO_LONG` | Path still exceeds safe Windows path bounds even after compaction |
| `RECORDING_DIRECTORY_CREATION_FAILED` | OS error while creating structured recording directories |
| `RECORDING_METADATA_INVALID` | Referenced match or folder metadata is missing from SQLite |
