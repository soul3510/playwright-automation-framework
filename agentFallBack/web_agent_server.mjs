import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentDir = process.cwd();
const repoRoot = path.resolve(agentDir, "..");
const generatedDir = path.join(agentDir, "generated");
const testsScenarioPath = path.join(repoRoot, "tests", "generated-from-agentFallBack", "scenario.txt");
const generatedTestsDir = path.join(repoRoot, "tests", "generated-from-agentFallBack");
const playwrightReportDir = path.join(repoRoot, "playwright-report");
const aiProviderStatusPath = path.join(generatedDir, "ai_provider_status.jsonl");
const PORT = Number(process.env.AGENT_UI_PORT || 3789);

let runState = {
    running: false,
    status: "idle",
    scenarioStatuses: [],
    testStatuses: [],
    generatedTests: [],
    aiProviderStatus: [],
    reportUrl: null,
    logs: [],
    startedAt: null,
    finishedAt: null,
    exitCode: null
};

function pushLog(message) {
    const line = sanitizeLogText(message);
    runState.logs.push(line);
    if (runState.logs.length > 4000) runState.logs.splice(0, runState.logs.length - 4000);
    process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

function sanitizeLogText(message) {
    return String(message ?? "")
        // Remove ANSI escape/control sequences emitted by Playwright reporters.
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
        // Repair common mojibake sequences caused by UTF-8 decoded as Windows-1252.
        .replace(/âœ…/g, "✅")
        .replace(/âŒ/g, "❌")
        .replace(/âš ï¸/g, "⚠️")
        .replace(/ðŸš€/g, "🚀")
        .replace(/ðŸ“/g, "📍")
        .replace(/ðŸ”/g, "🔍")
        .replace(/ðŸŽ¯/g, "🎯")
        .replace(/ðŸ“Š/g, "📊")
        .replace(/ðŸ“„/g, "📄")
        .replace(/ðŸ“Ž/g, "📎")
        .replace(/ðŸ› /g, "🛠")
        .replace(/ðŸ›/g, "🐛")
        .replace(/ðŸ/g, "🏁")
        .replace(/âŒ¨ï¸/g, "⌨️")
        .replace(/â°/g, "⏰")
        .replace(/â„¹ï¸/g, "ℹ️")
        // If terminal cursor cleanup left blank control-only lines, keep normal text readable.
        .replace(/\r(?!\n)/g, "\n");
}

function sendJson(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body;
}

function runCommand(command, args, label, cwd = agentDir) {
    return new Promise((resolve) => {
        pushLog(`\n=== ${label} ===\n`);
        const child = spawn(command, args, {
            cwd,
            shell: false,
            env: { ...process.env }
        });

        child.stdout.on("data", data => pushLog(data.toString()));
        child.stderr.on("data", data => pushLog(data.toString()));
        child.on("error", error => {
            pushLog(`Command failed to start: ${error.message}\n`);
            resolve(1);
        });
        child.on("close", code => {
            pushLog(`\n=== ${label} exited with ${code} ===\n`);
            resolve(code ?? 1);
        });
    });
}

function runGeminiPrompt(prompt, label = "Gemini semantic discovery") {
    return new Promise((resolve) => {
        pushLog(`${label}...\n`);
        let child;
        try {
            child = spawn(process.execPath, [path.join(agentDir, "gemini-cli.js")], {
                cwd: agentDir,
                shell: false,
                env: { ...process.env }
            });
        } catch (error) {
            pushLog(`${label} failed to start: ${error.message}\n`);
            resolve("");
            return;
        }

        let output = "";
        let errorOutput = "";
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        child.stdout.on("data", data => { output += data.toString(); });
        child.stderr.on("data", data => { errorOutput += data.toString(); });
        child.stdin.on("error", error => {
            pushLog(`${label} stdin failed: ${error.message}\n`);
            finish("");
        });
        child.on("error", error => {
            pushLog(`${label} process error: ${error.message}\n`);
            finish("");
        });
        child.on("close", code => {
            if (settled) return;
            if (code !== 0) {
                const friendly = friendlyGeminiLog(errorOutput);
                if (friendly) {
                    pushLog(`Gemini is unavailable: ${friendly}\n`);
                }
                pushLog(`${label} failed. Falling back to rule-based scenarios.\n${errorOutput}\n`);
                finish("");
                return;
            }
            pushLog(`${label} completed.\n`);
            finish(output);
        });

        try {
            child.stdin.end(prompt);
        } catch (error) {
            pushLog(`${label} prompt write failed: ${error.message}\n`);
            finish("");
        }
    });
}

function extractJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    if (!candidate) return null;

    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

function friendlyGeminiLog(errorOutput) {
    const text = String(errorOutput || "");
    const friendlyMatch = text.match(/GEMINI_AGENT_ERROR_MESSAGE=(.+)/);
    if (friendlyMatch) return friendlyMatch[1].trim();

    const lower = text.toLowerCase();
    if (
        lower.includes("429") ||
        lower.includes("quota") ||
        lower.includes("resource_exhausted") ||
        lower.includes("rate limit") ||
        lower.includes("too many requests")
    ) {
        return "Gemini API limit reached for this API key. Wait for the quota window to reset, switch to another key, or use a billing-enabled Gemini project/key.";
    }

    if (lower.includes("token") && (lower.includes("limit") || lower.includes("too large") || lower.includes("exceeds"))) {
        return "Gemini request is too large for the selected model. Try fewer scenarios, a smaller page, or a model with a larger context window.";
    }

    return "";
}

function resetTaskState(source = "manual") {
    const statePath = path.join(agentDir, "task_state.json");
    const freshState = {
        currentAgent: "web-ui",
        status: "RUNNING",
        source,
        startedAt: new Date().toISOString(),
        logs: [],
        bugReport: { detectedBugs: [] }
    };

    fs.writeFileSync(statePath, JSON.stringify(freshState, null, 2), "utf8");
    pushLog("Run state reset. Previous bug reports cleared.\n");
}

function scenarioSubject(text, fallback) {
    const match = String(text || "").match(/^Subject:\s*(.+)$/mi);
    return match ? match[1].trim() : fallback;
}

function listGeneratedTests() {
    if (!fs.existsSync(generatedTestsDir)) return [];
    return fs.readdirSync(generatedTestsDir)
        .filter(name => name.endsWith(".test.ts"))
        .sort((a, b) => a.localeCompare(b))
        .map(name => {
            const fullPath = path.join(generatedTestsDir, name);
            const stat = fs.statSync(fullPath);
            return {
                name,
                relativePath: path.relative(repoRoot, fullPath).replace(/\\/g, "/"),
                size: stat.size,
                lastModified: stat.mtime.toISOString()
            };
        });
}

function sanitizeGeneratedTestNames(files) {
    const available = new Set(listGeneratedTests().map(test => test.name));
    return (Array.isArray(files) ? files : [])
        .map(name => String(name || "").trim())
        .filter(name => /^[^\\/]+\.test\.ts$/.test(name))
        .filter(name => available.has(name));
}

function readAiProviderStatus(limit = 20) {
    if (!fs.existsSync(aiProviderStatusPath)) return [];
    return fs.readFileSync(aiProviderStatusPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

async function runGeneratedTests({ files, all = false }) {
    if (runState.running) {
        throw new Error("Agent is already running.");
    }

    const tests = listGeneratedTests();
    const selectedNames = all ? tests.map(test => test.name) : sanitizeGeneratedTestNames(files);
    if (!selectedNames.length) {
        throw new Error("No generated tests selected.");
    }

    runState = {
        running: true,
        status: "running",
        scenarioStatuses: [],
        testStatuses: selectedNames.map((name, index) => ({
            index,
            name,
            status: "queued",
            startedAt: null,
            finishedAt: null
        })),
        generatedTests: tests,
        reportUrl: null,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null
    };

    try {
        pushLog(`Running ${selectedNames.length} generated test file(s).\n`);
        runState.testStatuses.forEach(test => {
            test.status = "running";
            test.startedAt = new Date().toISOString();
        });

        const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
        const relativePaths = selectedNames.map(name => `tests/generated-from-agentFallBack/${name}`);
        const exitCode = await runCommand(
            npxCommand,
            ["playwright", "test", ...relativePaths, "--project=chromium"],
            all ? "Run all generated tests" : "Run selected generated tests",
            repoRoot
        );

        runState.testStatuses.forEach(test => {
            test.status = exitCode === 0 ? "passed" : "completed";
            test.finishedAt = new Date().toISOString();
        });
        runState.status = exitCode === 0 ? "passed" : "failed";
        runState.exitCode = exitCode;
        runState.reportUrl = "/playwright-report/index.html";
        runState.generatedTests = listGeneratedTests();
        pushLog(`\nPlaywright report: http://localhost:${PORT}${runState.reportUrl}\n`);
    } catch (error) {
        pushLog(`\nGenerated test run error: ${error.message}\n`);
        runState.testStatuses.forEach(test => {
            if (test.status === "running" || test.status === "queued") {
                test.status = "failed";
                test.finishedAt = new Date().toISOString();
            }
        });
        runState.status = "failed";
        runState.exitCode = 1;
    } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
    }
}

async function runManualPipeline({ scenarioText, scenarioTexts, cleanupFirst, inputDataOptions }) {
    if (runState.running) {
        throw new Error("Agent is already running.");
    }

    runState = {
        running: true,
        status: "running",
        scenarioStatuses: [],
        generatedTests: listGeneratedTests(),
        aiProviderStatus: readAiProviderStatus(),
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null
    };

    try {
        fs.mkdirSync(generatedDir, { recursive: true });
        fs.mkdirSync(path.dirname(testsScenarioPath), { recursive: true });

        const selectedScenarios = Array.isArray(scenarioTexts)
            ? scenarioTexts.map(text => String(text || "").trim()).filter(Boolean).slice(0, 10)
            : [String(scenarioText || "").trim()].filter(Boolean);

        if (selectedScenarios.length === 0) {
            throw new Error("At least one scenario is required.");
        }

        runState.scenarioStatuses = selectedScenarios.map((text, index) => ({
            index,
            title: scenarioSubject(text, `Scenario ${index + 1}`),
            status: "queued",
            startedAt: null,
            finishedAt: null,
            exitCode: null
        }));

        let finalCode = 0;

        for (let i = 0; i < selectedScenarios.length; i++) {
            const currentScenario = selectedScenarios[i];
            const scenarioLabel = selectedScenarios.length > 1
                ? `Scenario ${i + 1}/${selectedScenarios.length}`
                : "Scenario 1/1";

            pushLog(`\n##############################\n${scenarioLabel}\n##############################\n`);
            runState.scenarioStatuses[i].status = "running";
            runState.scenarioStatuses[i].startedAt = new Date().toISOString();
            resetTaskState("manual");

            if (cleanupFirst) {
                const cleanupCode = await runCommand(process.execPath, ["cleanup_generated.mjs"], `${scenarioLabel}: Cleanup generated metadata`);
                if (cleanupCode !== 0) throw new Error("Cleanup failed.");
            }

            fs.writeFileSync(testsScenarioPath, currentScenario, "utf8");
            const tempPath = path.join(generatedDir, "manual_input_temp.txt");
            fs.writeFileSync(tempPath, currentScenario, "utf8");
            fs.writeFileSync(
                path.join(generatedDir, "user_input_data_manual.json"),
                JSON.stringify(inputDataOptions || { enabled: false, createDataProviders: false, fields: {} }, null, 2),
                "utf8"
            );

            const steps = [
                ["inject_manual_scenario.mjs", ["--file", tempPath], `${scenarioLabel}: Ingest manual scenario`],
                ["2_test_generator_generic.mjs", ["--pageId", "manual"], `${scenarioLabel}: Generate Playwright test`],
                ["3_qa_engineer_generic.mjs", ["--pageId", "manual"], `${scenarioLabel}: QA enhancement`],
                ["4_healer.mjs", ["--pageId", "manual"], `${scenarioLabel}: Run and heal test`]
            ];

            let pipelineCode = 0;
            for (const [script, args, label] of steps) {
                pipelineCode = await runCommand(process.execPath, [script, ...args], label);
                runState.generatedTests = listGeneratedTests();
                if (pipelineCode !== 0) break;
            }

            await runCommand(process.execPath, ["7_reporter.mjs"], `${scenarioLabel}: Final report`);
            runState.generatedTests = listGeneratedTests();

            if (pipelineCode === 0) {
                runState.scenarioStatuses[i].status = "passed";
                runState.scenarioStatuses[i].finishedAt = new Date().toISOString();
                runState.scenarioStatuses[i].exitCode = 0;
                await runCommand(process.execPath, ["cleanup_generated.mjs"], `${scenarioLabel}: Post-success cleanup`);
                runState.generatedTests = listGeneratedTests();
            } else {
                finalCode = pipelineCode;
                runState.scenarioStatuses[i].status = "failed";
                runState.scenarioStatuses[i].finishedAt = new Date().toISOString();
                runState.scenarioStatuses[i].exitCode = pipelineCode;
                await runCommand(process.execPath, ["cleanup_generated.mjs", "--archive"], `${scenarioLabel}: Archive failed run metadata`);
            }
        }

        runState.status = finalCode === 0 ? "passed" : "failed";
        runState.exitCode = finalCode;
    } catch (error) {
        pushLog(`\nAgent pipeline error: ${error.message}\n`);
        const runningScenario = runState.scenarioStatuses.find(item => item.status === "running");
        if (runningScenario) {
            runningScenario.status = "failed";
            runningScenario.finishedAt = new Date().toISOString();
            runningScenario.exitCode = 1;
        }
        runState.status = "failed";
        runState.exitCode = 1;
    } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
    }
}

function summarizeElement(el) {
    const parts = [el.tag];
    if (el.attrs?.id) parts.push(`#${el.attrs.id}`);
    if (el.attrs?.name) parts.push(`[name="${el.attrs.name}"]`);
    if (el.attrs?.role) parts.push(`[role="${el.attrs.role}"]`);
    if (el.text) parts.push(`"${el.text}"`);
    return parts.join(" ");
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function dismissPageInterruptions(page) {
    const safeNames = [
        "accept", "accept all", "agree", "i agree", "allow all", "ok", "got it",
        "continue", "skip", "no thanks", "not now", "decline", "reject all",
        "close", "dismiss", "אישור", "אשר", "מסכים", "קבל", "קבל הכל",
        "סגור", "המשך", "לא תודה"
    ];
    const safePattern = new RegExp(`^\\s*(${safeNames.map(escapeRegex).join("|")})\\s*$`, "i");
    const unsafePattern = /login|log in|sign in|register|buy|purchase|pay|checkout|delete|remove|download|submit|send|save/i;
    const actions = [];

    async function clickFirst(locator, label) {
        const count = Math.min(await locator.count().catch(() => 0), 8);
        for (let i = 0; i < count; i++) {
            const item = locator.nth(i);
            const text = ((await item.innerText({ timeout: 500 }).catch(() => "")) || "").trim();
            const aria = ((await item.getAttribute("aria-label").catch(() => "")) || "").trim();
            const name = text || aria || label;
            if (unsafePattern.test(name)) continue;
            if (!await item.isVisible({ timeout: 700 }).catch(() => false)) continue;
            if (!await item.isEnabled({ timeout: 700 }).catch(() => true)) continue;
            await item.click({ timeout: 3000 }).catch(async () => item.click({ force: true, timeout: 3000 }));
            actions.push(`${label}: ${name}`);
            return true;
        }
        return false;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500).catch(() => {});

    for (let round = 0; round < 4; round++) {
        const before = actions.length;
        await page.keyboard.press("Escape").catch(() => {});

        if (await clickFirst(page.getByRole("button", { name: safePattern }), "safe button")) {
            await page.waitForTimeout(500).catch(() => {});
            continue;
        }

        if (await clickFirst(page.locator("button, [role='button'], input[type='button'], input[type='submit']").filter({ hasText: safePattern }), "safe text button")) {
            await page.waitForTimeout(500).catch(() => {});
            continue;
        }

        if (await clickFirst(page.locator([
            '[aria-label*="close" i]',
            '[aria-label*="dismiss" i]',
            '[title*="close" i]',
            '.modal button:has-text("×")',
            '[role="dialog"] button:has-text("×")',
            'button.close',
            '.close-button',
            '.modal-close',
            '.popup-close'
        ].join(", ")), "close icon")) {
            await page.waitForTimeout(500).catch(() => {});
            continue;
        }

        const containers = page.locator([
            '[role="dialog"]',
            '[aria-modal="true"]',
            '[class*="cookie" i]',
            '[id*="cookie" i]',
            '[class*="consent" i]',
            '[id*="consent" i]',
            '[class*="privacy" i]',
            '[id*="privacy" i]',
            '[class*="modal" i]',
            '[class*="popup" i]',
            '[class*="overlay" i]'
        ].join(", "));

        const count = Math.min(await containers.count().catch(() => 0), 5);
        for (let i = 0; i < count; i++) {
            const container = containers.nth(i);
            if (!await container.isVisible({ timeout: 500 }).catch(() => false)) continue;
            if (await clickFirst(container.locator("button, [role='button'], input[type='button'], input[type='submit']").filter({ hasText: safePattern }), "interruption button")) break;
            if (await clickFirst(container.locator('[aria-label*="close" i], [title*="close" i], button:has-text("×"), .close, .close-button'), "interruption close")) break;
        }

        if (actions.length === before) break;
        await page.waitForTimeout(500).catch(() => {});
    }

    if (actions.length) pushLog(`Discovery dismissed interruptions: ${actions.join(" | ")}\n`);
    return actions;
}

async function discoverPage(url) {
    let chromium;
    try {
        ({ chromium } = require("playwright"));
    } catch {
        ({ chromium } = require("@playwright/mcp/node_modules/playwright"));
    }

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const networkRequests = [];
        page.on("response", response => {
            const request = response.request();
            const type = request.resourceType();
            if (!["document", "xhr", "fetch", "script"].includes(type)) return;
            networkRequests.push({
                url: response.url(),
                status: response.status(),
                method: request.method(),
                type
            });
        });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        const interruptions = await dismissPageInterruptions(page);
        await page.waitForTimeout(1500);
        const snapshot = await page.evaluate(() => {
            const textOf = el => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
            const pickAttrs = el => {
                const attrs = {};
                for (const name of ["id", "name", "type", "role", "aria-label", "placeholder", "href", "data-testid", "alt", "title"]) {
                    const value = el.getAttribute(name);
                    if (value) attrs[name] = value;
                }
                return attrs;
            };
            const elements = Array.from(document.querySelectorAll("button,a,input,select,textarea,[role],[data-testid]"))
                .map(el => {
                    const rect = el.getBoundingClientRect();
                    return {
                        tag: el.tagName.toLowerCase(),
                        text: textOf(el),
                        attrs: pickAttrs(el),
                        visible: !!(rect.width || rect.height || el.getClientRects().length)
                    };
                })
                .filter(el => el.visible)
                .slice(0, 80);
            const meta = selector => document.querySelector(selector)?.getAttribute("content") || "";
            const visibleTextBlocks = Array.from(document.querySelectorAll("main p, main li, article p, section p, [class*='content' i] p, [class*='card' i], [class*='item' i]"))
                .map(textOf)
                .filter(text => text.length >= 30)
                .slice(0, 30);
            const navigationLinks = Array.from(document.querySelectorAll("nav a[href], header a[href], aside a[href]"))
                .map(a => ({ text: textOf(a), href: a.getAttribute("href") || "" }))
                .filter(item => item.text || item.href)
                .slice(0, 30);
            const forms = Array.from(document.querySelectorAll("form")).map((form, index) => ({
                index,
                text: textOf(form),
                action: form.getAttribute("action") || "",
                method: form.getAttribute("method") || "get",
                inputs: Array.from(form.querySelectorAll("input, select, textarea")).map(input => ({
                    tag: input.tagName.toLowerCase(),
                    type: input.getAttribute("type") || "",
                    name: input.getAttribute("name") || "",
                    id: input.id || "",
                    placeholder: input.getAttribute("placeholder") || "",
                    aria: input.getAttribute("aria-label") || ""
                })).slice(0, 20)
            })).slice(0, 10);
            const dataRegions = Array.from(document.querySelectorAll("table, [role='table'], [class*='table' i], [class*='list' i], [class*='grid' i]"))
                .map((el, index) => ({ index, tag: el.tagName.toLowerCase(), text: textOf(el) }))
                .filter(item => item.text.length >= 20)
                .slice(0, 15);
            return {
                url: location.href,
                title: document.title,
                language: document.documentElement.lang || "",
                metaDescription: meta("meta[name='description']"),
                metaKeywords: meta("meta[name='keywords']"),
                ogTitle: meta("meta[property='og:title']"),
                ogDescription: meta("meta[property='og:description']"),
                headings: Array.from(document.querySelectorAll("h1,h2,h3")).map(textOf).filter(Boolean).slice(0, 20),
                visibleTextBlocks,
                navigationLinks,
                forms,
                dataRegions,
                elements
            };
        });
        snapshot.interruptions = interruptions;
        snapshot.networkRequests = networkRequests.slice(0, 40);
        return snapshot;
    } finally {
        await browser.close().catch(() => {});
    }
}

function clampScenarioCount(value) {
    const count = Number.parseInt(value, 10);
    if (!Number.isFinite(count)) return 3;
    return Math.max(1, Math.min(10, count));
}

function normalizeScenarioTypes(types) {
    const allowed = new Set(["UI_E2E", "BE_API", "PERFORMANCE", "SECURITY", "ACCESSIBILITY", "SEO", "RESPONSIVE", "QUALITY"]);
    const normalized = (Array.isArray(types) ? types : [])
        .map(type => String(type || "").trim().toUpperCase())
        .filter(type => allowed.has(type));
    return normalized.length ? normalized : Array.from(allowed);
}

function scenarioTypeMatches(category, selectedTypes) {
    const normalized = String(category || "").toUpperCase();
    if (selectedTypes.includes(normalized)) return true;
    if (selectedTypes.includes("UI_E2E") && normalized.startsWith("UI_")) return true;
    return false;
}

function buildScenario({ title, category, steps, expected, snapshot, elements }) {
    return [
        `Subject: ${title}`,
        "User: no user",
        "Steps:",
        ...steps.map((step, index) => `${index + 1}. ${step}`),
        "",
        "Expected:",
        ...expected,
        "",
        "Additional:",
        `Category: ${category}`,
        "Discovered page signals:",
        ...(snapshot.interruptions?.length ? snapshot.interruptions.map(action => `- Interruption handled before scan: ${action}`) : []),
        ...snapshot.headings.slice(0, 8).map(h => `- Heading: ${h}`),
        ...elements.slice(0, 12).map(el => `- Element: ${el}`)
    ].join("\n");
}

function compactSnapshotForAi(snapshot) {
    return {
        url: snapshot.url,
        title: snapshot.title,
        language: snapshot.language,
        metaDescription: snapshot.metaDescription,
        metaKeywords: snapshot.metaKeywords,
        ogTitle: snapshot.ogTitle,
        ogDescription: snapshot.ogDescription,
        headings: (snapshot.headings || []).slice(0, 20),
        navigationLinks: (snapshot.navigationLinks || []).slice(0, 20),
        forms: (snapshot.forms || []).slice(0, 8),
        dataRegions: (snapshot.dataRegions || []).slice(0, 10),
        visibleTextBlocks: (snapshot.visibleTextBlocks || []).slice(0, 20),
        elements: (snapshot.elements || []).slice(0, 50),
        networkRequests: (snapshot.networkRequests || []).slice(0, 30),
        interruptions: snapshot.interruptions || []
    };
}

function normalizeAiScenario(aiScenario, index, snapshot, elements) {
    const title = String(aiScenario?.title || `Site-specific scenario ${index + 1}`).trim();
    const category = String(aiScenario?.category || "UI_E2E").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const steps = Array.isArray(aiScenario?.steps)
        ? aiScenario.steps.map(step => String(step || "").trim()).filter(Boolean)
        : [];
    const expected = Array.isArray(aiScenario?.expected)
        ? aiScenario.expected.map(item => String(item || "").trim()).filter(Boolean)
        : [];
    const reason = String(aiScenario?.reason || "").trim();

    const finalSteps = steps.length >= 2
        ? steps
        : [
            `Navigate to page: ${snapshot.url}`,
            "Verify the page loads successfully and the main content is visible",
            "Complete the most important visible user journey for this site",
            "Verify the result matches the site purpose"
        ];
    const finalExpected = expected.length
        ? expected
        : ["The site-specific user flow behaves as expected"];

    const text = buildScenario({
        title,
        category,
        steps: finalSteps,
        expected: reason ? [...finalExpected, `Reason: ${reason}`] : finalExpected,
        snapshot,
        elements
    });

    return {
        id: `scenario-${index + 1}`,
        title,
        category,
        selected: index === 0,
        text
    };
}

async function analyzeSitePurposeWithGemini(snapshot, requestedCount, elements, selectedTypes) {
    const apiKeyPresent = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || fs.existsSync(path.join(agentDir, ".env")));
    if (!apiKeyPresent) {
        pushLog("Gemini semantic discovery skipped: no .env/API key detected.\n");
        return null;
    }

    const prompt = `
ROLE: Senior QA architect and product analyst.
GOAL: Understand the specific purpose of a website and generate realistic, site-specific test scenarios.

Requested scenario count: ${requestedCount}
Selected test types: ${selectedTypes.join(", ")}

SITE SNAPSHOT:
${JSON.stringify(compactSnapshotForAi(snapshot), null, 2)}

Return ONLY valid JSON. No markdown.

JSON shape:
{
  "sitePurpose": "short explanation of what this site is for",
  "primaryUsers": ["user type"],
  "mainUserGoals": ["goal"],
  "scenarios": [
    {
      "category": "UI_E2E | BE_API | PERFORMANCE | SECURITY | ACCESSIBILITY | SEO | RESPONSIVE | QUALITY",
      "title": "specific scenario title",
      "reason": "why this matters for this exact site",
      "steps": [
        "Navigate to page: ${snapshot.url}",
        "site-specific action",
        "site-specific verification"
      ],
      "expected": [
        "specific expected result"
      ]
    }
  ]
}

Rules:
- Generate exactly ${requestedCount} scenarios.
- Generate only these selected test types: ${selectedTypes.join(", ")}.
- Make the UI_E2E scenarios match the site's actual purpose and primary user goals.
- Use visible headings, forms, navigation, lists/tables/cards, and URL path meaning.
- Include BE_API, performance, security, accessibility, SEO, responsive, or quality scenarios only when useful.
- Do not invent credentials, purchases, destructive actions, or illegal flows.
- For login/auth flows, stop at verifying the login page/modal unless credentials are explicitly available.
- For financial, medical, legal, or high-risk sites, avoid submitting real user data and keep tests read-only.
- Steps must be concrete enough for Playwright automation.
`;

    const output = await runGeminiPrompt(prompt, "Gemini site-purpose analysis");
    const parsed = extractJsonObject(output);
    if (!parsed || !Array.isArray(parsed.scenarios)) {
        pushLog("Gemini semantic discovery returned invalid JSON. Using rule-based scenarios.\n");
        return null;
    }

    const filteredAiScenarios = parsed.scenarios.filter(scenario => scenarioTypeMatches(scenario?.category, selectedTypes));
    const scenarios = filteredAiScenarios
        .slice(0, requestedCount)
        .map((scenario, index) => normalizeAiScenario(scenario, index, snapshot, elements));

    if (!scenarios.length) return null;

    pushLog(`Gemini understood site purpose: ${parsed.sitePurpose || "not specified"}\n`);
    return {
        sitePurpose: parsed.sitePurpose || "",
        primaryUsers: parsed.primaryUsers || [],
        mainUserGoals: parsed.mainUserGoals || [],
        scenarios
    };
}

async function suggestScenariosFromUrl(url, requestedCount = 3, requestedTypes = []) {
    const snapshot = await discoverPage(url);
    const count = clampScenarioCount(requestedCount);
    const selectedTypes = normalizeScenarioTypes(requestedTypes);
    const elements = snapshot.elements.map(summarizeElement).slice(0, 40);

    const semanticResult = await analyzeSitePurposeWithGemini(snapshot, count, elements, selectedTypes);
    if (semanticResult?.scenarios?.length) {
        return {
            scenario: semanticResult.scenarios[0]?.text || "",
            scenarios: semanticResult.scenarios,
            snapshot,
            sitePurpose: semanticResult.sitePurpose,
            primaryUsers: semanticResult.primaryUsers,
            mainUserGoals: semanticResult.mainUserGoals,
            generationMode: "semantic-gemini"
        };
    }

    const hasSearch = elements.some(x => /search/i.test(x));
    const hasLogin = elements.some(x => /log in|login|sign in/i.test(x));
    const hasForm = snapshot.elements.some(el => ["input", "select", "textarea"].includes(el.tag));
    const hasNavigation = snapshot.elements.some(el => /^a\b/i.test(el));
    const title = snapshot.title || new URL(url).hostname;
    const apiSignals = snapshot.networkRequests || [];

    const userJourneySteps = [
        `Navigate to page: ${url}`,
        "Verify the page loads successfully and the main content is visible"
    ];

    if (hasSearch) {
        userJourneySteps.push("Search for a relevant keyword using the site search");
        userJourneySteps.push("Verify search results or matching content are displayed");
    } else if (hasLogin) {
        userJourneySteps.push("Click the login or sign-in entry point without entering credentials");
        userJourneySteps.push("Verify the authentication page or modal is displayed");
    } else if (hasForm) {
        userJourneySteps.push("Fill the primary visible form with validation-safe data");
        userJourneySteps.push("Verify validation or next-step feedback is displayed without submitting destructive actions");
    } else {
        userJourneySteps.push("Click the primary navigation or call-to-action");
        userJourneySteps.push("Verify navigation or visible page state changes correctly");
    }

    const candidates = [
        {
            title: `UI E2E user journey on ${title}`,
            category: "UI_E2E",
            steps: userJourneySteps,
            expected: [
                "Page loads without errors",
                "Primary content and controls are visible",
                "The selected user journey behaves as expected"
            ]
        },
        {
            title: `Interruption and consent handling on ${title}`,
            category: "UI_E2E_INTERRUPTION",
            steps: [
                `Navigate to page: ${url}`,
                "Detect and safely dismiss cookie banners, privacy prompts, announcement modals, overlays, or interstitials",
                "Verify the main page content remains visible after interruptions are handled",
                "Verify the user can continue the primary page journey"
            ],
            expected: [
                "Non-business interruptions are handled safely",
                "No login, purchase, download, submit, save, or destructive action is triggered",
                "Main content is usable after interruption handling"
            ]
        },
        {
            title: `Backend API and network health on ${title}`,
            category: "BE_API",
            steps: [
                `Navigate to page: ${url}`,
                "Capture document, script, XHR, and fetch network responses during page load",
                "Verify critical same-origin API or document responses do not return 4xx or 5xx errors",
                "Verify the page can render even when optional third-party requests are ignored"
            ],
            expected: [
                "Critical backend responses return successful status codes",
                "No blocking API failures are visible to the user",
                apiSignals.length ? "Discovered network calls are available for deeper API assertions" : "Network discovery should identify document and API candidates"
            ]
        },
        {
            title: `Performance smoke on ${title}`,
            category: "PERFORMANCE",
            steps: [
                `Navigate to page: ${url}`,
                "Measure DOMContentLoaded and load timing",
                "Verify the main content appears within an acceptable timeout",
                "Check that the page does not keep the user blocked by long-running loaders"
            ],
            expected: [
                "Main content appears within 15 seconds",
                "DOMContentLoaded completes within the test timeout",
                "No endless blocking loader prevents basic usage"
            ]
        },
        {
            title: `Basic security posture on ${title}`,
            category: "SECURITY",
            steps: [
                `Navigate to page: ${url}`,
                "Verify the page is served over HTTPS",
                "Inspect response headers and browser console for obvious security issues",
                "Verify password fields, if present, are not prefilled or exposed as plain text"
            ],
            expected: [
                "The tested URL uses HTTPS",
                "No obvious mixed-content or severe security console errors appear",
                "Sensitive fields are not exposed insecurely"
            ]
        },
        {
            title: `Accessibility smoke on ${title}`,
            category: "ACCESSIBILITY",
            steps: [
                `Navigate to page: ${url}`,
                "Verify core interactive controls have accessible names or labels",
                "Navigate key controls using keyboard focus where possible",
                "Verify headings and main content provide a usable page structure"
            ],
            expected: [
                "Primary controls are reachable and visible",
                "Important controls expose meaningful labels",
                "Page structure includes visible content headings or landmarks"
            ]
        },
        {
            title: `SEO and metadata smoke on ${title}`,
            category: "SEO",
            steps: [
                `Navigate to page: ${url}`,
                "Verify the page title is present and meaningful",
                "Verify meta description or primary heading exists",
                "Verify important links have usable href values"
            ],
            expected: [
                "Page title is not empty",
                "Primary heading or meta description exists",
                "Visible links expose valid href attributes"
            ]
        },
        {
            title: `Responsive layout smoke on ${title}`,
            category: "RESPONSIVE",
            steps: [
                `Navigate to page: ${url}`,
                "Resize the viewport to a mobile width",
                "Verify main content and primary controls remain visible",
                "Resize the viewport to desktop width and verify layout recovers"
            ],
            expected: [
                "Main content is visible on mobile and desktop",
                "Primary controls do not overlap or disappear",
                "The page remains usable after viewport changes"
            ]
        },
        {
            title: `Navigation link smoke on ${title}`,
            category: "UI_NAVIGATION",
            steps: [
                `Navigate to page: ${url}`,
                "Collect visible navigation links",
                "Open the first safe internal navigation link",
                "Verify the destination page or section loads successfully"
            ],
            expected: [
                hasNavigation ? "At least one safe visible navigation link is available" : "If no navigation links exist, the page still renders useful content",
                "Navigation does not produce a browser error page",
                "Destination content is visible"
            ]
        },
        {
            title: `Console error smoke on ${title}`,
            category: "QUALITY",
            steps: [
                `Navigate to page: ${url}`,
                "Capture browser console messages during page load and first interaction",
                "Ignore known third-party warnings",
                "Verify no severe application errors block the user journey"
            ],
            expected: [
                "No severe first-party console errors block rendering",
                "The page remains interactive",
                "Any detected console errors are reported with evidence"
            ]
        }
    ];

    const selectedCandidates = candidates.filter(candidate => scenarioTypeMatches(candidate.category, selectedTypes));
    const scenarios = selectedCandidates.slice(0, count).map((candidate, index) => ({
        id: `scenario-${index + 1}`,
        title: candidate.title,
        category: candidate.category,
        selected: index === 0,
        text: buildScenario({ ...candidate, snapshot, elements })
    }));

    return { scenario: scenarios[0]?.text || "", scenarios, snapshot, generationMode: "rule-based-fallback" };
}

function pageHtml(initialScenario) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Playwright Automation Agent</title>
  <style>
    :root { color-scheme: light; --ink:#202124; --muted:#5f6368; --line:#d8dde6; --panel:#ffffff; --accent:#0b57d0; --ok:#147a3c; --warn:#b06000; --bg:#f5f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 system-ui, Segoe UI, Arial, sans-serif; color: var(--ink); background: var(--bg); }
    header { background: #102033; color: white; padding: 20px 28px; }
    header h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    header p { margin: 4px 0 0; color: #c9d7e8; }
    main { max-width: 1180px; margin: 0 auto; padding: 22px; display: grid; grid-template-columns: minmax(0, 1.25fr) 420px; gap: 18px; align-items: start; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    label { display: block; font-weight: 600; margin: 12px 0 6px; }
    textarea, input[type="url"], input[type="number"] { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 10px; font: 13px/1.4 Consolas, monospace; resize: vertical; background: white; }
    textarea { min-height: 230px; }
    input[type="url"], input[type="number"] { font-family: inherit; }
    input[type="number"] { max-width: 96px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .row label { margin: 0; font-weight: 500; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; font-weight: 650; cursor: pointer; background: var(--accent); color: white; }
    button.secondary { background: #e8eef8; color: #123; }
    button.danger { background: #fce8e6; color: #9b1c14; }
    button:disabled { opacity: .55; cursor: wait; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .toolbar { justify-content: space-between; margin-top: 8px; }
    .scenario-list { display: grid; gap: 10px; }
    .test-list { display: grid; gap: 8px; max-height: 220px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fbfcff; }
    .test-row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 8px; border-radius: 6px; background: #fff; border: 1px solid #edf1f7; }
    .test-name { font-family: Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .input-data-panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcff; display: grid; gap: 10px; }
    .input-data-grid { display: grid; gap: 8px; }
    .input-data-row { display: grid; grid-template-columns: minmax(120px, .45fr) minmax(180px, 1fr); gap: 10px; align-items: center; }
    .input-data-row span { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    details.scenario-card { border: 1px solid var(--line); border-radius: 8px; background: #fff; overflow: hidden; }
    details.scenario-card[open] { border-color: #9bb7e4; }
    summary { cursor: pointer; list-style: none; padding: 10px 12px; background: #f8fafd; display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; }
    summary::-webkit-details-marker { display: none; }
    .scenario-title { font-weight: 650; overflow-wrap: anywhere; }
    .badge { border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; font-size: 11px; color: #27415f; background: #eef4fb; }
    .scenario-status { border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; font-size: 11px; color: #3c4043; background: #f1f3f4; white-space: nowrap; }
    .scenario-status.queued { background: #f1f3f4; color: #3c4043; }
    .scenario-status.running { background: #fff4e5; color: #8a4b00; border-color: #f5c277; }
    .scenario-status.passed { background: #e6f4ea; color: #137333; border-color: #a8dab5; }
    .scenario-status.failed { background: #fce8e6; color: #a50e0e; border-color: #f4b4ae; }
    .scenario-status.ready { background: #e8eef8; color: #174ea6; border-color: #b7c9ef; }
    .scenario-status.completed { background: #e8eef8; color: #174ea6; border-color: #b7c9ef; }
    .agent-work-status { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; font-size: 12px; color: #27415f; background: #f8fafd; }
    .agent-work-status::before { content: ""; width: 8px; height: 8px; border-radius: 99px; background: var(--muted); }
    .agent-work-status.working::before { background: var(--warn); animation: pulse 1s infinite; }
    .agent-work-status.ready::before { background: var(--ok); }
    .agent-work-status.failed::before { background: #c5221f; }
    .scenario-body { padding: 12px; display: grid; gap: 10px; }
    .empty-state { border: 1px dashed var(--line); border-radius: 8px; padding: 16px; color: var(--muted); background: #fbfcff; }
    .status { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; background: #fff; }
    .dot { width: 9px; height: 9px; border-radius: 99px; background: var(--muted); }
    .status.running .dot { background: var(--warn); animation: pulse 1s infinite; }
    .status.passed .dot { background: var(--ok); }
    .status.failed .dot { background: #c5221f; }
    @keyframes pulse { 50% { opacity: .35; } }
    .floating-console { position: fixed; right: 18px; bottom: 18px; z-index: 50; width: min(430px, calc(100vw - 36px)); max-height: min(420px, calc(100vh - 36px)); box-shadow: 0 14px 42px rgba(16, 32, 51, .28); padding: 0; overflow: hidden; }
    .floating-console.expanded { width: min(860px, calc(100vw - 36px)); max-height: calc(100vh - 36px); }
    .console-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; background: #102033; color: #fff; }
    .console-header h2 { margin: 0; font-size: 14px; }
    .console-actions { display: flex; align-items: center; gap: 8px; }
    .console-actions button { padding: 7px 9px; background: #e8eef8; color: #123; }
    .console-body { padding: 12px; background: var(--panel); }
    pre { width: 100%; height: 180px; overflow: auto; margin: 10px 0 0; background: #101820; color: #e7edf3; border-radius: 8px; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.35; }
    .floating-console.expanded pre { height: min(680px, calc(100vh - 170px)); }
    .split { display: grid; gap: 14px; }
    .type-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; }
    .type-grid label { display: flex; align-items: center; gap: 7px; margin: 0; font-weight: 500; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: #fbfcff; }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      .floating-console { right: 10px; bottom: 10px; width: calc(100vw - 20px); }
      .floating-console.expanded pre { height: min(620px, calc(100vh - 165px)); }
    }
  </style>
</head>
<body>
  <header>
    <h1>Playwright Automation Agent</h1>
    <p>Generate, run, and heal tests from a written scenario or discovered site URL.</p>
  </header>
  <main>
    <section>
      <h2>Scenario</h2>
      <div class="split">
        <div>
          <label for="siteUrl">Discover from URL</label>
          <div class="row">
            <input id="siteUrl" type="url" placeholder="https://example.com">
            <input id="scenarioCount" type="number" min="1" max="10" value="5" title="Number of scenarios to generate">
            <button class="secondary" id="discoverBtn" type="button">Discover Scenarios</button>
          </div>
          <div class="hint">Choose 1-10 scenarios. Discovery drafts UI E2E, API, performance, security, accessibility, and quality scenarios when relevant.</div>
        </div>
        <div>
          <label>Test types to generate</label>
          <div class="type-grid" id="testTypeGrid">
            <label><input type="checkbox" value="UI_E2E" checked> UI E2E</label>
            <label><input type="checkbox" value="BE_API" checked> BE API</label>
            <label><input type="checkbox" value="PERFORMANCE" checked> Performance</label>
            <label><input type="checkbox" value="SECURITY" checked> Security</label>
            <label><input type="checkbox" value="ACCESSIBILITY" checked> Accessibility</label>
            <label><input type="checkbox" value="SEO" checked> SEO</label>
            <label><input type="checkbox" value="RESPONSIVE" checked> Responsive</label>
            <label><input type="checkbox" value="QUALITY" checked> Quality</label>
          </div>
          <div class="hint">Discovery will focus on the selected types only.</div>
        </div>
        <div>
          <div class="row toolbar">
            <label>Scenario drafts</label>
            <div class="row">
              <span class="agent-work-status" id="agentWorkStatus">Ready</span>
              <span class="hint" id="scenarioMeta">0 selected</span>
            </div>
          </div>
          <div class="hint" id="siteInsight"></div>
          <div id="scenarioList" class="scenario-list"></div>
        </div>
        <div class="row">
          <input id="cleanup" type="checkbox" checked>
          <label for="cleanup">Clean generated metadata before starting</label>
        </div>
        <div class="input-data-panel">
          <div class="row">
            <input id="useCustomInputData" type="checkbox">
            <label for="useCustomInputData">Ask me for input field data when fields are detected</label>
          </div>
          <div class="row">
            <input id="createDataProviders" type="checkbox" disabled>
            <label for="createDataProviders">Create data providers for each input field</label>
          </div>
          <div id="inputDataFields" class="input-data-grid"></div>
          <div class="hint">When enabled, generated tests use your values. With data providers enabled, the test creates at least 5 data cases based on each value.</div>
        </div>
        <div class="row">
          <button id="runBtn" type="button">Run Selected</button>
          <button class="secondary" id="reloadBtn" type="button">Reload scenario.txt</button>
          <button class="secondary" id="selectAllBtn" type="button">Select All</button>
          <button class="secondary" id="deleteSelectedBtn" type="button">Delete Selected</button>
          <button class="secondary" id="cleanScenarioBtn" type="button">Clean All</button>
        </div>
        <div>
          <div class="row toolbar">
            <label>Generated tests</label>
            <span class="hint" id="testMeta">0 tests</span>
          </div>
          <div id="generatedTestList" class="test-list"></div>
          <div class="row" style="margin-top: 10px;">
            <button class="secondary" id="refreshTestsBtn" type="button">Refresh Tests</button>
            <button id="runAllTestsBtn" type="button">Run All Tests</button>
            <button class="secondary" id="runSpecificTestsBtn" type="button">Run Specific Tests</button>
          </div>
          <div class="hint">These buttons execute already generated Playwright test files and create a Playwright HTML report.</div>
        </div>
      </div>
    </section>
    <section class="floating-console" id="floatingConsole">
      <div class="console-header">
        <h2>Console</h2>
        <div class="console-actions">
          <div id="status" class="status"><span class="dot"></span><span>idle</span></div>
          <button class="secondary" id="toggleConsoleBtn" type="button">Expand</button>
        </div>
      </div>
      <div class="console-body">
        <button class="secondary" id="clearLogsBtn" type="button">Clear Logs</button>
        <pre id="logs"></pre>
      </div>
    </section>
  </main>
  <script>
    const initialScenarioText = ${JSON.stringify(initialScenario || "")};
    let scenarios = initialScenarioText.trim()
      ? [{ id: 'scenario-1', title: readSubject(initialScenarioText) || 'Manual scenario', category: 'MANUAL', selected: true, open: true, text: initialScenarioText }]
      : [];
    let discoveryInsight = '';
    let lastScenarioStatuses = [];
    let generatedTests = [];
    let selectedGeneratedTests = new Set();
    let lastTestStatuses = [];
    let lastAiProviderStatusText = '';
    let detectedInputFields = [];

    const scenarioList = document.getElementById('scenarioList');
    const scenarioMeta = document.getElementById('scenarioMeta');
    const siteInsight = document.getElementById('siteInsight');
    const agentWorkStatus = document.getElementById('agentWorkStatus');
    const generatedTestList = document.getElementById('generatedTestList');
    const testMeta = document.getElementById('testMeta');
    const useCustomInputData = document.getElementById('useCustomInputData');
    const createDataProviders = document.getElementById('createDataProviders');
    const inputDataFields = document.getElementById('inputDataFields');
    const logs = document.getElementById('logs');
    const statusEl = document.getElementById('status');
    const runBtn = document.getElementById('runBtn');
    const discoverBtn = document.getElementById('discoverBtn');
    const floatingConsole = document.getElementById('floatingConsole');
    const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');

    function selectedTestTypes() {
      const types = Array.from(document.querySelectorAll('#testTypeGrid input[type="checkbox"]:checked')).map(input => input.value);
      return types.length ? types : ['UI_E2E'];
    }

    function readSubject(text) {
      const match = String(text || '').match(/^Subject:\\s*(.+)$/mi);
      return match ? match[1].trim() : '';
    }

    function escapeHtmlClient(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function cleanLogText(value) {
      return String(value || '')
        .replace(/\\x1B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1B\\\\))/g, '')
        .replace(/âœ…/g, '✅')
        .replace(/âŒ/g, '❌')
        .replace(/âš ï¸/g, '⚠️')
        .replace(/ðŸš€/g, '🚀')
        .replace(/ðŸ“/g, '📍')
        .replace(/ðŸ”/g, '🔍')
        .replace(/ðŸŽ¯/g, '🎯')
        .replace(/ðŸ“Š/g, '📊')
        .replace(/ðŸ“„/g, '📄')
        .replace(/ðŸ“Ž/g, '📎')
        .replace(/ðŸ› /g, '🛠')
        .replace(/ðŸ›/g, '🐛')
        .replace(/ðŸ/g, '🏁')
        .replace(/âŒ¨ï¸/g, '⌨️')
        .replace(/â°/g, '⏰')
        .replace(/â„¹ï¸/g, 'ℹ️');
    }

    function selectedScenarios() {
      return scenarios.filter(item => item.selected && item.text.trim());
    }

    function keyFromField(field, index) {
      const raw = field.attrs?.name || field.attrs?.id || field.attrs?.placeholder || field.text || ('input_' + (index + 1));
      return String(raw).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || ('input_' + (index + 1));
    }

    function fieldLabel(field, index) {
      return field.attrs?.placeholder || field.attrs?.['aria-label'] || field.attrs?.name || field.attrs?.id || field.text || ('Input ' + (index + 1));
    }

    function updateDetectedInputFields(snapshot) {
      const fields = (snapshot?.elements || [])
        .filter(el => ['input', 'textarea', 'select'].includes(el.tag))
        .filter(el => !/hidden|submit|button|checkbox|radio|file/i.test(el.attrs?.type || ''))
        .slice(0, 12)
        .map((field, index) => ({
          key: keyFromField(field, index),
          label: fieldLabel(field, index),
          placeholder: field.attrs?.placeholder || ''
        }));
      detectedInputFields = fields;
      renderInputDataFields();
    }

    function renderInputDataFields() {
      createDataProviders.disabled = !useCustomInputData.checked || !detectedInputFields.length;
      if (!detectedInputFields.length) createDataProviders.checked = false;
      inputDataFields.style.display = useCustomInputData.checked ? 'grid' : 'none';
      if (!useCustomInputData.checked) return;
      if (!detectedInputFields.length) {
        inputDataFields.innerHTML = '<div class="empty-state">No usable input fields were detected for this page. The agent will use its own safe fallback data only if needed.</div>';
        return;
      }
      inputDataFields.innerHTML = detectedInputFields.map(field => \`
        <label class="input-data-row">
          <span>\${escapeHtmlClient(field.label)}</span>
          <input data-input-key="\${escapeHtmlClient(field.key)}" type="text" placeholder="\${escapeHtmlClient(field.placeholder || 'Value to use in test')}">
        </label>
      \`).join('');
    }

    function collectInputDataOptions() {
      const fields = {};
      if (useCustomInputData.checked) {
        inputDataFields.querySelectorAll('[data-input-key]').forEach(input => {
          fields[input.dataset.inputKey] = input.value;
        });
      }
      return {
        enabled: useCustomInputData.checked,
        createDataProviders: useCustomInputData.checked && createDataProviders.checked,
        fields
      };
    }

    function displayScenarioStatus(item) {
      const selected = selectedScenarios();
      const selectedIndex = selected.findIndex(s => s.id === item.id);
      if (selectedIndex === -1) {
        return { label: 'Not selected', kind: 'queued' };
      }

      const live = lastScenarioStatuses[selectedIndex];
      if (!live) {
        return { label: item.selected ? 'Ready' : 'Not selected', kind: item.selected ? 'ready' : 'queued' };
      }

      if (live.status === 'running') return { label: 'Working...', kind: 'running' };
      if (live.status === 'passed') return { label: 'Test is Ready', kind: 'passed' };
      if (live.status === 'failed') return { label: 'Needs Attention', kind: 'failed' };
      return { label: 'Queued', kind: 'queued' };
    }

    function displayTestStatus(test, index) {
      const live = lastTestStatuses.find(item => item.name === test.name) || lastTestStatuses[index];
      if (!live) return { label: 'Ready', kind: 'ready' };
      if (live.status === 'queued') return { label: 'Queued', kind: 'queued' };
      if (live.status === 'running') return { label: 'Working...', kind: 'running' };
      if (live.status === 'passed') return { label: 'Passed', kind: 'passed' };
      if (live.status === 'failed') return { label: 'Failed', kind: 'failed' };
      return { label: 'Completed', kind: 'completed' };
    }

    function renderGeneratedTests() {
      const selectedCount = generatedTests.filter(test => selectedGeneratedTests.has(test.name)).length;
      testMeta.textContent = generatedTests.length ? selectedCount + ' selected of ' + generatedTests.length : '0 tests';

      if (!generatedTests.length) {
        generatedTestList.innerHTML = '<div class="empty-state">No generated test files found yet.</div>';
        return;
      }

      generatedTestList.innerHTML = generatedTests.map((test, index) => {
        const status = displayTestStatus(test, index);
        return \`
          <label class="test-row">
            <input type="checkbox" data-test-select="\${escapeHtmlClient(test.name)}" \${selectedGeneratedTests.has(test.name) ? 'checked' : ''}>
            <span class="test-name">\${escapeHtmlClient(test.name)}</span>
            <span class="scenario-status \${status.kind}">\${status.label}</span>
          </label>
        \`;
      }).join('');

      generatedTestList.querySelectorAll('[data-test-select]').forEach(input => {
        input.addEventListener('change', () => {
          if (input.checked) selectedGeneratedTests.add(input.dataset.testSelect);
          else selectedGeneratedTests.delete(input.dataset.testSelect);
          renderGeneratedTests();
        });
      });
    }

    async function loadGeneratedTests() {
      const res = await fetch('/api/generated-tests');
      const data = await res.json();
      generatedTests = data.tests || [];
      generatedTests.forEach(test => {
        if (!selectedGeneratedTests.size) selectedGeneratedTests.add(test.name);
      });
      for (const name of Array.from(selectedGeneratedTests)) {
        if (!generatedTests.some(test => test.name === name)) selectedGeneratedTests.delete(name);
      }
      renderGeneratedTests();
    }

    function setAgentWorkStatus(label, kind = 'idle') {
      agentWorkStatus.textContent = label;
      agentWorkStatus.className = 'agent-work-status ' + kind;
    }

    function syncScenarioFromTextarea(id) {
      const item = scenarios.find(s => s.id === id);
      const textarea = document.querySelector('[data-scenario-text="' + id + '"]');
      if (item && textarea) {
        item.text = textarea.value;
        item.title = readSubject(item.text) || item.title || 'Scenario';
      }
    }

    function renderScenarios() {
      const selectedCount = selectedScenarios().length;
      scenarioMeta.textContent = scenarios.length ? selectedCount + ' selected of ' + scenarios.length : '0 selected';
      siteInsight.textContent = discoveryInsight;

      if (!scenarios.length) {
        scenarioList.innerHTML = '<div class="empty-state">No scenarios yet. Enter a URL and click Discover Scenarios, or reload scenario.txt.</div>';
        return;
      }

      scenarioList.innerHTML = scenarios.map((item, index) => {
        const title = escapeHtmlClient(readSubject(item.text) || item.title || ('Scenario ' + (index + 1)));
        const category = escapeHtmlClient(item.category || 'SCENARIO');
        const cardStatus = displayScenarioStatus(item);
        return \`
          <details class="scenario-card" \${item.open ? 'open' : ''} data-scenario-id="\${item.id}">
            <summary>
              <input type="checkbox" data-scenario-select="\${item.id}" \${item.selected ? 'checked' : ''} onclick="event.stopPropagation()">
              <span class="scenario-title">\${index + 1}. \${title}</span>
              <span class="row">
                <span class="scenario-status \${cardStatus.kind}">\${cardStatus.label}</span>
                <span class="badge">\${category}</span>
              </span>
            </summary>
            <div class="scenario-body">
              <textarea data-scenario-text="\${item.id}">\${escapeHtmlClient(item.text)}</textarea>
              <div class="row">
                <button class="secondary" type="button" data-scenario-save="\${item.id}">Save to scenario.txt</button>
                <button class="danger" type="button" data-scenario-delete="\${item.id}">Delete</button>
              </div>
            </div>
          </details>
        \`;
      }).join('');

      scenarioList.querySelectorAll('[data-scenario-select]').forEach(input => {
        input.addEventListener('change', () => {
          const item = scenarios.find(s => s.id === input.dataset.scenarioSelect);
          if (item) item.selected = input.checked;
          renderScenarios();
        });
      });

      scenarioList.querySelectorAll('[data-scenario-text]').forEach(textarea => {
        textarea.addEventListener('input', () => {
          syncScenarioFromTextarea(textarea.dataset.scenarioText);
          scenarioMeta.textContent = selectedScenarios().length + ' selected of ' + scenarios.length;
        });
      });

      scenarioList.querySelectorAll('[data-scenario-save]').forEach(button => {
        button.addEventListener('click', async () => {
          syncScenarioFromTextarea(button.dataset.scenarioSave);
          const item = scenarios.find(s => s.id === button.dataset.scenarioSave);
          if (!item || !item.text.trim()) return alert('Scenario is empty.');
          const res = await fetch('/api/scenario', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenarioText: item.text })
          });
          if (!res.ok) return alert((await res.json()).error || 'Failed to save scenario');
          await refresh();
        });
      });

      scenarioList.querySelectorAll('[data-scenario-delete]').forEach(button => {
        button.addEventListener('click', () => {
          scenarios = scenarios.filter(s => s.id !== button.dataset.scenarioDelete);
          renderScenarios();
        });
      });

      scenarioList.querySelectorAll('details.scenario-card').forEach(details => {
        details.addEventListener('toggle', () => {
          const item = scenarios.find(s => s.id === details.dataset.scenarioId);
          if (item) item.open = details.open;
        });
      });
    }

    function setStatus(state) {
      const previousStatuses = JSON.stringify(lastScenarioStatuses || []);
      const previousTestStatuses = JSON.stringify(lastTestStatuses || []);
      const previousGeneratedTests = JSON.stringify(generatedTests.map(test => test.name));
      lastScenarioStatuses = Array.isArray(state.scenarioStatuses) ? state.scenarioStatuses : [];
      lastTestStatuses = Array.isArray(state.testStatuses) ? state.testStatuses : [];
      if (Array.isArray(state.generatedTests)) {
        generatedTests = state.generatedTests;
        generatedTests.forEach(test => {
          if (!selectedGeneratedTests.size) selectedGeneratedTests.add(test.name);
        });
        for (const name of Array.from(selectedGeneratedTests)) {
          if (!generatedTests.some(test => test.name === name)) selectedGeneratedTests.delete(name);
        }
      }
      statusEl.className = 'status ' + (state.status || 'idle');
      statusEl.querySelector('span:last-child').textContent = state.running ? 'running' : (state.status || 'idle');
      if (state.running) {
        setAgentWorkStatus('Working', 'working');
      } else if (state.status === 'passed') {
        setAgentWorkStatus('Test is Ready', 'ready');
      } else if (state.status === 'failed') {
        setAgentWorkStatus('Needs Attention', 'failed');
      } else if (scenarios.length) {
        setAgentWorkStatus('Scenarios Ready', 'ready');
      } else {
        setAgentWorkStatus('Ready', 'idle');
      }
      runBtn.disabled = !!state.running;
      discoverBtn.disabled = !!state.running;
      document.getElementById('runAllTestsBtn').disabled = !!state.running;
      document.getElementById('runSpecificTestsBtn').disabled = !!state.running;
      document.getElementById('refreshTestsBtn').disabled = !!state.running;
      logs.textContent = cleanLogText((state.logs || []).join(''));
      if (state.reportUrl) {
        logs.textContent += '\\nReport: ' + location.origin + state.reportUrl + '\\n';
      }
      const aiStatus = Array.isArray(state.aiProviderStatus) ? state.aiProviderStatus : [];
      const latestAi = aiStatus[aiStatus.length - 1];
      if (latestAi) {
        const aiLine = 'AI Provider: ' + latestAi.provider + ' / ' + latestAi.model + ' / ' + latestAi.status + (latestAi.errorCode ? ' / ' + latestAi.errorCode : '');
        if (aiLine !== lastAiProviderStatusText) {
          lastAiProviderStatusText = aiLine;
        }
        logs.textContent += '\\n' + aiLine + '\\n';
      }
      logs.scrollTop = logs.scrollHeight;
      if (JSON.stringify(lastScenarioStatuses || []) !== previousStatuses) {
        renderScenarios();
      }
      if (JSON.stringify(lastTestStatuses || []) !== previousTestStatuses) {
        renderGeneratedTests();
      }
      if (JSON.stringify(generatedTests.map(test => test.name)) !== previousGeneratedTests) {
        renderGeneratedTests();
      }
    }

    async function refresh() {
      const res = await fetch('/api/status');
      setStatus(await res.json());
    }

    document.getElementById('runBtn').onclick = async () => {
      scenarios.forEach(item => syncScenarioFromTextarea(item.id));
      const selected = selectedScenarios();
      if (!selected.length) return alert('Select at least one scenario to run.');
      lastScenarioStatuses = selected.map((item, index) => ({ index, title: readSubject(item.text) || item.title || ('Scenario ' + (index + 1)), status: 'queued' }));
      renderScenarios();
      const res = await fetch('/api/run-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioTexts: selected.map(item => item.text),
          cleanupFirst: document.getElementById('cleanup').checked,
          inputDataOptions: collectInputDataOptions()
        })
      });
      if (!res.ok) alert((await res.json()).error || 'Failed to start agent');
      await refresh();
    };

    document.getElementById('discoverBtn').onclick = async () => {
      const url = document.getElementById('siteUrl').value.trim();
      const count = Math.max(1, Math.min(10, Number(document.getElementById('scenarioCount').value || 5)));
      if (!url) return alert('Enter a URL first.');
      discoverBtn.disabled = true;
      discoverBtn.textContent = 'Discovering...';
      setAgentWorkStatus('Discovering', 'working');
      try {
        const res = await fetch('/api/discover-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, count, types: selectedTestTypes() })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Discovery failed');
        scenarios = (data.scenarios || []).map((item, index) => ({
          id: item.id || ('scenario-' + (Date.now() + index)),
          title: item.title || readSubject(item.text) || ('Scenario ' + (index + 1)),
          category: item.category || 'SCENARIO',
          selected: index === 0,
          open: index === 0,
          text: item.text || ''
        }));
        if (data.sitePurpose) {
          const users = Array.isArray(data.primaryUsers) && data.primaryUsers.length ? ' Users: ' + data.primaryUsers.slice(0, 3).join(', ') + '.' : '';
          const goals = Array.isArray(data.mainUserGoals) && data.mainUserGoals.length ? ' Goals: ' + data.mainUserGoals.slice(0, 3).join(', ') + '.' : '';
          discoveryInsight = 'Semantic discovery: ' + data.sitePurpose + users + goals;
        } else {
          discoveryInsight = data.generationMode === 'rule-based-fallback'
            ? 'Rule-based fallback discovery was used.'
            : '';
        }
        updateDetectedInputFields(data.snapshot);
        renderScenarios();
        setAgentWorkStatus('Scenarios Ready', 'ready');
      } catch (error) {
        setAgentWorkStatus('Discovery Failed', 'failed');
        alert(error.message);
      } finally {
        discoverBtn.disabled = false;
        discoverBtn.textContent = 'Discover Scenarios';
      }
    };

    document.getElementById('reloadBtn').onclick = async () => {
      const res = await fetch('/api/scenario');
      const text = (await res.json()).scenarioText || '';
      scenarios = text.trim()
        ? [{ id: 'scenario-1', title: readSubject(text) || 'Saved scenario', category: 'MANUAL', selected: true, open: true, text }]
        : [];
      discoveryInsight = text.trim() ? 'Loaded from scenario.txt.' : '';
      renderScenarios();
    };

    document.getElementById('selectAllBtn').onclick = () => {
      const allSelected = scenarios.length > 0 && scenarios.every(item => item.selected);
      scenarios.forEach(item => item.selected = !allSelected);
      renderScenarios();
    };

    document.getElementById('deleteSelectedBtn').onclick = () => {
      const selected = selectedScenarios();
      if (!selected.length) return alert('Select scenarios to delete.');
      if (!confirm('Delete selected scenarios from the UI?')) return;
      scenarios = scenarios.filter(item => !item.selected);
      renderScenarios();
    };

    document.getElementById('cleanScenarioBtn').onclick = async () => {
      if (!confirm('Clear all scenario drafts and scenario.txt?')) return;
      const res = await fetch('/api/scenario', { method: 'DELETE' });
      if (!res.ok) return alert((await res.json()).error || 'Failed to clean scenario');
      scenarios = [];
      discoveryInsight = '';
      renderScenarios();
      await refresh();
    };

    document.getElementById('clearLogsBtn').onclick = async () => {
      const res = await fetch('/api/logs', { method: 'DELETE' });
      if (!res.ok) return alert((await res.json()).error || 'Failed to clear logs');
      await refresh();
    };

    toggleConsoleBtn.onclick = () => {
      const expanded = floatingConsole.classList.toggle('expanded');
      toggleConsoleBtn.textContent = expanded ? 'Shrink' : 'Expand';
      logs.scrollTop = logs.scrollHeight;
    };

    useCustomInputData.onchange = renderInputDataFields;
    createDataProviders.onchange = renderInputDataFields;

    document.getElementById('refreshTestsBtn').onclick = loadGeneratedTests;

    document.getElementById('runAllTestsBtn').onclick = async () => {
      if (!generatedTests.length) await loadGeneratedTests();
      if (!generatedTests.length) return alert('No generated tests found.');
      lastTestStatuses = generatedTests.map((test, index) => ({ index, name: test.name, status: 'queued' }));
      renderGeneratedTests();
      const res = await fetch('/api/run-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true })
      });
      if (!res.ok) return alert((await res.json()).error || 'Failed to run tests');
      await refresh();
    };

    document.getElementById('runSpecificTestsBtn').onclick = async () => {
      const files = generatedTests.filter(test => selectedGeneratedTests.has(test.name)).map(test => test.name);
      if (!files.length) return alert('Choose at least one generated test.');
      lastTestStatuses = files.map((name, index) => ({ index, name, status: 'queued' }));
      renderGeneratedTests();
      const res = await fetch('/api/run-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files })
      });
      if (!res.ok) return alert((await res.json()).error || 'Failed to run selected tests');
      await refresh();
    };

    setInterval(refresh, 1200);
    renderScenarios();
    renderInputDataFields();
    loadGeneratedTests();
    refresh();
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".html") return "text/html; charset=utf-8";
    if (ext === ".js") return "application/javascript; charset=utf-8";
    if (ext === ".css") return "text/css; charset=utf-8";
    if (ext === ".json") return "application/json; charset=utf-8";
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".webm") return "video/webm";
    return "application/octet-stream";
}

function serveStaticFile(res, baseDir, requestPath) {
    const relative = decodeURIComponent(requestPath).replace(/^\/+/, "");
    const safePath = path.resolve(baseDir, relative || "index.html");
    if (!safePath.startsWith(path.resolve(baseDir))) {
        sendJson(res, 403, { error: "Forbidden." });
        return true;
    }
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
        sendJson(res, 404, { error: "Report file not found." });
        return true;
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(safePath), "Cache-Control": "no-store" });
    fs.createReadStream(safePath).pipe(res);
    return true;
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (req.method === "GET" && url.pathname.startsWith("/playwright-report")) {
            const reportPath = url.pathname.replace(/^\/playwright-report\/?/, "");
            serveStaticFile(res, playwrightReportDir, reportPath || "index.html");
            return;
        }

        if (req.method === "GET" && url.pathname === "/") {
            const initialScenario = fs.existsSync(testsScenarioPath)
                ? fs.readFileSync(testsScenarioPath, "utf8")
                : "";
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(pageHtml(initialScenario));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/status") {
            runState.aiProviderStatus = readAiProviderStatus();
            sendJson(res, 200, runState);
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/generated-tests") {
            sendJson(res, 200, { tests: listGeneratedTests() });
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/scenario") {
            sendJson(res, 200, {
                scenarioText: fs.existsSync(testsScenarioPath) ? fs.readFileSync(testsScenarioPath, "utf8") : ""
            });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/scenario") {
            const payload = JSON.parse(await readBody(req) || "{}");
            if (!payload.scenarioText || !String(payload.scenarioText).trim()) {
                sendJson(res, 400, { error: "Scenario text is required." });
                return;
            }
            fs.mkdirSync(path.dirname(testsScenarioPath), { recursive: true });
            fs.writeFileSync(testsScenarioPath, String(payload.scenarioText), "utf8");
            pushLog("Scenario saved to scenario.txt.\n");
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === "DELETE" && url.pathname === "/api/scenario") {
            fs.mkdirSync(path.dirname(testsScenarioPath), { recursive: true });
            fs.writeFileSync(testsScenarioPath, "", "utf8");
            pushLog("Scenario text cleared.\n");
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === "DELETE" && url.pathname === "/api/logs") {
            runState.logs = [];
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/discover-url") {
            const payload = JSON.parse(await readBody(req) || "{}");
            if (!payload.url || !/^https?:\/\//i.test(payload.url)) {
                sendJson(res, 400, { error: "Enter a valid http(s) URL." });
                return;
            }
            const result = await suggestScenariosFromUrl(payload.url, payload.count, payload.types);
            sendJson(res, 200, result);
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/run-manual") {
            const payload = JSON.parse(await readBody(req) || "{}");
            const scenarioTexts = Array.isArray(payload.scenarioTexts)
                ? payload.scenarioTexts.map(text => String(text || "").trim()).filter(Boolean).slice(0, 10)
                : [];
            const singleScenarioText = String(payload.scenarioText || "").trim();
            if (scenarioTexts.length === 0 && !singleScenarioText) {
                sendJson(res, 400, { error: "Select at least one scenario to run." });
                return;
            }
            if (runState.running) {
                sendJson(res, 409, { error: "Agent is already running." });
                return;
            }
            runManualPipeline({
                scenarioText: singleScenarioText,
                scenarioTexts,
                inputDataOptions: payload.inputDataOptions || { enabled: false, createDataProviders: false, fields: {} },
                cleanupFirst: payload.cleanupFirst !== false
            });
            sendJson(res, 202, { ok: true });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/run-tests") {
            const payload = JSON.parse(await readBody(req) || "{}");
            if (runState.running) {
                sendJson(res, 409, { error: "Agent is already running." });
                return;
            }
            runGeneratedTests({
                all: payload.all === true,
                files: payload.files
            });
            sendJson(res, 202, { ok: true });
            return;
        }

        sendJson(res, 404, { error: "Not found." });
    } catch (error) {
        sendJson(res, 500, { error: error.message });
    }
});

server.listen(PORT, () => {
    console.log(`Playwright Automation Agent UI is running at http://localhost:${PORT}`);
});
