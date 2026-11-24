import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb } from '../../server/db/database.ts';
import { executeCatalogImport, resolveReferenceDataDir } from '../../server/services/catalogImporter.ts';
import { getCatalogOverview } from '../../server/services/catalogRepository.ts';
import type { CatalogDatasetType, DatasetCompleteness } from '../../src/types/domain.ts';

const refDir = resolveReferenceDataDir();
const db = getDb();

try {
  const steps: Array<{
    type: CatalogDatasetType;
    file: string;
    completeness: DatasetCompleteness;
  }> = [
    { type: 'sources', file: 'manifests/sources.json', completeness: 'verified_complete' },
    { type: 'positions', file: 'roles/positions.json', completeness: 'verified_complete' },
    { type: 'roles', file: 'roles/roles.json', completeness: 'verified_complete' },
    { type: 'focuses', file: 'focuses/focuses.json', completeness: 'verified_complete' },
    { type: 'formations', file: 'formations/formations.json', completeness: 'verified_complete' },
    { type: 'nations', file: 'nations/nations.json', completeness: 'partial_baseline' },
    { type: 'leagues', file: 'leagues/leagues.json', completeness: 'partial_baseline' },
    { type: 'clubs', file: 'clubs/clubs.json', completeness: 'partial_baseline' },
  ];

  for (const step of steps) {
    const fullPath = path.resolve(refDir, step.file);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const run = executeCatalogImport(db, step.type, 'json', raw, {
      fileName: step.file,
      completeness: step.completeness,
      mode: 'upsert',
    });
    console.log(
      `[import-all:${step.type}] total=${run.totalRows} inserted=${run.insertedCount} updated=${run.updatedCount} rejected=${run.rejectedCount}`
    );
  }

  console.log('\nCatalog Overview Summary:');
  console.log(JSON.stringify(getCatalogOverview(db).counts, null, 2));
} finally {
  closeDb();
}
