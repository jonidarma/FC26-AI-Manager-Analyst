import { closeDb, getDb, resolveDatabaseLocation } from '../../server/db/database.ts';
import {
  executeCatalogReconciliationFromPlayers,
  getCatalogCoverageReport,
  previewCatalogReconciliationFromPlayers,
} from '../../server/services/catalogReconciler.ts';

function main(): void {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const reportOnly = args.includes('--report');

  const location = resolveDatabaseLocation();
  console.log('============================================================');
  console.log('FC26 AI Manager — Master Catalog Expansion & Player Relinker');
  console.log('============================================================');
  console.log(`Database Path : ${location.dbPath}`);
  console.log(`Storage Mode  : ${location.storageMode}`);
  console.log('');

  const db = getDb();

  try {
    if (reportOnly) {
      const report = getCatalogCoverageReport(db);
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (!execute) {
      const preview = previewCatalogReconciliationFromPlayers(db);
      console.log('Mode: DRY-RUN PREVIEW (pass --execute to commit changes)');
      console.log(`- Catalog players scanned   : ${preview.sourcePlayerCount}`);
      console.log(`- Distinct nations found    : ${preview.distinctNationsInPlayers} (+${preview.nationsToInsert} new, ${preview.nationsToUpdate} update)`);
      console.log(`- Distinct leagues found    : ${preview.distinctLeaguesInPlayers} (+${preview.leaguesToInsert} new, ${preview.leaguesToUpdate} update)`);
      console.log(`- Distinct clubs found      : ${preview.distinctClubsInPlayers} (+${preview.clubsToInsert} new, ${preview.clubsToUpdate} update)`);
      console.log(`- Free Agent players        : ${preview.freeAgentPlayers}`);
      console.log(`- Players to relink (club)  : ${preview.playersToRelinkClub}`);
      console.log(`- Players to relink (league): ${preview.playersToRelinkLeague}`);
      console.log(`- Players to relink (nation): ${preview.playersToRelinkNation}`);
      console.log(`- Premier League clubs      : ${preview.premierLeagueClubsAfter}/20 (Everton found: ${preview.evertonFoundInSource ? 'YES' : 'NO'})`);
      console.log('');
      if (preview.warnings.length > 0) {
        for (const w of preview.warnings) {
          console.log(`Note: ${w}`);
        }
      }
      return;
    }

    const result = executeCatalogReconciliationFromPlayers(db);
    const after = result.coverageAfter;
    console.log('Mode: EXECUTED RECONCILIATION (Transaction Committed)');
    console.log(`- Audit Run ID              : ${result.runId}`);
    console.log(`- Nations                   : +${result.nationsInserted} inserted, ${result.nationsUpdated} updated (Total: ${after.counts.nations})`);
    console.log(`- Leagues                   : +${result.leaguesInserted} inserted, ${result.leaguesUpdated} updated (Total: ${after.counts.leagues} — ${after.counts.mensLeagues} men's, ${after.counts.womensLeagues} women's)`);
    console.log(`- Clubs                     : +${result.clubsInserted} inserted, ${result.clubsUpdated} updated (Total: ${after.counts.clubs} — ${after.counts.mensClubs} men's, ${after.counts.womensClubs} women's)`);
    console.log(`- Verified Club Aliases     : +${result.clubAliasesInserted} inserted (Total: ${after.counts.clubAliases})`);
    console.log(`- Players Preserved         : ${result.playersPreservedCount} (UUIDs & extended attributes untouched)`);
    console.log(`- Players Relinked          : club=${result.playersRelinkedClub}, league=${result.playersRelinkedLeague}, nation=${result.playersRelinkedNation}`);
    console.log(`- Linked Coverage           : club=${after.counts.linkedPlayersToClub}/${after.counts.players} (${after.counts.freeAgentPlayers} Free Agents, ${after.counts.unresolvedClubPlayers} unresolved)`);
    console.log(
      `- Premier League Check      : ${after.premierLeagueVerification.clubCount}/20 clubs, Everton=${after.premierLeagueVerification.evertonPresent ? `YES (${after.premierLeagueVerification.evertonPlayerCount} players)` : 'MISSING'}`
    );
    console.log(`- Duplicate Clubs Detected  : ${after.duplicateClubChecks.length}`);
  } finally {
    closeDb();
  }
}

main();
