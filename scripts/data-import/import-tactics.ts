import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb } from '../../server/db/database.ts';
import { executeCatalogImport, resolveReferenceDataDir } from '../../server/services/catalogImporter.ts';

const refDir = resolveReferenceDataDir();
const db = getDb();

try {
  const steps = [
    { type: 'sources' as const, file: 'manifests/sources.json' },
    { type: 'positions' as const, file: 'roles/positions.json' },
    { type: 'roles' as const, file: 'roles/roles.json' },
    { type: 'focuses' as const, file: 'focuses/focuses.json' },
    { type: 'formations' as const, file: 'formations/formations.json' },
  ];

  for (const step of steps) {
    const fullPath = path.resolve(refDir, step.file);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const run = executeCatalogImport(db, step.type, 'json', raw, {
      fileName: step.file,
      completeness: 'verified_complete',
      mode: 'upsert',
    });
    console.log(
      `[import-tactics:${step.type}] total=${run.totalRows} inserted=${run.insertedCount} updated=${run.updatedCount} rejected=${run.rejectedCount}`
    );
  }
} finally {
  closeDb();
}
