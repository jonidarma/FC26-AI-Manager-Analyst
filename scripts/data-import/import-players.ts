import { runDatasetCli } from './_cliHelper.ts';

if (!process.argv.slice(2).some((a) => !a.startsWith('--'))) {
  console.error(
    'Usage: npx tsx scripts/data-import/import-players.ts <path/to/fc26_players.csv|json> [--dry-run]'
  );
  process.exit(1);
}

runDatasetCli('players', 'players/template_players.csv', 'user_imported');
