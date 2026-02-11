// build-traceability-matrix-aggregated.js
// Joins OCMXML_Jira_Export.csv with two TestRail exports
// and outputs ONE row per Jira issue, with tests aggregated in columns,
// plus a summary CSV with coverage stats.

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const readline = require('readline');

// --- CLI Input Handler ---

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getCliInputs() {
  console.log('\n=== Traceability Matrix Generator ===\n');

  const jiraFile = await promptUser('Enter path to Jira CSV file: ');
  if (!fs.existsSync(jiraFile)) {
    console.error(`Error: Jira file not found at ${jiraFile}`);
    process.exit(1);
  }

  const testRailFiles = [];
  let addMore = true;
  let fileCount = 1;

  while (addMore) {
    const testFile = await promptUser(`Enter path to TestRail CSV file #${fileCount}: `);
    if (!fs.existsSync(testFile)) {
      console.error(`Error: TestRail file not found at ${testFile}`);
      process.exit(1);
    }
    testRailFiles.push(testFile);

    if (fileCount === 1) {
      const continueAdding = await promptUser('Add another TestRail file? (y/n): ');
      addMore = continueAdding.toLowerCase() === 'y';
    } else {
      const continueAdding = await promptUser('Add another TestRail file? (y/n): ');
      addMore = continueAdding.toLowerCase() === 'y';
    }
    fileCount++;
  }

  // Create output folder if it doesn't exist
  const outputDir = path.resolve(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Created output folder at ${outputDir}\n`);
  }

  const defaultMatrixFile = path.join(outputDir, 'traceability_matrix_aggregated.csv');
  const defaultSummaryFile = path.join(outputDir, 'traceability_summary.csv');

  const outputFile = await promptUser(`Enter output filename for traceability matrix (default: ${path.basename(defaultMatrixFile)}): `) || defaultMatrixFile;
  const summaryFile = await promptUser(`Enter output filename for summary (default: ${path.basename(defaultSummaryFile)}): `) || defaultSummaryFile;

  // Ensure output files are in the output folder if no path is provided
  const finalOutputFile = outputFile.includes(path.sep) ? outputFile : path.join(outputDir, outputFile);
  const finalSummaryFile = summaryFile.includes(path.sep) ? summaryFile : path.join(outputDir, summaryFile);

  return { jiraFile, testRailFiles, outputFile: finalOutputFile, summaryFile: finalSummaryFile };
}

// --- Utilities ---

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => results.push(row))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
}

// Normalize Jira key string (trim, uppercase)
function normalizeKey(key) {
  if (!key) return '';
  return String(key).trim().toUpperCase();
}

// --- Console Display Utility ---

function displaySummaryTable(summaryRows) {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║     TRACEABILITY MATRIX SUMMARY REPORT     ║');
  console.log('╚════════════════════════════════════════════╝\n');

  const rows = summaryRows.map(row => ({
    metric: row.Metric,
    absolute: String(row.Absolute),
    percentage: row['Percentage (%)'] !== '' ? `${row['Percentage (%)']}%` : '—',
  }));

  // Calculate column widths
  const metricWidth = Math.max(...rows.map(r => r.metric.length), 'Metric'.length) + 2;
  const absoluteWidth = Math.max(...rows.map(r => r.absolute.length), 'Count'.length) + 2;
  const percentageWidth = Math.max(...rows.map(r => r.percentage.length), 'Coverage'.length) + 2;

  // Header
  console.log(
    'Metric'.padEnd(metricWidth) +
    'Count'.padEnd(absoluteWidth) +
    'Coverage'
  );
  console.log('─'.repeat(metricWidth + absoluteWidth + percentageWidth));

  // Rows
  rows.forEach(row => {
    console.log(
      row.metric.padEnd(metricWidth) +
      row.absolute.padEnd(absoluteWidth) +
      row.percentage
    );
  });

  console.log();
}

// --- Main join + aggregation logic ---

async function buildTraceabilityMatrixAggregated(jiraFile, testRailFiles, outputFile, summaryFile) {
  try {
    console.log('\nReading CSV files...');

    // Read Jira file
    const jiraRows = await readCsv(path.resolve(jiraFile));

    // Read all TestRail files
    const allTestRailRows = [];
    for (const testFile of testRailFiles) {
      const rows = await readCsv(path.resolve(testFile));
      allTestRailRows.push({ file: testFile, rows });
    }

    console.log(`Jira rows: ${jiraRows.length}`);
    allTestRailRows.forEach((tr, idx) => {
      console.log(`TestRail file #${idx + 1} (${path.basename(tr.file)}): ${tr.rows.length} rows`);
    });

    // 1) Build a lookup map for Jira by "Issue key"
    const jiraByKey = new Map();

    for (const row of jiraRows) {
      const jiraKey = normalizeKey(row['Issue key']);
      if (!jiraKey) continue;

      jiraByKey.set(jiraKey, {
        JiraKey: jiraKey,
        JiraSummary: row['Summary'] || '',
        IssueType: row['Issue Type'] || '',
        JiraStatus: row['Status'] || '',
        FixVersions: row['Fix Version/s'] || row['Fix Version'] || '',
        EpicOrParent: row['Parent key'] || '',
      });
    }

    console.log(`Unique Jira keys in map: ${jiraByKey.size}`);

    // 2) Normalize TestRail exports into a single array
    function normalizeTestRows(rawRows, sourceFile) {
      const out = [];

      for (const r of rawRows) {
        const caseId = r['ID'] || '';
        const title = r['Title'] || '';
        const priority = r['Priority'] || '';
        const testStatus = r['Test Case Automated?'] || '';
        const refsRaw = r['References'];

        if (!refsRaw || !String(refsRaw).trim()) {
          // No Jira reference, skip this test for traceability
          continue;
        }

        // Support multiple Jira keys separated by comma / semicolon
        const pieces = String(refsRaw)
          .split(/[,;]+/)
          .map((p) => normalizeKey(p))
          .filter((p) => p.length > 0);

        if (pieces.length === 0) continue;

        for (const refKey of pieces) {
          out.push({
            SourceFile: sourceFile,
            CaseID: caseId,
            TestTitle: title,
            TestPriority: priority,
            TestStatus: testStatus,
            ReferenceKey: refKey,
          });
        }
      }

      return out;
    }

    // Process all TestRail files
    const allTests = [];
    for (const { file, rows } of allTestRailRows) {
      const normalized = normalizeTestRows(rows, file);
      allTests.push(...normalized);
    }

    console.log(`Total normalized test rows with Jira references: ${allTests.length}`);

    // 3) Group tests by Jira key (ReferenceKey)
    const testsByJiraKey = new Map();

    for (const test of allTests) {
      const key = test.ReferenceKey;
      if (!testsByJiraKey.has(key)) {
        testsByJiraKey.set(key, []);
      }
      testsByJiraKey.get(key).push(test);
    }

    console.log(`Jira keys that have at least one test: ${testsByJiraKey.size}`);

    // 4) Build one aggregated row per Jira issue
    const aggregatedRows = [];

    // We want all Jira issues in the output, even if they don't have tests.
    for (const [jiraKey, jiraInfo] of jiraByKey.entries()) {
      const testsForIssue = testsByJiraKey.get(jiraKey) || [];

      // Deduplicate and concatenate arrays for nicer output
      const sourceFiles = Array.from(new Set(testsForIssue.map(t => t.SourceFile).filter(Boolean)));
      const caseIds = Array.from(new Set(testsForIssue.map(t => t.CaseID).filter(Boolean)));
      const titles = Array.from(new Set(testsForIssue.map(t => t.TestTitle).filter(Boolean)));
      const priorities = Array.from(new Set(testsForIssue.map(t => t.TestPriority).filter(Boolean)));
      const statuses = Array.from(new Set(testsForIssue.map(t => t.TestStatus).filter(Boolean)));

      aggregatedRows.push({
        // Jira side
        'Jira Key': jiraInfo.JiraKey,
        'Jira Summary': jiraInfo.JiraSummary,
        'Issue Type': jiraInfo.IssueType,
        'Jira Status': jiraInfo.JiraStatus,
        'Fix Version/s': jiraInfo.FixVersions,
        'Epic/Parent': jiraInfo.EpicOrParent,

        // Aggregated test info (may be empty strings if no tests)
        'Source Files': sourceFiles.join(', '),
        'Test Case IDs': caseIds.join(', '),
        'Test Titles': titles.join(' | '),
        'Test Priorities': priorities.join(', '),
        'Test Statuses': statuses.join(', '),
        'Test Count': testsForIssue.length,
      });
    }

    console.log(`Aggregated Jira issue rows: ${aggregatedRows.length}`);

    // 5) Write aggregated traceability matrix
    const csvWriter = createCsvWriter({
      path: path.resolve(outputFile),
      header: [
        { id: 'Jira Key', title: 'Jira Key' },
        { id: 'Jira Summary', title: 'Jira Summary' },
        { id: 'Issue Type', title: 'Issue Type' },
        { id: 'Jira Status', title: 'Jira Status' },
        { id: 'Fix Version/s', title: 'Fix Version/s' },
        { id: 'Epic/Parent', title: 'Epic/Parent' },
        { id: 'Source Files', title: 'Source Files' },
        { id: 'Test Case IDs', title: 'Test Case IDs' },
        { id: 'Test Titles', title: 'Test Titles' },
        { id: 'Test Priorities', title: 'Test Priorities' },
        { id: 'Test Statuses', title: 'Test Statuses' },
        { id: 'Test Count', title: 'Test Count' },
      ],
    });

    await csvWriter.writeRecords(aggregatedRows);
    console.log(`✓ Aggregated traceability matrix written to ${outputFile}`);

    // 6) Build and write summary file with totals and percentages
    const totalTickets = aggregatedRows.length;
    const ticketsWithTests = aggregatedRows.filter(r => Number(r['Test Count']) > 0).length;
    const ticketsWithoutTests = totalTickets - ticketsWithTests;

    const pct = (num) =>
      totalTickets === 0 ? 0 : Math.round((num / totalTickets) * 10000) / 100; // 2 decimals

    const summaryRows = [
      {
        Metric: 'Total Jira tickets',
        Absolute: totalTickets,
        'Percentage (%)': '',
      },
      {
        Metric: 'Tickets with tests',
        Absolute: ticketsWithTests,
        'Percentage (%)': pct(ticketsWithTests),
      },
      {
        Metric: 'Tickets without tests',
        Absolute: ticketsWithoutTests,
        'Percentage (%)': pct(ticketsWithoutTests),
      },
    ];

    const summaryWriter = createCsvWriter({
      path: path.resolve(summaryFile),
      header: [
        { id: 'Metric', title: 'Metric' },
        { id: 'Absolute', title: 'Absolute' },
        { id: 'Percentage (%)', title: 'Percentage (%)' },
      ],
    });

    await summaryWriter.writeRecords(summaryRows);
    console.log(`✓ Summary written to ${summaryFile}\n`);

    // Display summary in console
    displaySummaryTable(summaryRows);
  } catch (err) {
    console.error('Error building aggregated traceability matrix:', err);
    process.exit(1);
  }
}

// Main entry point
(async () => {
  const { jiraFile, testRailFiles, outputFile, summaryFile } = await getCliInputs();
  await buildTraceabilityMatrixAggregated(jiraFile, testRailFiles, outputFile, summaryFile);
})();