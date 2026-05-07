// agent/run_one_page_multi_task.mjs
// Local-only Smart Runner (no CI): Confluence pages + Jira -> scenarios -> required data -> auto-fill -> ask only when needed -> generate tests
//
// Usage (PowerShell):
//   node run_one_page_multi_task.mjs --pageIds 4373610556,3440377887 --mode smart --cloudId 42b193d0-5d4a-4f64-a88f-130d5949311f
//   node run_one_page_multi_task.mjs --pageIds 4373610556 --mode simple
//   node run_one_page_multi_task.mjs --jiraKeys DN-1291 --mode smart
//
// What it writes (per pageId or jiraKey):
//   agent/generated/page_<id>.md
//   agent/generated/brief_<id>.json
//   agent/generated/scenarios_<id>.json
//   agent/generated/jira_<KEY>.txt (if detected)
//   agent/generated/required_data_<id>.json
//   agent/generated/test_data_<id>.json
//
// What it runs (if present):
//   node 21_generate_tests_repo_aware.mjs --pageId <id>
//   node 22_gemini_refine.mjs --pageId <id>          (optional)
//   node 23_verify_and_heal.mjs --pageId <id>        (optional)
//   node 24_architect_page_objects.mjs --pageId <id> (optional)
//   node 24_refactor_to_po.mjs --pageId <id>         (optional)
//
// IMPORTANT:
// - This runner terminates the Atlassian MCP proxy process itself (no Ctrl+C required).
// - It avoids selecting "Document owner / Updates made / Date" tables and prefers testable requirement tables.
// - If tables are not parseable, it falls back to headings/bullets.
//
// ------------------------------
// Imports
// ------------------------------
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import {spawn} from "node:child_process";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

// ------------------------------
// Args / env
// ------------------------------
const agentDir = process.cwd();           // run from agent/
const repoRoot = path.resolve(agentDir, "..");
const generatedDir = path.join(agentDir, "generated");

// Ensure generated directory exists
if (!fs.existsSync(generatedDir)) {
    fs.mkdirSync(generatedDir, { recursive: true });
}

function argValue(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 ? process.argv[idx + 1] : null;
}

const CLOUD_ID =
    argValue("--cloudId") ||
    process.env.CLOUD_ID ||
    "42b193d0-5d4a-4f64-a88f-130d5949311f";

const MODE = (argValue("--mode") || "smart").toLowerCase(); // simple | smart
const pageIdsRaw =
    argValue("--pageIds") ||
    argValue("--pageId") ||
    process.env.CONFLUENCE_PAGE_ID ||
    "";

const jiraKeysRaw =
    argValue("--jiraKeys") ||
    argValue("--jiraKey") ||
    "";

if (!pageIdsRaw && !jiraKeysRaw) {
    console.error("❌ Missing --pageIds or --jiraKeys.");
    process.exit(1);
}
if (!["simple", "smart"].includes(MODE)) {
    console.error(`❌ Invalid --mode "${MODE}". Use: simple | smart`);
    process.exit(1);
}

const PAGE_IDS = pageIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const JIRA_KEYS = jiraKeysRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

console.log("Starting Smart Runner");
console.log("Mode:", MODE);
console.log("CloudId:", CLOUD_ID);
if (PAGE_IDS.length) console.log("Pages:", PAGE_IDS.join(", "));
if (JIRA_KEYS.length) console.log("Jira Keys:", JIRA_KEYS.join(", "));
console.log("RepoRoot:", repoRoot);
console.log("AgentDir:", agentDir);
console.log("GeneratedDir:", generatedDir);

// ------------------------------
// Files
// ------------------------------
const pPageMd = (pageId) => path.join(generatedDir, `page_${pageId}.md`);
const pBrief = (pageId) => path.join(generatedDir, `brief_${pageId}.json`);
const pScenarios = (pageId) => path.join(generatedDir, `scenarios_${pageId}.json`);
const pRequired = (pageId) => path.join(generatedDir, `required_data_${pageId}.json`);
const pTestData = (pageId) => path.join(generatedDir, `test_data_${pageId}.json`);
const pRepoKnowledge = () => path.join(agentDir, "repo_knowledge.json"); // Keep repo knowledge in agent root
const pJiraText = (key) => path.join(generatedDir, `jira_${key}.txt`);
const pRelatedContext = (pageId) => path.join(generatedDir, `related_context_${pageId}.md`);

// ------------------------------
// JSON helpers
// ------------------------------
function writeJson(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}
function readJsonIfExists(file, fallback = null) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}
function ensureDirFor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
}

// ------------------------------
// Markdown normalization + stats
// ------------------------------
function normalizeMd(md) {
    if (!md) return "";
    // Common case: server returns literal "\n" sequences in one long line
    if (md.includes("\\n") && !md.includes("\n")) md = md.replace(/\\n/g, "\n");
    return md;
}

function extractStatsFromMarkdown(md) {
    const headingsCount = (md.match(/^#{1,6}\s+/gm) || []).length;
    const bulletsCount = (md.match(/^\s*[-*]\s+/gm) || []).length;
    const tableLinesCount = (md.match(/^\|.*\|\s*$/gm) || []).length;
    const pipeHeavyCount = (md.match(/\|/g) || []).length;
    return {
        mdChars: md.length,
        headingsCount,
        bulletsCount,
        tableLinesCount,
        pipeHeavyCount,
    };
}

function extractJiraKeysAndUrls(text) {
    const urls = Array.from(text.matchAll(/https?:\/\/[^\s)]+/g)).map((m) => m[0]);
    const jiraUrls = urls.filter((u) => /atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+/.test(u));
    const jiraKeys = Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)).map((m) => m[1]);
    return { jiraUrls, jiraKeys: Array.from(new Set(jiraKeys)) };
}

function extractConfluenceLinks(text) {
    // Matches /wiki/spaces/SPACE/pages/12345 or /pages/12345
    const pageIds = Array.from(text.matchAll(/\/pages\/(\d+)/g)).map(m => m[1]);
    return Array.from(new Set(pageIds));
}

// ------------------------------
// Atlassian MCP connection (local proxy via mcp-remote)
// ------------------------------
async function connectAtlassianMcp() {
    console.log("Discovering OAuth server configuration...");
    console.log(`[${process.pid}] Connecting to remote server: https://mcp.atlassian.com/v1/mcp`);

    const transport = new StdioClientTransport({
        command: "npx",
        args: ["mcp-remote@latest", "https://mcp.atlassian.com/v1/mcp"],
        env: process.env,
    });

    const client = new Client(
        { name: "bw-agent-runner", version: "0.3.0" },
        { capabilities: {} }
    );

    await client.connect(transport);

    // Ensure we can kill the child process so you never need Ctrl+C
    const kill = () => {
        try {
            // Different SDK versions expose it differently
            const cp = transport.process || transport._process || transport.childProcess;
            if (cp && !cp.killed) cp.kill();
        } catch {}
    };

    return { client, transport, kill };
}

function pickTool(tools, exactName) {
    return tools.find((t) => t.name === exactName);
}

function toolText(res) {
    return (res?.content || [])
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
}

async function atlassianFetchPageMarkdown(client, cloudId, pageId) {
    const { tools } = await client.listTools();
    const tGet = pickTool(tools, "getConfluencePage");
    if (!tGet) throw new Error("Missing tool getConfluencePage in Atlassian MCP tools list.");

    const res = await client.callTool({
        name: tGet.name,
        arguments: { cloudId, pageId, contentFormat: "markdown" },
    });

    return toolText(res);
}

async function atlassianFetchJiraIssueByKey(client, cloudId, issueKey) {
    const { tools } = await client.listTools();
    const tGet = pickTool(tools, "getJiraIssue");
    if (!tGet) return null;

    const res = await client.callTool({
        name: tGet.name,
        arguments: { cloudId, issueIdOrKey: issueKey },
    });

    return toolText(res) || null;
}

// ------------------------------
// Table parsing / selection (FIXED)
// ------------------------------

// Extract contiguous markdown-table blocks
function extractTableBlocks(md) {
    const lines = md.split("\n");
    const blocks = [];
    let buf = [];

    const isTableLine = (line) => /^\|.*\|\s*$/.test(line);

    for (const line of lines) {
        if (isTableLine(line)) {
            buf.push(line);
        } else {
            if (buf.length >= 2) blocks.push(buf);
            buf = [];
        }
    }
    if (buf.length >= 2) blocks.push(buf);
    return blocks;
}

function parseTableBlock(tableLines) {
    // Try to handle common markdown table formats:
    // | a | b |
    // |---|---|
    // | 1 | 2 |
    const clean = (line) => line.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
    const split = (line) => clean(line).split("|").map((s) => s.trim());

    if (!tableLines?.length) return null;

    // Detect separator line like |---|---|
    const looksLikeSeparator = (line) => {
        const c = clean(line);
        return c.split("|").every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
    };

    let headerLine = tableLines[0];
    let dataStart = 1;

    // If line 1 is separator, header is line0; if line0 is separator (rare), bail
    if (looksLikeSeparator(tableLines[0])) return null;

    if (tableLines[1] && looksLikeSeparator(tableLines[1])) {
        dataStart = 2;
    }

    const header = split(headerLine).map((h) => h || "");
    const dataRows = [];

    for (const line of tableLines.slice(dataStart)) {
        const row = split(line);
        // Normalize row length to header length
        while (row.length < header.length) row.push("");
        dataRows.push(row.slice(0, header.length));
    }

    return { header, dataRows };
}

function rowLooksLikeChangelog(rowObj) {
    const text = JSON.stringify(rowObj || {}).toLowerCase();
    // These are the classic "metadata tables" we do NOT want as tests:
    return /(document owner|owner \(pm\)|updates made|document created|created\s+by|last updated|date\b|version\b|reviewed|approver|stakeholder)/.test(
        text
    );
}

function inferTagsFromText(text) {
    const t = String(text || "").toLowerCase();
    const tags = [];
    if (/(api|endpoint|response|request|status code|http|patch|get|post|put|delete)/.test(t)) tags.push("api");
    if (/(ui|click|button|page|navigate|screen|modal|dropdown|filter|home page)/.test(t)) tags.push("ui");
    if (/(access|permission|role|profile|capabilit|guard)/.test(t)) tags.push("access");
    if (/(db|dbo\.|sql|table|hidden\s*=\s*1|campaignvisibility\.hidden)/.test(t)) tags.push("db");
    return tags.length ? tags : ["auto"];
}

// Score and choose best table for test generation
function chooseBestTable(md) {
    const blocks = extractTableBlocks(md);
    if (!blocks.length) return { best: null, candidates: [] };

    const candidates = blocks
        .map((lines, idx) => {
            const parsed = parseTableBlock(lines);
            if (!parsed) return null;

            const headerText = parsed.header.join(" | ").toLowerCase();
            const sampleRows = parsed.dataRows.slice(0, 6).map((r) => r.join(" | ")).join("\n").toLowerCase();
            const combined = headerText + "\n" + sampleRows;

            let score = 0;
            const reasons = [];

            // Prefer “requirements-ish” headers/rows
            if (/(User Stories| User Story|Acceptance Criteria|Wireframe|Jira Issue|Priority|Open Questions|scenario|given|when|then|expected|acceptance|criteria|steps|user story|requirement|epic|story|behavior|description|As a PM|As a user|API Field|Source|Login|Example|Notes|Purpose)/.test(combined)) {
                score += 12; reasons.push("requirements_keywords");
            }

            // Prefer multiple rows (but not too much weighting)
            score += Math.min(10, parsed.dataRows.length);
            reasons.push(`rows=${parsed.dataRows.length}`);

            // Penalize metadata/changelog tables
            if (/(document owner|owner \(pm\)|Target Release|Epic|Document status|updates made|document created|created\s+by|last updated|date\b)/.test(combined)) {
                score -= 20; reasons.push("metadata_penalty");
            }

            // Penalize tables where most rows look like changelog
            const rowObjs = parsed.dataRows.slice(0, 10).map((row) => {
                const obj = {};
                parsed.header.forEach((h, i) => (obj[h || `col${i + 1}`] = row[i] ?? ""));
                return obj;
            });
            const metaCount = rowObjs.filter(rowLooksLikeChangelog).length;
            if (metaCount >= Math.ceil(rowObjs.length * 0.6)) {
                score -= 15; reasons.push(`meta_rows_penalty=${metaCount}/${rowObjs.length}`);
            }

            // Extra preference: tables with “Epic” or “Scenario” columns
            if (/(^|\|)\s*(epic|scenario|title|name)\s*(\||$)/i.test(parsed.header.join(" | "))) {
                score += 6; reasons.push("has_epic_or_scenario_col");
            }

            return {
                idx,
                score,
                reason: reasons.join(","),
                lines,
                parsed,
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

    return { best: candidates[0] || null, candidates };
}

function buildScenariosFromMarkdown(pageId, mdRaw) {
    const md = normalizeMd(mdRaw);
    const { best, candidates } = chooseBestTable(md);

    if (best?.parsed && best.score >= 5) {
        const { header, dataRows } = best.parsed;
        const scenarios = [];

        for (const row of dataRows) {
            const obj = {};
            header.forEach((h, i) => { obj[h || `col${i + 1}`] = row[i] ?? ""; });

            if (rowLooksLikeChangelog(obj)) continue;

            const body = JSON.stringify(obj);
            const hasBehavior = /(as a |given|when|then|should|must|expected|verify|returns|status|response|error|access|Verify that|BASIC SANITY - EXPANDED)/i.test(body);
            if (!hasBehavior) continue;

            const epic =
                obj["Epic"] ||
                obj["Scenario"] ||
                obj["Title"] ||
                obj["Name"] ||
                obj[header[0]] ||
                row[0] ||
                "Scenario";

            scenarios.push({
                source: { pageId },
                tableHeaders: header,
                row: { Epic: String(epic).trim(), ...obj },
                tags: inferTagsFromText(body),
            });
        }

        return {
            pageId,
            extractedAt: new Date().toISOString(),
            chosenTable: { score: best.score, reason: best.reason, header },
            topCandidates: (candidates || []).slice(0, 3).map((c) => ({
                score: c.score,
                reason: c.reason,
                header: c.parsed?.header || [],
            })),
            counts: { tableLines: dataRows.length + 1, scenarios: scenarios.length },
            scenarios,
        };
    }

    // fallback: headings + bullets
    const lines = md.split("\n");
    const scenarios = [];
    let currentH = "";

    for (const line of lines) {
        const h = line.match(/^#{1,6}\s+(.*)$/);
        if (h) currentH = h[1].trim();

        const b = line.match(/^\s*[-*]\s+(.*)$/);
        if (b && currentH) {
            scenarios.push({
                source: { pageId },
                tableHeaders: ["Section", "Text"],
                row: { Epic: currentH, Section: currentH, Text: b[1].trim() },
                tags: ["bullet"],
            });
        }
    }

    return {
        pageId,
        extractedAt: new Date().toISOString(),
        chosenTable: null,
        topCandidates: (candidates || []).slice(0, 3).map((c) => ({
            score: c.score,
            reason: c.reason,
            header: c.parsed?.header || [],
        })),
        counts: { tableLines: 0, scenarios: scenarios.length },
        scenarios,
    };
}

// ------------------------------
// Required data detection (conservative, but extendable)
// ------------------------------
function detectRequiredData({ pageId, md, scenarios, jiraText, repoKnowledge }) {
    const required = [];

    // Always helpful for UI tests
    required.push({
        key: "HAPPY_PATH_USER_ROLE",
        type: "string",
        reason: "Default role to run happy-path tests (generator uses it unless overridden).",
        howToGet: "Choose one role from testUsers_beta.json that can login and access the feature.",
        example: "admin",
        confidence: 0.9,
    });

    const hay = (md + "\n" + JSON.stringify(scenarios) + "\n" + (jiraText || "")).toLowerCase();

    // Endpoint inference (handles /programAccessList, /api/v1/... etc)
    const endpoints = Array.from(
        new Set([
            ...Array.from(md.matchAll(/`(\/api\/[a-z0-9\/\-_]+)`/gi)).map((m) => m[1]),
            ...Array.from(md.matchAll(/`(\/[a-z0-9\/\-_]+)`/gi))
                .map((m) => m[1])
                .filter((p) => p.startsWith("/api") || p.startsWith("/program") || p.includes("AccessList")),
        ])
    );

    if (endpoints.length) {
        required.push({
            key: "TARGET_API_ENDPOINT",
            type: "string",
            reason: "API endpoint to call for this spec.",
            howToGet: "Use the endpoint shown in the Confluence doc (backticked path).",
            example: endpoints[0],
            confidence: 0.75,
        });
    }

    // Hidden rule suggests needing a hidden entity to assert exclusion
    if (/hidden\s*=\s*1|campaignvisibility\.hidden|hidden from the response/.test(hay)) {
        required.push({
            key: "HIDDEN_ENTITY_ID",
            type: "number",
            reason: "Entity id (campaign/job/etc) that is hidden (Hidden=1) to assert it is excluded.",
            howToGet: "Pick an example record in the test environment with Hidden=1 for the relevant entity.",
            example: 12345,
            confidence: 0.7,
        });
    }

    // If scenarios mention two clients, request client names
    if (/(client).*last viewed|default to the client/i.test(hay)) {
        required.push(
            {
                key: "CLIENT_NAME_A",
                type: "string",
                reason: "A client the user can access to set as last-viewed.",
                howToGet: "Pick an accessible client name for the selected role in the environment.",
                example: "Acme Health",
                confidence: 0.55,
            },
            {
                key: "CLIENT_NAME_B",
                type: "string",
                reason: "A second client to ensure defaulting is truly last-viewed.",
                howToGet: "Pick another accessible client name for the selected role.",
                example: "Beta Pharma",
                confidence: 0.55,
            }
        );
    }

    // Repo-aware hint: if repoKnowledge includes baseUrl, propose NAV_TARGET_URL
    const baseUrl = repoKnowledge?.env?.baseUrl || process.env.BASE_URL || null;
    if (baseUrl) {
        required.push({
            key: "NAV_TARGET_URL",
            type: "string",
            reason: "A stable URL to land on before verifying behavior (optional navigation anchor).",
            howToGet: "Use environment base URL or a stable page URL relevant to the feature.",
            example: `${baseUrl}/home`,
            confidence: 0.4,
        });
    }

    // Dedup by key
    const seen = new Set();
    const deduped = [];
    for (const r of required) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        deduped.push(r);
    }

    return { pageId, detectedAt: new Date().toISOString(), required: deduped };
}

function autoFillRequired({ requiredSpec, existingData, repoKnowledge, md }) {
    const out = { ...(existingData || {}) };
    const unresolved = [];

    const rolesUnion = repoKnowledge?.users?.rolesUnion || [];
    const preferredHappyRoles = ["admin", "publisherAdmin", "standard", "publisherStandardUserGilaed"];

    for (const item of requiredSpec.required || []) {
        const key = item.key;
        const cur = out[key];

        if (cur !== undefined && cur !== null && String(cur).trim() !== "") continue;

        if (key === "HAPPY_PATH_USER_ROLE") {
            const candidate =
                preferredHappyRoles.find((r) => rolesUnion.includes(r)) ||
                rolesUnion[0] ||
                "admin";
            out[key] = candidate;
            continue;
        }

        if (key === "TARGET_API_ENDPOINT") {
            // best effort from markdown (prefer backticked)
            const m =
                md.match(/`(\/api\/[a-z0-9\/\-_]+)`/i) ||
                md.match(/`(\/[a-z0-9\/\-_]+)`/i);
            if (m?.[1]) {
                out[key] = m[1];
                continue;
            }
        }

        if (key === "NAV_TARGET_URL") {
            const baseUrl = repoKnowledge?.env?.baseUrl || process.env.BASE_URL || null;
            if (baseUrl) {
                out[key] = `${baseUrl}/home`;
                continue;
            }
        }

        unresolved.push(item);
    }

    return { filled: out, unresolved };
}

async function promptForMissing(pageId, unresolved, existingOut) {
    if (!unresolved?.length) return existingOut;

    const rl = readline.createInterface({ input, output });
    const out = { ...(existingOut || {}) };

    console.log("\n---");
    console.log(`Interactive data resolution for pageId=${pageId}`);
    console.log("Instructions:");
    console.log("- Press Enter to keep existing value (if present).");
    console.log("- Type 'skip' to leave missing.");
    console.log("- Type 'clear' to remove an existing value.");
    console.log("- For type=number, enter digits (e.g. 123).");
    console.log("---\n");

    try {
        for (const item of unresolved) {
            const key = item.key;
            const type = item.type || "string";
            const current = out[key];

            console.log(`Key: ${key}`);
            console.log(`Type: ${type}`);
            console.log(`Current: ${current === undefined ? "(missing)" : JSON.stringify(current)}`);
            console.log(`  Reason: ${item.reason || ""}`);
            console.log(`  How to get: ${item.howToGet || ""}`);
            if (item.example !== undefined) console.log(`  Example: ${JSON.stringify(item.example)}`);

            const ans = await rl.question(`Enter value for ${key} (${type}) [Enter=keep/skip/clear]: `);
            const a = (ans || "").trim();

            if (!a) {
                // keep existing
                if (current === undefined) {
                    console.log(`→ ${key} still missing (no existing value).`);
                }
                console.log("");
                continue;
            }

            if (a.toLowerCase() === "skip") {
                console.log(`→ skipping ${key}\n`);
                continue;
            }

            if (a.toLowerCase() === "clear") {
                delete out[key];
                console.log(`→ cleared ${key}\n`);
                continue;
            }

            if (type === "number") {
                const n = Number(a);
                if (Number.isNaN(n)) {
                    console.log(`→ invalid number, leaving ${key} unresolved.\n`);
                    continue;
                }
                out[key] = n;
                console.log(`→ set ${key}=${n}\n`);
                continue;
            }

            if (type === "json") {
                try {
                    out[key] = JSON.parse(a);
                    console.log(`→ set ${key}=(json)\n`);
                } catch {
                    console.log(`→ invalid json, leaving ${key} unresolved.\n`);
                }
                continue;
            }

            out[key] = a;
            console.log(`→ set ${key}="${a}"\n`);
        }
    } finally {
        rl.close();
    }

    return out;
}

// ------------------------------
// Run external scripts
// ------------------------------
function runNodeScript(scriptFile, args = []) {
    const scriptPath = path.join(agentDir, scriptFile);
    if (!fs.existsSync(scriptPath)) {
        return { ok: false, skipped: true, reason: "missing", scriptFile };
    }

    return new Promise((resolve, reject) => {
        const child = spawn("node", [scriptFile, ...args], {
            cwd: agentDir,
            env: process.env,
            stdio: "inherit",
            shell: true,
        });

        child.on("error", (e) => reject(e));
        child.on("exit", (code) => {
            if (code === 0) return resolve({ ok: true, skipped: false, scriptFile });
            reject(new Error(`FAILED: ${scriptFile} (exit ${code})`));
        });
    });
}

async function ensureRepoKnowledge() {
    const knowledge = readJsonIfExists(pRepoKnowledge(), null);
    if (knowledge) return knowledge;

    // If you have 1_librarian.mjs, run it; otherwise return empty object
    const res = await runNodeScript("1_librarian.mjs").catch(() => null);
    if (!res?.ok) return readJsonIfExists(pRepoKnowledge(), {}) || {};
    return readJsonIfExists(pRepoKnowledge(), {}) || {};
}

// ------------------------------
// Main
// ------------------------------
async function main() {
    const repoKnowledge = await ensureRepoKnowledge();

    // One MCP connection for all pages (faster), but we will force-kill proxy at end.
    const { client, kill } = await connectAtlassianMcp();

    try {
        // Process Jira Keys first (if any)
        for (const jiraKey of JIRA_KEYS) {
            console.log("\n======================================================================");
            console.log("JIRA:", jiraKey);
            console.log("======================================================================");

            console.log(`Fetching Jira: ${jiraKey}...`);
            const jiraText = await atlassianFetchJiraIssueByKey(client, CLOUD_ID, jiraKey);
            if (!jiraText) {
                console.error(`❌ Could not fetch Jira issue: ${jiraKey}`);
                continue;
            }
            fs.writeFileSync(pJiraText(jiraKey), jiraText, "utf8");
            console.log("Saved:", pJiraText(jiraKey));

            // Try to find a linked Confluence page in the Jira text
            const { jiraUrls } = extractJiraKeysAndUrls(jiraText);
            // This is a bit naive, but let's look for confluence links specifically
            const confluenceLinks = Array.from(jiraText.matchAll(/https?:\/\/[^\s)]+atlassian\.net\/wiki\/spaces\/[^\s)]+\/pages\/(\d+)/g)).map(m => m[1]);
            
            if (confluenceLinks.length) {
                console.log(`Found linked Confluence pages in Jira: ${confluenceLinks.join(", ")}`);
                for (const pid of confluenceLinks) {
                    if (!PAGE_IDS.includes(pid)) PAGE_IDS.push(pid);
                }
            } else {
                // If no page linked, we can still try to generate from Jira alone using Raw Fallback
                // We'll use a dummy pageId based on the Jira key to keep the pipeline happy
                const dummyPageId = `jira-${jiraKey}`;
                if (!PAGE_IDS.includes(dummyPageId)) PAGE_IDS.push(dummyPageId);
            }
        }

        for (const pageId of PAGE_IDS) {
            console.log("\n======================================================================");
            console.log("PAGE:", pageId);
            console.log("======================================================================");

            let md = "";
            if (pageId.startsWith("jira-")) {
                console.log("Generating from Jira content only (no Confluence page).");
                md = "No Confluence page provided. See linked Jira details.";
            } else {
                // 1) Fetch Confluence markdown
                md = normalizeMd(await atlassianFetchPageMarkdown(client, CLOUD_ID, pageId));
                fs.writeFileSync(pPageMd(pageId), md, "utf8");
                console.log("Saved:", pPageMd(pageId));
            }

            // --- RECURSIVE CONTEXT DISCOVERY ---
            let relatedContext = "";
            
            // 1. Find related Confluence pages
            const relatedPageIds = extractConfluenceLinks(md).filter(id => id !== pageId);
            if (relatedPageIds.length > 0) {
                console.log(`Found related Confluence pages: ${relatedPageIds.join(", ")}`);
                for (const rId of relatedPageIds.slice(0, 3)) { // Limit to 3 to avoid overload
                    try {
                        console.log(`Fetching related page: ${rId}...`);
                        const rMd = normalizeMd(await atlassianFetchPageMarkdown(client, CLOUD_ID, rId));
                        relatedContext += `\n\n--- RELATED PAGE: ${rId} ---\n${rMd.slice(0, 2000)}\n... (truncated)\n`;
                    } catch (e) {
                        console.warn(`Failed to fetch related page ${rId}: ${e.message}`);
                    }
                }
            }

            // 2. Find related Jira tickets
            const { jiraKeys } = extractJiraKeysAndUrls(md);
            let jiraText = "";
            
            // If we started from a Jira key, we might already have it
            const startJiraKey = JIRA_KEYS.find(k => pageId.includes(k));
            const effectiveJiraKey = startJiraKey || (jiraKeys?.length ? jiraKeys[0] : null);

            if (effectiveJiraKey) {
                if (fs.existsSync(pJiraText(effectiveJiraKey))) {
                    jiraText = fs.readFileSync(pJiraText(effectiveJiraKey), "utf8");
                } else {
                    console.log(`Jira detected: ${effectiveJiraKey} → fetching...`);
                    const t = await atlassianFetchJiraIssueByKey(client, CLOUD_ID, effectiveJiraKey);
                    if (t) {
                        jiraText = t;
                        fs.writeFileSync(pJiraText(effectiveJiraKey), t, "utf8");
                        console.log("Jira fetched (text length):", t.length);
                        console.log("Saved:", pJiraText(effectiveJiraKey));
                    }
                }
            }

            // Fetch other mentioned Jira tickets as context
            const otherJiraKeys = jiraKeys.filter(k => k !== effectiveJiraKey);
            if (otherJiraKeys.length > 0) {
                console.log(`Found related Jira tickets: ${otherJiraKeys.join(", ")}`);
                for (const k of otherJiraKeys.slice(0, 3)) {
                     try {
                        console.log(`Fetching related Jira: ${k}...`);
                        const t = await atlassianFetchJiraIssueByKey(client, CLOUD_ID, k);
                        if (t) {
                            relatedContext += `\n\n--- RELATED JIRA: ${k} ---\n${t.slice(0, 1000)}\n... (truncated)\n`;
                        }
                    } catch (e) {
                        console.warn(`Failed to fetch related Jira ${k}: ${e.message}`);
                    }
                }
            }

            // 3. Extract "Related content" section from Confluence page
            const relatedContentMatch = md.match(/##\s*Related content([\s\S]*?)(?:##|$)/i);
            if (relatedContentMatch) {
                const relatedContentSection = relatedContentMatch[1].trim();
                console.log("Found 'Related content' section in Confluence page.");
                relatedContext += `\n\n--- RELATED CONTENT SECTION ---\n${relatedContentSection}\n`;
                
                // Try to extract links from this section specifically
                 const sectionLinks = extractConfluenceLinks(relatedContentSection).filter(id => id !== pageId && !relatedPageIds.includes(id));
                 if (sectionLinks.length > 0) {
                     console.log(`Found additional links in 'Related content': ${sectionLinks.join(", ")}`);
                     for (const rId of sectionLinks.slice(0, 2)) {
                         try {
                            console.log(`Fetching related content page: ${rId}...`);
                            const rMd = normalizeMd(await atlassianFetchPageMarkdown(client, CLOUD_ID, rId));
                            relatedContext += `\n\n--- RELATED CONTENT PAGE: ${rId} ---\n${rMd.slice(0, 2000)}\n... (truncated)\n`;
                         } catch (e) {
                             console.warn(`Failed to fetch related content page ${rId}: ${e.message}`);
                         }
                     }
                 }
            }
            
            // 4. Extract links from the entire page content (general discovery)
            const allLinks = extractConfluenceLinks(md).filter(id => id !== pageId && !relatedPageIds.includes(id));
            if (allLinks.length > 0) {
                console.log(`Found ${allLinks.length} other links in page content.`);
                // We won't fetch all of them to avoid explosion, but we can list them
                relatedContext += `\n\n--- OTHER LINKED PAGES ---\n${allLinks.join(", ")}\n`;
                
                // Optionally fetch a few more if we haven't fetched many yet
                const remainingSlots = 3 - relatedPageIds.length;
                if (remainingSlots > 0) {
                    for (const rId of allLinks.slice(0, remainingSlots)) {
                         try {
                            console.log(`Fetching linked page: ${rId}...`);
                            const rMd = normalizeMd(await atlassianFetchPageMarkdown(client, CLOUD_ID, rId));
                            relatedContext += `\n\n--- LINKED PAGE: ${rId} ---\n${rMd.slice(0, 2000)}\n... (truncated)\n`;
                         } catch (e) {
                             console.warn(`Failed to fetch linked page ${rId}: ${e.message}`);
                         }
                    }
                }
            }

            if (relatedContext) {
                fs.writeFileSync(pRelatedContext(pageId), relatedContext, "utf8");
                console.log("Saved Related Context:", pRelatedContext(pageId));
            }

            // 2) Brief/stats
            const stats = extractStatsFromMarkdown(md);
            writeJson(pBrief(pageId), { pageId, extractedAt: new Date().toISOString(), stats });
            console.log("Saved:", pBrief(pageId), "Stats:", stats);

            // 3) Scenarios
            const sc = buildScenariosFromMarkdown(pageId, md);
            writeJson(pScenarios(pageId), sc);
            console.log("Saved:", pScenarios(pageId), "Counts:", sc.counts);

            // 5) Required data detection + fill
            const requiredSpec = detectRequiredData({
                pageId,
                md,
                scenarios: sc.scenarios || [],
                jiraText,
                repoKnowledge,
            });
            writeJson(pRequired(pageId), requiredSpec);
            console.log("Saved:", pRequired(pageId), "Detected keys:", requiredSpec.required.length);

            const existingData = readJsonIfExists(pTestData(pageId), {});
            const { filled, unresolved } = autoFillRequired({
                requiredSpec,
                existingData,
                repoKnowledge,
                md,
            });

            let finalData = filled;

            // Only ask user in smart mode (local dev)
            if (MODE === "smart" && unresolved.length) {
                finalData = await promptForMissing(pageId, unresolved, filled);
            }

            writeJson(pTestData(pageId), finalData);
            console.log("Saved:", pTestData(pageId));

            // 6) Generate tests (21)
            // process.env.CONFLUENCE_PAGE_ID = String(pageId);
            // console.log("\n======================================================================");
            // console.log("Step 1: Generating Tests (Repo Aware)");
            // console.log("======================================================================");
            // await runNodeScript("21_generate_tests_repo_aware.mjs", ["--pageId", String(pageId)]);

            // 7) Optional LLM refine (22) + verify/heal (23) + architect (24) + refactor (24)
            // console.log("\n======================================================================");
            // console.log("Step 2: Gemini Refinement");
            // console.log("======================================================================");
            // await runNodeScript("22_gemini_refine.mjs", ["--pageId", String(pageId)]).catch((e) => {
            //     console.warn("⚠️ 22_gemini_refine.mjs failed/skipped:", e.message);
            // });

            // console.log("\n======================================================================");
            // console.log("Step 3: Verify and Heal");
            // console.log("======================================================================");
            // await runNodeScript("23_verify_and_heal.mjs", ["--pageId", String(pageId)]).catch((e) => {
            //     console.warn("⚠️ 23_verify_and_heal.mjs failed/skipped:", e.message);
            // });

            // console.log("\n======================================================================");
            // console.log("Step 4: Architect Page Objects");
            // console.log("======================================================================");
            // await runNodeScript("24_architect_page_objects.mjs", ["--pageId", String(pageId)]).catch((e) => {
            //     console.warn("⚠️ 24_architect_page_objects.mjs failed/skipped:", e.message);
            // });

            // console.log("\n======================================================================");
            // console.log("Step 5: Refactor to Page Objects");
            // console.log("======================================================================");
            // await runNodeScript("24_refactor_to_po.mjs", ["--pageId", String(pageId)]).catch((e) => {
            //     console.warn("⚠️ 24_refactor_to_po.mjs failed/skipped:", e.message);
            // });
        }
    } finally {
        // Close MCP proxy so you never need Ctrl+C
        try { await client.close(); } catch {}
        try { kill(); } catch {}
    }

    console.log("\n✅ Runner finished.");
}

main().catch((e) => {
    console.error("❌ Runner failed.");
    console.error(e?.stack || e?.message || e);
    process.exit(1);
});
