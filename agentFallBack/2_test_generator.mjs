// agent/2_test_generator.mjs
// Agent: Test Generator
import fs from "node:fs";
import path from "node:path";

const agentDir = process.cwd();
const repoRoot = path.resolve(agentDir, "..");
const generatedDir = path.join(agentDir, "generated");

function argValue(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 ? process.argv[idx + 1] : null;
}

const pageIdEnv = (process.env.CONFLUENCE_PAGE_ID || "").trim();
const pageIdArg = (argValue("--pageId") || "").trim();
const effectivePageId = pageIdArg || pageIdEnv;

if (!effectivePageId) {
    console.error("Missing pageId. Provide --pageId or set CONFLUENCE_PAGE_ID.");
    process.exit(1);
}

// Inputs produced by earlier steps (now in generated/ folder)
const mdPath = path.join(generatedDir, `page_${effectivePageId}.md`);
const jiraPath = path.join(generatedDir, `jira_${effectivePageId}.txt`);
const relatedContextPath = path.join(generatedDir, `related_context_${effectivePageId}.md`);
const briefPath = path.join(generatedDir, `brief_${effectivePageId}.json`);
const scenariosPath = path.join(generatedDir, `scenarios_${effectivePageId}.json`);
const testDataPath = path.join(generatedDir, `test_data_${effectivePageId}.json`);
const requiredDataSpecPath = path.join(generatedDir, `required_data_${effectivePageId}.json`);
const repoKnowledgePath = path.join(agentDir, `repo_knowledge.json`);

// Repo paths
const pageObjectsPath = path.join(repoRoot, "page-objects");
const referenceTestPath = path.join(repoRoot, "tests/a2-login/successfulLogin.test.ts");
const elementMapperPath = path.join(repoRoot, "tests/Playwright Element Mapper/ElementDiscovery.ts");

// ----------------------------
// Helpers
// ----------------------------
function normalizeText(x) {
    return String(x ?? "").replace(/\s+/g, " ").trim();
}

function isLikelyMetadataRow(row) {
    const text = normalizeText(Object.values(row || {}).join(" ")).toLowerCase();
    return (
        /document owner|owner \(pm\)|updates made|document created|date\b|last updated|author|version|approver|reviewed|stakeholder/.test(
            text
        ) ||
        (Object.keys(row || {}).length <= 2 && /\b(get|post|patch|put|delete)\b/.test(text))
    );
}

function deriveTestName(row, idx) {
    const subject = normalizeText(row?.Subject);
    if (subject) return subject;

    const epic = normalizeText(row?.Epic);
    if (epic) return epic;
    const first = Object.values(row || {}).map(normalizeText).find((v) => v.length > 0);
    return first ? first.slice(0, 90) : `Row ${idx + 1}`;
}

function shouldIncludeRow(row, idx) {
    if (!row || typeof row !== "object") return { include: false, reason: "row_not_object" };
    const values = Object.values(row).map(normalizeText).filter(Boolean);
    if (values.length === 0) return { include: false, reason: "row_empty" };

    const joined = normalizeText(values.join(" "));
    if (joined.replace(/\s+/g, "").length < 10) return { include: false, reason: "too_short" };
    if (isLikelyMetadataRow(row)) return { include: false, reason: "metadata_row" };

    if (
        !/(as a |given|when|then|should|must|expected|verify|returns|response|error|access|permission|visible|hidden|default|logic|endpoint|api|field|Verify that|BASIC SANITY)/i.test(
            joined
        )
    ) {
        return { include: true, reason: "permissive_inclusion" }; 
    }

    return { include: true, reason: "ok" };
}

function extractJiraKeyFromScenarioBundle(scenariosJsonObj) {
    const text = JSON.stringify(scenariosJsonObj || {});
    const m = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    return m ? m[1] : "";
}

function extractJiraKeyFromMarkdown(mdText) {
    const m = String(mdText || "").match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    return m ? m[1] : "";
}
function extractConfluencePageId(scenarios) {
    // Look for confluence page id in scenario details/additional fields
    const text = JSON.stringify(scenarios || {});
    const m = text.match(/confluence\s*page\s*id[:\s]*(\d+)/i);
    if (m) return m[1];
    // Also check in Details field specifically
    for (const s of (scenarios || [])) {
        const row = s?.row || s;
        const details = row?.Details || row?.Additional || '';
        const detailsMatch = details.match(/confluence\s*page\s*id[:\s]*(\d+)/i);
        if (detailsMatch) return detailsMatch[1];
    }
    return '';
}


function slugify(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/<[^>]+>/g, "")     // Remove HTML tags
        .replace(/[^a-z0-9]+/g, "_") // Replace non-alphanumeric with underscores
        .replace(/_{2,}/g, "_")      // Consolidate multiple underscores
        .replace(/^_+|_+$/g, "")    // Remove leading/trailing underscores
        .replace(/\.+$/g, "");       // Remove trailing dots
}

function deriveTestFileName({ pageTitle: t, scenarios: sc, pageId: pid, md }) {
    // 1. Get the first scenario row
    const firstScenario = Array.isArray(sc) && sc.length > 0 ? sc[0] : null;
    const firstRow = firstScenario?.row || firstScenario;
    
    // 2. Prioritize Epic or a short version of Subject
    let candidate = "";
    const epic = normalizeText(firstRow?.Epic);
    const subject = normalizeText(firstRow?.Subject);

    // If "Epic" exists and is descriptive (but not a whole sentence), use it
    if (epic && epic.length > 3 && epic.length < 80) {
        candidate = slugify(epic);
    }
    // Otherwise, use the full Subject (slugify will clean it up)
    else if (subject && subject.length > 3) {
        candidate = slugify(subject);
    } 
    // Fallback to page title or manual ID
    else {
        candidate = slugify(t || `manual_${pid}`);
    }

    // 3. FINAL GUARDRAIL: Ensure filename doesn't exceed 80 characters
    if (candidate.length > 80) {
        candidate = candidate.substring(0, 80);
    }

    return candidate.replace(/_+$/, '');
}
function esc(s) {
    return String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// --- Smart Scanner ---
function scanPageObjects(dir, fileList = [], baseDir = null) {
    if (!fs.existsSync(dir)) return fileList;
    const currentBase = baseDir || dir;
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            scanPageObjects(filePath, fileList, currentBase);
        } else if (file.endsWith(".ts")) {
            const content = fs.readFileSync(filePath, "utf8");
            const className = (content.match(/class\s+(\w+)/) || [])[1];
            if (className) {
                // Calculate import path relative to repo root
                const relativePath = path.relative(path.join(repoRoot, "page-objects"), filePath);
                const importPath = relativePath.replace(/\.ts$/, "").replace(/\\/g, "/");

                // Extract class-level JSDoc
                const descMatch = content.match(/\/\*\*([\s\S]*?)\*\//);
                const description = descMatch
                    ? descMatch[1].replace(/[*\/]/g, "").trim()
                    : "General purpose Page Object";

                // Extract full method details including signatures and JSDoc
                const methods = [];
                const methodRegex = /(?:\/\*\*\s*([\s\S]*?)\s*\*\/)?\s*async\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^\{]+))?/g;
                let match;
                while ((match = methodRegex.exec(content)) !== null) {
                    const [, jsdoc, methodName, params, returnType] = match;
                    methods.push({
                        name: methodName,
                        params: params ? params.trim() : "",
                        returnType: returnType ? returnType.trim() : "void",
                        jsdoc: jsdoc ? jsdoc.replace(/\s*\*\s?/g, " ").trim() : ""
                    });
                }

                // Extract locator definitions to understand what the PO can find
                const locators = [];
                const locatorRegex = /this\.(\w+)\s*=\s*(page\.locator|page\.getByRole|page\.getByText|page\.getByTestId)\(([^)]+)\)/g;
                let locMatch;
                while ((locMatch = locatorRegex.exec(content)) !== null) {
                    const [, name, locatorType, selector] = locMatch;
                    locators.push({ name, type: locatorType, selector: selector.slice(0, 100) });
                }

                fileList.push({
                    className,
                    importPath,
                    filePath: path.relative(repoRoot, filePath),
                    description,
                    methods,
                    locators: locators.slice(0, 10) // Limit to avoid too much noise
                });
            }
        }
    });
    return fileList;
}

function unescapeConfluenceMd(md) {
    return String(md || "")
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t");
}

function parseMarkdownTablesToScenarios(mdText) {
    const md = unescapeConfluenceMd(mdText);
    const lines = md.split("\n");
    const blocks = [];
    let cur = [];
    const isTableLine = (l) => {
        const s = l.trim();
        if (!s.includes("|")) return false;
        const pipeCount = (s.match(/\|/g) || []).length;
        return pipeCount >= 3 && (/[A-Za-z0-9]/.test(s) || /^[|\s-:]+$/.test(s));
    };

    for (const l of lines) {
        if (isTableLine(l)) {
            cur.push(l);
        } else {
            if (cur.length >= 2) blocks.push(cur);
            cur = [];
        }
    }
    if (cur.length >= 2) blocks.push(cur);

    const scenarios = [];
    for (const block of blocks) {
        const cleaned = block
            .map((l) => l.trim())
            .filter((l) => l.includes("|"))
            .map((l) => l.replace(/\s+\|\s+/g, " | ").replace(/^\|/, "").replace(/\|$/, "").trim());

        if (cleaned.length < 2) continue;

        const headerCells = cleaned[0].split("|").map((c) => c.trim()).filter(Boolean);
        let startRowIdx = 1;
        if (cleaned[1] && /^:?-{2,}:?(\s*\|\s*:?-{2,}:?)+$/.test(cleaned[1].replace(/\s+/g, " "))) {
            startRowIdx = 2;
        }

        const useHeaders = headerCells.length >= 2 && headerCells.some((h) => h.length > 2) ? headerCells : null;

        for (let i = startRowIdx; i < cleaned.length; i++) {
            const cells = cleaned[i].split("|").map((c) => c.trim());
            if (cells.every((c) => !c)) continue;

            const row = {};
            if (useHeaders) {
                for (let c = 0; c < useHeaders.length; c++) {
                    row[useHeaders[c]] = cells[c] ?? "";
                }
            } else {
                for (let c = 0; c < Math.min(8, cells.length); c++) {
                    row[`col${c + 1}`] = cells[c] ?? "";
                }
            }

            if (!row.Epic) {
                const epicKey = Object.keys(row).find((k) => /epic/i.test(k));
                if (epicKey) row.Epic = row[epicKey];
            }

            scenarios.push({
                source: { pageId: effectivePageId, from: "md_fallback" },
                row,
                tags: [],
            });
        }
    }
    return scenarios;
}

// ----------------------------
// Load inputs
// ----------------------------
const mdRaw = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : "";
const md = unescapeConfluenceMd(mdRaw);
const jiraRaw = fs.existsSync(jiraPath) ? fs.readFileSync(jiraPath, "utf8") : "";
const relatedContextRaw = fs.existsSync(relatedContextPath) ? fs.readFileSync(relatedContextPath, "utf8") : "";

let scenariosJson = { scenarios: [] };
if (fs.existsSync(scenariosPath)) {
    scenariosJson = JSON.parse(fs.readFileSync(scenariosPath, "utf8"));
}

let scenarios = Array.isArray(scenariosJson.scenarios) ? scenariosJson.scenarios : [];
let isRawFallback = false;

if (scenarios.length === 0) {
    const fallback = parseMarkdownTablesToScenarios(md);
    if (fallback.length > 0) {
        console.log(`\n[Fallback] scenarios_${effectivePageId}.json empty. Parsed ${fallback.length} from MD tables.`);
        scenarios = fallback;
    } else {
        console.log(`\n[Fallback] No scenarios found. Enabling Raw Fallback.`);
        isRawFallback = true;
    }
}

const brief = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, "utf8")) : {};

let pageTitle = brief?.pageTitle || brief?.title || (brief?.meta && (brief.meta.pageTitle || brief.meta.title));
if (!pageTitle || pageTitle.includes("confluence-")) {
    const h1Match = md.match(/^#\s+(.+)$/m);
    if (h1Match) pageTitle = h1Match[1].trim();
    else {
        const h2Match = md.match(/^##\s+(.+)$/m);
        if (h2Match) pageTitle = h2Match[1].trim();
    }
}
if (!pageTitle) pageTitle = `confluence_${effectivePageId}`;

const testData = fs.existsSync(testDataPath) ? JSON.parse(fs.readFileSync(testDataPath, "utf8")) : {};
const happyRole = (testData?.HAPPY_PATH_USER_ROLE || "admin").trim();

const requiredSpec = fs.existsSync(requiredDataSpecPath)
    ? JSON.parse(fs.readFileSync(requiredDataSpecPath, "utf8"))
    : { required: [] };

const repoKnowledge = fs.existsSync(repoKnowledgePath)
    ? JSON.parse(fs.readFileSync(repoKnowledgePath, "utf8"))
    : {};

const requiredKeys = Array.isArray(requiredSpec.required)
    ? requiredSpec.required.map((x) => x.key).filter(Boolean)
    : [];

// ----------------------------
// Accountability report
// ----------------------------
const decisions = [];
for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const row = s?.row || s;
    const { include, reason, text } = shouldIncludeRow(row, i);
    const testName = include ? deriveTestName(row, i) : null;

    decisions.push({
        index: i + 1,
        include,
        reason,
        text,
        testName,
        tags: s?.tags || [],
        rowPreview: Object.fromEntries(
            Object.entries(row || {})
                .slice(0, 8)
                .map(([k, v]) => [k, normalizeText(v).slice(0, 180)])
        ),
    });
}

const included = decisions.filter((d) => d.include);
let scenariosIncluded = included.map((d) => scenarios[d.index - 1]);

if (scenariosIncluded.length === 0 && !isRawFallback) {
    console.log(`\n[Fallback] No testable rows found. Enabling Raw Fallback.`);
    isRawFallback = true;
}

const reportPath = path.join(generatedDir, `generation_report_${effectivePageId}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ pageId: effectivePageId, pageTitle, totalRows: scenarios.length, includedRows: included.length, decisions, notes: { isRawFallback }}, null, 2));

// ----------------------------
// Page Object map
// ----------------------------
const infraMap = scanPageObjects(pageObjectsPath);
const referenceTest = fs.existsSync(referenceTestPath) ? fs.readFileSync(referenceTestPath, "utf8") : "";
const elementMapperContent = fs.existsSync(elementMapperPath) ? fs.readFileSync(elementMapperPath, "utf8") : "";
const allScenarioText = (JSON.stringify(scenariosIncluded) + md).toLowerCase();

const poShortcutsPath = path.join(agentDir, "po_shortcuts.json");
const poShortcuts = fs.existsSync(poShortcutsPath) ? JSON.parse(fs.readFileSync(poShortcutsPath, "utf8")) : {};

const filteredInfra = infraMap
    .filter((po) => {
        const hasShortcutMatch = Object.keys(poShortcuts).some(
            (key) => allScenarioText.includes(key.toLowerCase()) && poShortcuts[key].includes(po.className)
        );
        const hasTextMatch = allScenarioText.includes(po.className.toLowerCase().replace("page", ""));
        return hasShortcutMatch || hasTextMatch;
    })
    .slice(0, 15);

const infraSummary = filteredInfra
    .map((i) => {
        const methodDetails = i.methods.map(m => {
            const sig = `  - ${m.name}(${m.params})${m.returnType !== 'void' ? `: ${m.returnType}` : ''}`;
            const doc = m.jsdoc ? `    // ${m.jsdoc.substring(0, 120)}${m.jsdoc.length > 120 ? '...' : ''}` : '';
            return sig + (doc ? '\n' + doc : '');
        }).join('\n');
        const locatorDetails = i.locators?.length ? '\nKEY LOCATORS:\n' + i.locators.map(l => `  - ${l.name}: ${l.type}(${l.selector.substring(0, 50)}...)`).join('\n') : '';
        return `CLASS: ${i.className}
IMPORT: import { ${i.className} } from '../../page-objects/${i.importPath}';
USE FOR: ${i.description}
METHODS:
${methodDetails}${locatorDetails}`;
    })
    .join("\n\n---\n\n");

// ----------------------------
// Clarification Detection
// ----------------------------
// Dynamically import clarification manager only when needed
async function checkAndRequestClarifications() {
    // Only request clarifications for manual scenarios where we might be missing context
    if (effectivePageId !== 'manual' || scenariosIncluded.length === 0) return;

    const { requestClarification } = await import('./clarification_manager.mjs');

    // Check 1: Low Page Object coverage
    if (filteredInfra.length === 0) {
        requestClarification({
            type: 'Missing Page Objects',
            pageId: effectivePageId,
            question: `No matching Page Objects found for this scenario. The scenario mentions: "${pageTitle}". Which Page Object should handle these actions?`,
            file: '2_test_generator.mjs',
            method: 'checkAndRequestClarifications',
            hint: 'Common options: LeftSideMenu, Applications, Settings, ConfigurePage - or specify the exact class name',
            required: false
        });
    }

    // Check 2: Scenario contains unclear UI actions
    const scenarioText = JSON.stringify(scenariosIncluded).toLowerCase();
    const unclearActions = ['click', 'select', 'open', 'navigate'].filter(action =>
        scenarioText.includes(action) && !filteredInfra.some(po =>
            po.methods.some(m => m.name.toLowerCase().includes(action))
        )
    );

    if (unclearActions.length > 0) {
        requestClarification({
            type: 'Unclear UI Actions',
            pageId: effectivePageId,
            question: `The scenario uses these actions but no matching PO methods found: ${unclearActions.join(', ')}. What UI elements are being interacted with?`,
            file: '2_test_generator.mjs',
            method: 'checkAndRequestClarifications',
            hint: 'Describe the UI elements (e.g., "dropdown in left sidebar", "settings gear icon", "table row")',
            required: false
        });
    }
}

// Run clarification detection (async, non-blocking)
checkAndRequestClarifications().catch(() => {});

// ----------------------------
// Output filename logic
// ----------------------------
const outDir = path.join(repoRoot, "tests/generated-from-agentFallBack");
fs.mkdirSync(outDir, { recursive: true });

const jiraKey = extractJiraKeyFromMarkdown(md) || extractJiraKeyFromScenarioBundle(scenariosJson);
const confluencePageId = extractConfluencePageId(scenarios) || effectivePageId;
const jiraPrefix = jiraKey ? `${jiraKey}_` : "";

const baseName = deriveTestFileName({ pageTitle, scenarios: scenariosIncluded, pageId: effectivePageId, md });

// Rule: No redundant suffixes if name is descriptive
const finalFileName = `${jiraPrefix}${baseName}`;
const outFile = path.join(outDir, `${finalFileName}.test.ts`);

// Specification stays in agent folder
const specFile = path.join(generatedDir, `spec_${effectivePageId}.md`);

// ----------------------------
// Generate Spec File
// ----------------------------
const specContent = `
# Test Specification: ${pageTitle}
**Page ID:** ${effectivePageId}
**Jira Key:** ${jiraKey || "N/A"}
**Generated At:** ${new Date().toISOString()}

## Scenarios
${scenariosIncluded.map((s, i) => `| ${i + 1} | ${deriveTestName(s.row || s, i)} |`).join("\n")}
${isRawFallback ? "| 1 | Derived from raw content |" : ""}

## Execution
\`\`\`bash
npx playwright test tests/generated-from-agentFallBack/${path.basename(outFile)}
\`\`\`
`;

fs.writeFileSync(specFile, specContent, "utf8");
console.log("Saved Spec to Generated folder:", specFile);

// ----------------------------
// Generate test skeleton
// ----------------------------
const testImport = repoKnowledge.conventions?.testFrameworkImport 
    ? `import { test, expect } from '${repoKnowledge.conventions.testFrameworkImport}';`
    : `import { test, expect } from '@playwright/test';`;

let skeleton = `/**
 * 🤖 AI AGENT HANDOVER NOTE
 * CONTEXT:
 * - Page ID: ${effectivePageId}
 * - Jira Key: ${jiraKey || "N/A"}
 * - Report: agent/generation_report_${effectivePageId}.json
 */

${testImport}
import { LoginPage } from '../../page-objects/login/LoginPage';
import { UserProvider } from '../../utils/UserProvider';

interface TestScenario {
  name: string;
  user: any;
  data: any;
  dataInputs: Record<string, any>;
}

const REQUIRED_DATA_KEYS: string[] = ${JSON.stringify(requiredKeys, null, 2)};
const DATA_INPUTS: Record<string, any> = ${JSON.stringify(testData, null, 2)};

function missingKeys(keys: string[], data: Record<string, any>) {
  return (keys || []).filter(k => data?.[k] === undefined || data?.[k] === null || data?.[k] === '');
}

test.describe.configure({ mode: 'parallel' });

test.describe('${esc(jiraKey ? `${jiraKey} - ` : "")}${esc(pageTitle)}', () => {
  
  test.beforeEach(async () => {
      test.info().annotations.push({ type: 'Owner', description: 'Eyal Sooliman' });
      ${jiraKey ? `test.info().annotations.push({ type: 'Story', description: '${jiraKey}' });` : ""}
      ${jiraKey ? `test.info().annotations.push({ type: 'Issue', description: 'https://crossixsolutions.atlassian.net/browse/${jiraKey}' });` : ""}
      test.info().annotations.push({ type: 'ConfluencePage', description: '${confluencePageId}' });
      test.info().annotations.push({ type: 'Description', description: '${esc(pageTitle)}' });
  });
`;

if (isRawFallback) {
    skeleton += `
  test('Manual Execution', { tag: ['@beta'] }, async ({ page }) => {
    const user = UserProvider.getUserByRole('${esc(happyRole)}');
    const loginPage = new LoginPage(page);
    await loginPage.resetSession?.();
    await loginPage.navigateToLoginPage?.();
    await loginPage.login(user.username, user.password);
    await loginPage.expectLoginSuccess?.();

    // AI_IMPLEMENTATION_START
    // RULE 1: Use Page Object methods from PAGE OBJECT MAP. NO raw page.locator() calls if PO method exists!
    // Example: const leftSideMenu = new LeftSideMenu(page); await leftSideMenu.openMenu();
    // RULE 2: Use utils/ folder for S3, DB, CSV, API operations FIRST. Check utils/ for existing helpers before writing new code!
    // Example: import { query } from '../../../utils/db/dbUtil'; import { getS3FileContentAsString } from '../../../utils/s3/s3Helper';
    // RULE 3: USE DB QUERIES for data-driven testing and cleanup:
    //   - PRE-TEST: Query DB to get existing data (IDs, names) instead of hardcoding
    //   - VERIFICATION: Query DB to verify UI operations (count rows, check status)
    //   - CLEANUP/ROLLBACK: After create/update operations, delete from DB to restore state
    // Example: const { query } = await import('../../../utils/db/dbUtil');
    //          const result = await query('SELECT Id FROM Brand WHERE Name = @name', [{name:'name', type:sql.NVarChar, value:'TestBrand'}]);
    //          await query('DELETE FROM dbo.Brand WHERE Id = @id', [{name:'id', type:sql.Int, value:result.recordset[0].Id}]);
    // AI_IMPLEMENTATION_END
  });
`;
} else {
    scenariosIncluded.forEach((s, idx) => {
        const rowObj = s?.row || s;
        const testName = esc(deriveTestName(rowObj, idx));
        skeleton += `
  test('${testName}', { tag: ['@beta'] }, async ({ page }) => {
    const scenario: TestScenario = {
      name: '${testName}',
      user: UserProvider.getUserByRole('${esc(happyRole)}'),
      data: ${JSON.stringify(rowObj, null, 2)},
      dataInputs: DATA_INPUTS
    };

    const missing = missingKeys(REQUIRED_DATA_KEYS, scenario.dataInputs);
    test.skip(missing.length > 0, 'Missing required data inputs: ' + missing.join(', '));

    const loginPage = new LoginPage(page);
    await loginPage.resetSession?.();
    await loginPage.navigateToLoginPage?.();
    await loginPage.login(scenario.user.username, scenario.user.password);
    await loginPage.expectLoginSuccess?.();

    // AI_IMPLEMENTATION_START
    // RULE 1: Use Page Object methods from PAGE OBJECT MAP. NO raw page.locator() calls if PO method exists!
    // Example: const leftSideMenu = new LeftSideMenu(page); await leftSideMenu.openMenu();
    // RULE 2: Use utils/ folder for S3, DB, CSV, API operations FIRST. Check utils/ for existing helpers before writing new code!
    // Example: import { query } from '../../../utils/db/dbUtil'; import { getS3FileContentAsString } from '../../../utils/s3/s3Helper';
    // RULE 3: USE DB QUERIES for data-driven testing and cleanup:
    //   - PRE-TEST: Query DB to get existing data (IDs, names) instead of hardcoding
    //   - VERIFICATION: Query DB to verify UI operations (count rows, check status)
    //   - CLEANUP/ROLLBACK: After create/update operations, delete from DB to restore state
    // Example: const { query } = await import('../../../utils/db/dbUtil');
    //          const result = await query('SELECT Id FROM Brand WHERE Name = @name', [{name:'name', type:sql.NVarChar, value:'TestBrand'}]);
    //          await query('DELETE FROM Brand WHERE Id = @id', [{name:'id', type:sql.Int, value:result.recordset[0].Id}]);
    // AI_IMPLEMENTATION_END
  });
`;
    });
}

skeleton += `\n});\n`;

// Ensure directory exists again just in case
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}
fs.writeFileSync(outFile, skeleton, "utf8");

// --- Save Metadata for downstream steps ---
const metadataPath = path.join(generatedDir, "last_generated_test.json");
fs.writeFileSync(metadataPath, JSON.stringify({
    absPath: path.resolve(outFile),
    fileName: path.basename(outFile),
    pageId: effectivePageId,
    generatedAt: new Date().toISOString()
}, null, 2));
console.log("Metadata saved to:", metadataPath);

// ----------------------------
// Handover prompt
// ----------------------------
let prompt = `
🚨 CRITICAL: MARKERS ARE YOUR ONLY COMMUNICATION CHANNEL
🚨 The automation script CANNOT read your explanations - it ONLY reads code between markers.

TASK: Complete Playwright test implementation between // AI_IMPLEMENTATION_START and // AI_IMPLEMENTATION_END markers.

MARKER COMMUNICATION RULES:
❌ DO NOT write explanations outside the markers
❌ DO NOT move, rename, or delete the markers  
✅ ALL Playwright logic MUST be strictly between the markers
✅ The script extracts ONLY the code between these markers

FRAMEWORK REQUIREMENTS:

MANDATORY WORKFLOW - FOLLOW THESE STEPS IN ORDER:

STEP 1 - ANALYZE THE SCENARIO:
   - Read the test scenario carefully
   - Identify every UI action needed (click, select, navigate, fill, etc.)

STEP 2 - SEARCH PAGE OBJECT MAP (MANDATORY):
   - For EACH action, scan the PAGE OBJECT MAP below for matching methods
   - Look for method names that describe the action: selectSettings(), openMenu(), clickAddButton(), etc.
   - Check method parameters to ensure they match your needs
   - IF a matching method exists → GO TO STEP 3
   - IF no matching method exists → GO TO STEP 4

STEP 3 - USE EXISTING PAGE OBJECT METHOD (Priority 1):
   - Instantiate: const poName = new PageObjectClass(page);
   - Call the method: await poName.existingMethod(params);
   - Add STEP log: console.log('STEP: <description>');
   - YOU MUST USE THIS - NO RAW LOCATORS ALLOWED WHEN PO METHOD EXISTS

STEP 4 - CHECK FOR EXTENSION OPPORTUNITY (Priority 2):
   - Does a relevant Page Object exist but lack the specific method?
   - Add the new method to the existing Page Object class
   - Follow existing patterns (async, STEP logs, return types)
   - Return updated code in /* FILE: path/to/file.ts */ block
   - Then use your new method per STEP 3

STEP 5 - CREATE NEW PAGE OBJECT (Priority 3):
   - Only if NO relevant Page Object exists at all
   - Follow repository patterns (class structure, async methods, STEP logs)
   - Return new code in /* FILE: path/to/file.ts */ block

STEP 6 - INLINE RAW LOCATORS (Last Resort - Forbidden unless truly unique):
   - ONLY if the action is completely unique with no PO coverage
   - Example: One-off interactions that don't fit any pattern

🚫 ABSOLUTELY FORBIDDEN:
   - Writing 'page.locator(...)' or 'page.getBy...' when a PO method exists for that action
   - Creating new PO methods without first checking if they already exist
   - Skipping the PAGE OBJECT MAP search step

✅ EXAMPLES OF CORRECT USAGE:
   - WRONG:  await page.locator('.icon-settings').click();
   - RIGHT:  await topRightMenu.selectSettings('Applications');

   - WRONG:  await page.locator('[data-hook="left-menu"]').click();
   - RIGHT:  await leftSideMenu.openMenu();

   - WRONG:  await page.locator('text=Brands').click();
   - RIGHT:  await leftSideMenu.selectViewOption('Brands');

CONFLUENCE:
- PageId: ${effectivePageId}
- Title: ${pageTitle}
- JiraKey: ${jiraKey || "N/A"}

REFERENCE STYLE:
${referenceTest}

PAGE OBJECT MAP:
${infraSummary}

ELEMENT MAPPER:
${elementMapperContent}

REPO KNOWLEDGE:
${JSON.stringify(repoKnowledge, null, 2)}

DATA INPUTS:
- DATA_INPUTS are loaded from agent/test_data_${effectivePageId}.json
- Use scenario.dataInputs.<KEY>

CURRENT CODE SKELETON:
\`\`\`typescript
${skeleton}
\`\`\`

IMPLEMENTATION REQUIREMENTS:
🎯 EVERY scenario step MUST become a Playwright action
🎯 EVERY major action MUST have: await console.log('<description>')
🎯 ALL code MUST be between // AI_IMPLEMENTATION_START and // AI_IMPLEMENTATION_END

EXAMPLE FORMAT (Page Object Style - PREFERRED):
// AI_IMPLEMENTATION_START
// Import and instantiate Page Objects from PAGE OBJECT MAP
import { LeftSideMenu } from '../../page-objects/leftSideMenu/LeftSideMenu';
import { Applications } from '../../page-objects/settings/applications/application/Applications';

const leftSideMenu = new LeftSideMenu(page);
const applications = new Applications(page);

await console.log('STEP: Opening left side menu');
await leftSideMenu.openMenu();

await console.log('STEP: Selecting Brands view from dropdown');
await leftSideMenu.selectViewOption('Brands');

await console.log('STEP: Verifying table loaded');
await applications.waitForTableLoad();
// AI_IMPLEMENTATION_END

⚠️  NEVER USE raw locators like 'page.locator(".left-menu-toggle")' when a Page Object method exists!
⚠️  The PAGE OBJECT MAP above shows all available methods - USE THEM.

DATABASE OPERATIONS (Use utils/db/dbUtil):
When the scenario involves data verification, creation, or cleanup:

1. PRE-TEST DATA QUERY:
   - Query DB to get existing IDs/names instead of hardcoding
   - Example: Get a valid ClientId to use in brand creation

2. DATA VERIFICATION:
   - Query DB to verify UI operations succeeded
   - Example: Count rows in table, check record status

3. DETECTION OF DESTRUCTIVE ACTIONS & SMART ROLLBACK:
   - Scan the test scenario for keywords like "Create", "Add", "Assign", "Insert", or "Edit".
   - If a destructive action is found, you MUST generate unique identifiers (e.g., const uniqueName = 'Agent_' + Date.now();) to ensure the cleanup logic targets the correct record.
   - The main test logic MUST be inside a 'try' block.
   - The 'finally' block MUST contain the cleanup logic.
   - PREFERRED CLEANUP: Use utils/db/dbUtil to execute a DELETE or UPDATE query.
   - ALTERNATIVE CLEANUP: Call a "Deactivate" or "Remove" method from a Page Object.

DB IMPORT PATTERN FOR FINALLY BLOCK:

const { query } = await import('../../../utils/db/dbUtil');
const sql = await import('mssql');

// Query existing data (PRE-TEST)
const result = await query('SELECT Id, Name FROM Client WHERE IsActive = 1');
const clientId = result.recordset[0]?.Id;

try {
  // Main test logic...
} finally {
  // Cleanup after test
  await query('DELETE FROM Brand WHERE Name = @name', [
    { name: 'name', type: sql.NVarChar, value: brandName }
  ]);
}


⚠️  REMINDER: The automation script ONLY extracts code between the markers. Nothing else matters.

FINAL INSTRUCTION:
Provide your complete response exactly matching the format below. Do not add any text before or after these markers.

// AI_IMPLEMENTATION_START
[Your Playwright code here...]
// AI_IMPLEMENTATION_END
`;

const promptPath = path.join(generatedDir, `prompt_for_llm_${effectivePageId}.txt`);
fs.writeFileSync(promptPath, prompt, "utf8");

// ---- Update task_state.json ----
const statePath = path.join(agentDir, 'task_state.json');
let state = {};
if (fs.existsSync(statePath)) {
    try {
        state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch(e) {}
}
state.currentAgent = 'testGenerator';
state.testGenerator = {
    testFilePath: outFile,
    testFileName: path.basename(outFile),
    pageId: effectivePageId,
    scenariosExtracted: scenarios.length,
    dataInputs: testData,
    promptPath: promptPath,
    repoKnowledgeUsed: repoKnowledgePath,
    completed: true,
    generatedAt: new Date().toISOString()
};
state.status = 'GENERATED';
state.logs = state.logs || [];
state.logs.push({
    agent: 'testGenerator',
    timestamp: new Date().toISOString(),
    message: `Generated test skeleton: ${path.basename(outFile)} with ${scenarios.length} scenarios`
});
fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
console.log("Updated task_state.json");

console.log("\n**********************************************");
console.log("Test Generator finished.");
console.log("QA Engineer is now starting to work...");
console.log("**********************************************");
console.log("\nGenerated:", outFile);
console.log("Prompt:", promptPath);
console.log("Jira key:", jiraKey || "(none)");
if (isRawFallback) console.log("RAW FALLBACK ENABLED");