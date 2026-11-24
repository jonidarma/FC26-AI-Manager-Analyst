import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb } from '../../server/db/database.ts';
import {
  executeCatalogImport,
  previewCatalogImport,
  resolveReferenceDataDir,
} from '../../server/services/catalogImporter.ts';
import type { CatalogDatasetType, DatasetCompleteness } from '../../src/types/domain.ts';

export function runDatasetCli(
  datasetType: CatalogDatasetType,
  defaultRelativePath: string,
  defaultCompleteness: DatasetCompleteness
): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('--preview');
  const fileArg = args.find((a) => !a.startsWith('--'));

  const targetPath = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(resolveReferenceDataDir(), defaultRelativePath);

  if (!fs.existsSync(targetPath)) {
    console.error(`[import-${datasetType}] File not found: ${targetPath}`);
    process.exit(1);
  }

  const ext = path.extname(targetPath).toLowerCase();
  const format: 'json' | 'csv' = ext === '.csv' ? 'csv' : 'json';
  const rawContent = fs.readFileSync(targetPath, 'utf8');

  const db = getDb();
  try {
    if (dryRun) {
      const preview = previewCatalogImport(db, datasetType, format, rawContent);
      console.log(JSON.stringify({ mode: 'dry-run', file: targetPath, preview }, null, 2));
      return;
    }

    const run = executeCatalogImport(db, datasetType, format, rawContent, {
      fileName: path.basename(targetPath),
      completeness: fileArg ? 'user_imported' : defaultCompleteness,
      mode: 'upsert',
    });

    console.log(
      `[import-${datasetType}] Completed run ${run.id} | file=${run.fileName} | total=${run.totalRows} | inserted=${run.insertedCount} | updated=${run.updatedCount} | rejected=${run.rejectedCount} | sha256=${run.checksum.slice(0, 12)}`
    );
    if (run.errors.length > 0) {
      console.warn(`[import-${datasetType}] Sample validation errors:`, run.errors.slice(0, 5));
    }
  } finally {
    closeDb();
  }
}
