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
const testResultsDir = path.join(repoRoot, "test-results");
const aiProviderStatusPath = path.join(generatedDir, "ai_provider_status.jsonl");
const uiStatePath = path.join(generatedDir, "ui_state.json");
const PORT = Number(process.env.AGENT_UI_PORT || 3789);

const persistedUiState = loadPersistentUiState();
let runState = {
    running: false,
    status: "idle",
    scenarioStatuses: [],
    testStatuses: [],
    scenarioDrafts: persistedUiState.scenarioDrafts,
    discoveryInsight: persistedUiState.discoveryInsight,
    generatedTests: listGeneratedTests(),
    failureSummary: null,
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
        let child;
        try {
            child = spawn(command, args, {
                cwd,
                shell: false,
                env: { ...process.env }
            });
        } catch (error) {
            pushLog(`Command failed to start: ${error.message}\n`);
            resolve(1);
            return;
        }

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

function runCommandCapture(command, args, label, cwd = agentDir) {
    return new Promise((resolve) => {
        pushLog(`\n=== ${label} ===\n`);
        let child;
        let output = "";
        try {
            child = spawn(command, args, {
                cwd,
                shell: false,
                env: { ...process.env }
            });
        } catch (error) {
            const message = `Command failed to start: ${error.message}\n`;
            pushLog(message);
            resolve({ code: 1, output: message });
            return;
        }

        child.stdout.on("data", data => {
            const text = data.toString();
            output += text;
            pushLog(text);
        });
        child.stderr.on("data", data => {
            const text = data.toString();
            output += text;
            pushLog(text);
        });
        child.on("error", error => {
            const message = `Command failed to start: ${error.message}\n`;
            output += message;
            pushLog(message);
            resolve({ code: 1, output });
        });
        child.on("close", code => {
            const message = `\n=== ${label} exited with ${code} ===\n`;
            output += message;
            pushLog(message);
            resolve({ code: code ?? 1, output });
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

function readTaskStateSafe() {
    const statePath = path.join(agentDir, "task_state.json");
    try {
        if (!fs.existsSync(statePath)) return {};
        return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
        return {};
    }
}

function didExhaustHealingRetries() {
    const healer = readTaskStateSafe().healer || {};
    const attempts = Number(healer.healingAttempts || 0);
    const maxRetries = Number(healer.maxRetries || 15);
    return healer.completed === false && attempts >= maxRetries;
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

function findLatestFile(rootDir, extensions) {
    if (!fs.existsSync(rootDir)) return null;
    const wanted = new Set(extensions.map(ext => ext.toLowerCase()));
    let latest = null;

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (!entry.isFile() || !wanted.has(path.extname(entry.name).toLowerCase())) continue;
            const stat = fs.statSync(fullPath);
            if (!latest || stat.mtimeMs > latest.mtimeMs) {
                latest = { fullPath, mtimeMs: stat.mtimeMs, lastModified: stat.mtime.toISOString() };
            }
        }
    };

    walk(rootDir);
    return latest;
}

function latestErrorContexts(limit = 5) {
    if (!fs.existsSync(testResultsDir)) return [];
    const contexts = [];

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (entry.isFile() && entry.name === "error-context.md") {
                const stat = fs.statSync(fullPath);
                contexts.push({ fullPath, mtimeMs: stat.mtimeMs });
            }
        }
    };

    walk(testResultsDir);
    return contexts
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit)
        .map(context => {
            const text = fs.readFileSync(context.fullPath, "utf8");
            return {
                path: context.fullPath,
                relativePath: path.relative(testResultsDir, context.fullPath).replace(/\\/g, "/"),
                text
            };
        });
}

function plainEnglishReason(errorText) {
    const text = String(errorText || "");
    const lower = text.toLowerCase();
    if (lower.includes("cannot navigate to invalid url")) {
        return {
            reason: "The test tried to open a partial URL, but Playwright needs a full URL unless the project has a base URL configured.",
            nextAction: "Update the generated test to use the full site URL, or configure Playwright baseURL for this project."
        };
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
        return {
            reason: "The test waited too long for something to appear or finish loading.",
            nextAction: "Open the screenshot/report and check whether the page was slow, blocked by a popup, or using a different element than expected."
        };
    }
    if (lower.includes("strict mode violation")) {
        return {
            reason: "The test found more than one matching element and did not know which one to use.",
            nextAction: "Make the selector more specific, for example by using visible text, role, or a nearby label."
        };
    }
    if (lower.includes("expect(") || lower.includes("to be visible") || lower.includes("tobevisible")) {
        return {
            reason: "An expected element or text was not visible on the page.",
            nextAction: "Check the screenshot to see whether the page content changed, a modal is covering it, or the test expectation is too strict."
        };
    }
    if (lower.includes("net::") || lower.includes("navigation failed")) {
        return {
            reason: "The browser could not load the page or a required network request failed.",
            nextAction: "Verify the URL is reachable in Chrome and check whether the site blocks automation or requires login/location/cookies."
        };
    }
    return {
        reason: "Playwright reported a test failure. The detailed error and report contain the exact technical evidence.",
        nextAction: "Open the screenshot and Playwright report, then adjust the scenario, selector, wait, or test data based on what is visible."
    };
}

function buildFailureSummary({ output, selectedNames, exitCode }) {
    if (exitCode === 0) return null;

    const contexts = latestErrorContexts(5);
    const contextText = contexts.map(context => context.text).join("\n\n");
    const combined = `${contextText}\n\n${output || ""}`;
    const nameMatch = combined.match(/- Name:\s*(.+)/) || combined.match(/\]\s+›\s+(.+)/);
    const locationMatch = combined.match(/- Location:\s*(.+)/) || combined.match(/\n\s+at\s+(.+:\d+:\d+)/);
    const errorBlockMatch = combined.match(/# Error details\s*```([\s\S]*?)```/) || combined.match(/\n\s*(Error:[\s\S]*?)(?:\n\s+at |\n\s*attachment|\n\s*\d+\s+failed|$)/);
    const stepMatch = combined.match(/(?:STEP|Step)\s+\d+[:\s-]+([^\n]+)/);
    const errorText = (errorBlockMatch?.[1] || errorBlockMatch?.[0] || "No detailed Playwright error was found.").trim();
    const friendly = plainEnglishReason(errorText);
    const screenshot = findLatestFile(testResultsDir, [".png", ".jpg", ".jpeg"]);

    return {
        title: "Some generated tests failed",
        failedTest: (nameMatch?.[1] || selectedNames[0] || "Unknown test").trim(),
        failedStep: stepMatch?.[0]?.trim() || "Could not detect the exact step from the logs.",
        location: (locationMatch?.[1] || "Open the Playwright report for the exact file and line.").trim(),
        plainReason: friendly.reason,
        technicalError: errorText.split(/\r?\n/).slice(0, 8).join("\n"),
        nextAction: friendly.nextAction,
        screenshotUrl: screenshot ? `/test-results/${path.relative(testResultsDir, screenshot.fullPath).replace(/\\/g, "/")}?t=${Math.round(screenshot.mtimeMs)}` : "",
        reportUrl: "/playwright-report/index.html"
    };
}

function currentPreviewState() {
    const runningTest = runState.testStatuses?.find(item => item.status === "running")
        || runState.testStatuses?.find(item => item.status === "queued")
        || null;
    const runningScenario = runState.scenarioStatuses?.find(item => item.status === "running")
        || runState.scenarioStatuses?.find(item => item.status === "queued")
        || null;
    const latestScreenshot = findLatestFile(testResultsDir, [".png", ".jpg", ".jpeg"]);

    return {
        title: runningTest?.name || runningScenario?.title || "No active test",
        status: runningTest?.status || runningScenario?.status || runState.status || "idle",
        screenshotUrl: latestScreenshot
            ? `/test-results/${path.relative(testResultsDir, latestScreenshot.fullPath).replace(/\\/g, "/")}?t=${Math.round(latestScreenshot.mtimeMs)}`
            : "",
        screenshotUpdatedAt: latestScreenshot?.lastModified || "",
        reportUrl: runState.reportUrl || ""
    };
}

function loadPersistentUiState() {
    if (!fs.existsSync(uiStatePath)) {
        const scenarioDrafts = scenarioDraftsFromGeneratedTests();
        return {
            scenarioDrafts,
            discoveryInsight: scenarioDrafts.length ? "Restored from generated test files." : ""
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(uiStatePath, "utf8"));
        const hasSavedDrafts = Array.isArray(parsed.scenarioDrafts);
        const scenarioDrafts = hasSavedDrafts ? normalizeScenarioDrafts(parsed.scenarioDrafts) : scenarioDraftsFromGeneratedTests();
        return {
            scenarioDrafts,
            discoveryInsight: String(parsed.discoveryInsight || (!hasSavedDrafts && scenarioDrafts.length ? "Restored from generated test files." : ""))
        };
    } catch {
        const scenarioDrafts = scenarioDraftsFromGeneratedTests();
        return {
            scenarioDrafts,
            discoveryInsight: scenarioDrafts.length ? "Restored from generated test files." : ""
        };
    }
}

function savePersistentUiState() {
    try {
        fs.mkdirSync(generatedDir, { recursive: true });
        fs.writeFileSync(uiStatePath, JSON.stringify({
            scenarioDrafts: normalizeScenarioDrafts(runState.scenarioDrafts),
            discoveryInsight: runState.discoveryInsight || "",
            generatedTests: listGeneratedTests(),
            updatedAt: new Date().toISOString()
        }, null, 2), "utf8");
    } catch (error) {
        pushLog(`Could not save UI state: ${error.message}\n`);
    }
}

function normalizeScenarioDrafts(drafts) {
    return (Array.isArray(drafts) ? drafts : [])
        .slice(0, 10)
        .map((item, index) => {
            const text = String(item?.text || "").trim();
            const id = String(item?.id || `scenario-${index + 1}`);
            return {
                id,
                title: String(item?.title || scenarioSubject(text, `Scenario ${index + 1}`)),
                category: String(item?.category || "SCENARIO"),
                selected: item?.selected === undefined ? index === 0 : item.selected !== false,
                open: item?.open === true || index === 0,
                text
            };
        })
        .filter(item => item.text);
}

function scenarioDraftsFromGeneratedTests() {
    return listGeneratedTests().slice(0, 10).map((testFile, index) => {
        const absolutePath = path.join(generatedTestsDir, testFile.name);
        let content = "";
        try {
            content = fs.readFileSync(absolutePath, "utf8");
        } catch {
            content = "";
        }

        const testTitleMatch = content.match(/test\(\s*['"`]([^'"`]+)['"`]/);
        const descriptionMatch = content.match(/description:\s*['"`]([^'"`]+)['"`]/i);
        const title = testTitleMatch?.[1] || descriptionMatch?.[1] || testFile.name.replace(/\.test\.ts$/i, "").replace(/_/g, " ");
        const category = /api|endpoint|response/i.test(title) ? "BE_API" : "UI_E2E";

        return {
            id: `generated-test-${index + 1}`,
            title,
            category,
            selected: false,
            open: index === 0,
            text: [
                `Subject: ${title}`,
                "User: no user",
                "Steps:",
                `1. Review generated test file: ${testFile.relativePath}`,
                "2. Run the generated Playwright test from the Generated Tests section",
                "3. Review the Playwright report for pass/fail evidence",
                "",
                "Expected:",
                "The generated test executes successfully and reports reliable validation results.",
                "",
                "Additional:",
                `Category: ${category}`,
                `Restored from generated test file: ${testFile.name}`
            ].join("\n")
        };
    });
}

function cleanReviewArtifacts() {
    fs.mkdirSync(path.dirname(testsScenarioPath), { recursive: true });
    fs.writeFileSync(testsScenarioPath, "", "utf8");

    if (fs.existsSync(generatedTestsDir)) {
        for (const file of fs.readdirSync(generatedTestsDir)) {
            if (file.endsWith(".test.ts")) {
                fs.unlinkSync(path.join(generatedTestsDir, file));
            }
        }
    }

    if (fs.existsSync(uiStatePath)) {
        fs.unlinkSync(uiStatePath);
    }

    runState.scenarioDrafts = [];
    runState.discoveryInsight = "";
    runState.scenarioStatuses = [];
    runState.testStatuses = [];
    runState.generatedTests = [];
    runState.failureSummary = null;
    runState.reportUrl = null;
    runState.exitCode = null;
    runState.status = "idle";
    savePersistentUiState();
}

function discoveryInsightFromResult(result) {
    if (result?.sitePurpose) {
        const users = Array.isArray(result.primaryUsers) && result.primaryUsers.length
            ? ` Users: ${result.primaryUsers.slice(0, 3).join(", ")}.`
            : "";
        const goals = Array.isArray(result.mainUserGoals) && result.mainUserGoals.length
            ? ` Goals: ${result.mainUserGoals.slice(0, 3).join(", ")}.`
            : "";
        return `Semantic discovery: ${result.sitePurpose}${users}${goals}`;
    }

    return result?.generationMode === "rule-based-fallback"
        ? "Rule-based fallback discovery was used."
        : "";
}

async function runGeneratedTests({ files, all = false, parallel = false }) {
    if (runState.running) {
        throw new Error("Agent is already running.");
    }

    const tests = listGeneratedTests();
    const selectedNames = all ? tests.map(test => test.name) : sanitizeGeneratedTestNames(files);
    if (!selectedNames.length) {
        throw new Error("No generated tests selected.");
    }

    const preservedScenarioDrafts = normalizeScenarioDrafts(runState.scenarioDrafts);
    const preservedDiscoveryInsight = runState.discoveryInsight || "";

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
        scenarioDrafts: preservedScenarioDrafts,
        discoveryInsight: preservedDiscoveryInsight,
        generatedTests: tests,
        failureSummary: null,
        reportUrl: null,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null
    };
    savePersistentUiState();

    try {
        pushLog(`Running ${selectedNames.length} generated test file(s)${parallel ? " in parallel" : ""}.\n`);
        runState.testStatuses.forEach(test => {
            test.status = "running";
            test.startedAt = new Date().toISOString();
        });

        const playwrightCli = [
            path.join(repoRoot, "node_modules", "playwright", "cli.js"),
            path.join(agentDir, "node_modules", "playwright", "cli.js")
        ].find(candidate => fs.existsSync(candidate));
        const playwrightCommand = playwrightCli
            ? process.execPath
            : process.platform === "win32" ? "npx.cmd" : "npx";
        const playwrightArgsPrefix = playwrightCli
            ? [playwrightCli]
            : ["playwright"];
        const relativePaths = selectedNames.map(name => `tests/generated-from-agentFallBack/${name}`);
        const workerArgs = parallel
            ? ["--workers", String(Math.min(Math.max(selectedNames.length, 1), 6))]
            : ["--workers", "1"];
        const result = await runCommandCapture(
            playwrightCommand,
            [...playwrightArgsPrefix, "test", ...relativePaths, "--project=chromium", ...workerArgs],
            all ? "Run all generated tests" : "Run selected generated tests",
            repoRoot
        );
        const exitCode = result.code;

        runState.testStatuses.forEach(test => {
            test.status = exitCode === 0 ? "passed" : "needs_attention";
            test.finishedAt = new Date().toISOString();
        });
        runState.status = exitCode === 0 ? "passed" : "failed";
        runState.exitCode = exitCode;
        runState.reportUrl = "/playwright-report/index.html";
        runState.failureSummary = buildFailureSummary({ output: result.output, selectedNames, exitCode });
        runState.generatedTests = listGeneratedTests();
        savePersistentUiState();
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
        runState.failureSummary = {
            title: "The test runner could not complete",
            failedTest: "Generated test run",
            failedStep: "Starting or running Playwright",
            location: "UI generated test runner",
            plainReason: "The test command failed before a normal Playwright result could be created.",
            technicalError: error.message,
            nextAction: "Check that Playwright is installed and restart the UI server, then try running the test again.",
            screenshotUrl: "",
            reportUrl: runState.reportUrl || ""
        };
    } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
    }
}

async function runManualPipeline({ scenarioText, scenarioTexts, cleanupFirst, inputDataOptions, scenarioDrafts }) {
    if (runState.running) {
        throw new Error("Agent is already running.");
    }

    const preservedScenarioDrafts = normalizeScenarioDrafts(scenarioDrafts?.length ? scenarioDrafts : runState.scenarioDrafts);
    const preservedDiscoveryInsight = runState.discoveryInsight || "";

    runState = {
        running: true,
        status: "running",
        scenarioStatuses: [],
        scenarioDrafts: preservedScenarioDrafts,
        discoveryInsight: preservedDiscoveryInsight,
        generatedTests: listGeneratedTests(),
        aiProviderStatus: readAiProviderStatus(),
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null
    };
    savePersistentUiState();

    try {
        fs.mkdirSync(generatedDir, { recursive: true });
        fs.mkdirSync(path.dirname(testsScenarioPath), { recursive: true });

        const selectedScenarios = Array.isArray(scenarioTexts)
            ? scenarioTexts.map(text => String(text || "").trim()).filter(Boolean).slice(0, 10)
            : [String(scenarioText || "").trim()].filter(Boolean);

        if (selectedScenarios.length === 0) {
            throw new Error("At least one scenario is required.");
        }

        if (!runState.scenarioDrafts.length) {
            runState.scenarioDrafts = normalizeScenarioDrafts(selectedScenarios.map((text, index) => ({
                id: `scenario-${index + 1}`,
                title: scenarioSubject(text, `Scenario ${index + 1}`),
                category: "SCENARIO",
                selected: true,
                open: index === 0,
                text
            })));
            savePersistentUiState();
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
                savePersistentUiState();
                if (pipelineCode !== 0) break;
            }

            await runCommand(process.execPath, ["7_reporter.mjs"], `${scenarioLabel}: Final report`);
            runState.generatedTests = listGeneratedTests();
            savePersistentUiState();

            if (pipelineCode === 0) {
                runState.scenarioStatuses[i].status = "passed";
                runState.scenarioStatuses[i].finishedAt = new Date().toISOString();
                runState.scenarioStatuses[i].exitCode = 0;
                await runCommand(process.execPath, ["cleanup_generated.mjs"], `${scenarioLabel}: Post-success cleanup`);
                runState.generatedTests = listGeneratedTests();
                savePersistentUiState();
            } else {
                finalCode = pipelineCode;
                runState.scenarioStatuses[i].status = didExhaustHealingRetries() ? "needs_attention" : "failed";
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

function pageHtml(initialScenario, initialUiState = {}) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QA Agent Review Console</title>
  <style>
    :root { color-scheme: light; --ink:#202124; --muted:#5f6368; --line:#d8dde6; --panel:#ffffff; --accent:#0b57d0; --ok:#147a3c; --warn:#b06000; --bg:#f5f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 system-ui, Segoe UI, Arial, sans-serif; color: var(--ink); background: var(--bg); }
    header { background: #102033; color: white; padding: 20px 28px; }
    header h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    header p { margin: 4px 0 0; color: #c9d7e8; }
    main { width: 100%; max-width: none; margin: 0; padding: 22px; display: block; }
    main > section { width: 100%; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    label { display: block; font-weight: 600; margin: 12px 0 6px; }
    textarea, input[type="url"], input[type="number"], select { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 10px; font: 13px/1.4 Consolas, monospace; resize: vertical; background: white; }
    textarea { min-height: 230px; }
    input[type="url"], input[type="number"], select { font-family: inherit; }
    input[type="number"], select { max-width: 120px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .row label { margin: 0; font-weight: 500; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; font-weight: 650; cursor: pointer; background: var(--accent); color: white; }
    button.secondary { background: #e8eef8; color: #123; }
    button.danger { background: #fce8e6; color: #9b1c14; }
    button:disabled { opacity: .55; cursor: wait; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .review-modal { border: 1px solid #b7c9ef; border-radius: 8px; background: #f7faff; padding: 14px; box-shadow: inset 4px 0 0 #0b57d0; }
    .review-modal h2 { margin: 0 0 10px; }
    .process-progress { border: 1px solid #c8d7f4; border-radius: 8px; background: #fff; padding: 12px; margin-top: 12px; display: grid; gap: 8px; }
    .progress-topline { display: flex; justify-content: space-between; gap: 10px; align-items: center; font-size: 12px; color: #27415f; }
    .progress-title { font-weight: 700; color: var(--ink); }
    .progress-track { height: 10px; background: #e8eef8; border-radius: 999px; overflow: hidden; }
    .progress-bar { width: 0%; height: 100%; background: #0b57d0; border-radius: 999px; transition: width .35s ease; }
    .progress-caption { font-size: 12px; color: var(--muted); }
    .review-flow { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 18px; margin: 0; }
    .flow-step { position: relative; border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 10px; color: #27415f; font-size: 12px; min-height: 72px; }
    .flow-step:not(:last-child)::after { content: "→"; position: absolute; right: -16px; top: 50%; transform: translateY(-50%); color: #0b57d0; font-weight: 800; font-size: 18px; }
    .flow-step strong { display: block; color: var(--ink); font-size: 13px; margin-bottom: 2px; }
    .review-modal-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 10px; }
    .review-modal-head h2 { margin: 0; }
    .flow-step { text-align: left; font-weight: 500; }
    .flow-step:hover { border-color: #9bb7e4; background: #f8fafd; }
    .review-flow .flow-step:not(:last-child)::after { content: "->"; right: -17px; font-size: 15px; }
    .walkthrough-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(16, 32, 51, .45); display: none; align-items: center; justify-content: center; padding: 18px; }
    .walkthrough-backdrop.visible { display: flex; }
    .walkthrough-dialog { width: min(720px, 100%); max-height: calc(100vh - 36px); overflow-y: auto; overflow-x: hidden; background: #fff; border-radius: 8px; box-shadow: 0 22px 70px rgba(16, 32, 51, .36); border: 1px solid var(--line); }
    .walkthrough-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 16px 18px; background: #102033; color: #fff; }
    .walkthrough-header h2 { margin: 0; font-size: 16px; }
    .walkthrough-header button { background: #e8eef8; color: #123; padding: 7px 10px; }
    .walkthrough-body { padding: 18px; display: grid; gap: 12px; }
    .walkthrough-step-label { color: #5f6368; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .walkthrough-title { margin: 0; font-size: 20px; }
    .walkthrough-mini-progress { color: #27415f; font-size: 12px; font-weight: 700; }
    .walkthrough-card { border: 1px solid var(--line); border-radius: 8px; background: #fbfcff; padding: 12px; }
    .walkthrough-card, .walkthrough-body, .wizard-list, .wizard-row { min-width: 0; max-width: 100%; }
    .walkthrough-card strong { display: block; margin-bottom: 5px; }
    .url-preview { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
    .walkthrough-card textarea { min-height: 150px; }
    .activity-feed { display: grid; gap: 8px; margin-top: 8px; }
    .activity-step { display: flex; align-items: center; gap: 8px; color: #5f6368; font-size: 13px; }
    .activity-dot { width: 9px; height: 9px; border-radius: 99px; background: #c5cbd3; flex: 0 0 auto; }
    .activity-step.active { color: #8a4b00; font-weight: 650; }
    .activity-step.active .activity-dot { background: var(--warn); animation: pulse 1s infinite; }
    .activity-step.done { color: #137333; }
    .activity-step.done .activity-dot { background: var(--ok); }
    .activity-step.failed { color: #a50e0e; font-weight: 650; }
    .activity-step.failed .activity-dot { background: #c5221f; }
    .wizard-list { display: grid; gap: 10px; max-height: 340px; overflow: auto; padding-right: 4px; }
    .wizard-row { border: 1px solid var(--line); border-radius: 8px; background: #fbfcff; padding: 12px; display: grid; gap: 8px; }
    .wizard-row-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
    .wizard-scenario-details { border: 1px solid var(--line); border-radius: 8px; background: #fff; overflow: hidden; }
    .wizard-scenario-details summary { background: #fbfcff; }
    .wizard-scenario-body { padding: 12px; display: grid; gap: 10px; }
    .summary-remove { padding: 5px 8px; font-size: 11px; }
    .walkthrough-actions { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 0 18px 18px; }
    .section-heading { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 6px 0 2px; }
    .section-heading h3 { margin: 0; font-size: 15px; }
    .toolbar { justify-content: space-between; margin-top: 8px; }
    .scenario-list { display: grid; gap: 10px; }
    .test-list { display: grid; gap: 8px; max-height: 220px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fbfcff; }
    .test-row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 8px; border-radius: 6px; background: #fff; border: 1px solid #edf1f7; }
    .test-name { font-family: Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .failure-summary { display: none; border: 1px solid #f4b4ae; border-radius: 8px; background: #fff7f6; padding: 14px; margin-top: 12px; }
    .failure-summary.visible { display: grid; gap: 10px; }
    .failure-summary h3 { margin: 0; font-size: 15px; color: #a50e0e; }
    .failure-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .failure-item { border: 1px solid #f8d0cc; border-radius: 6px; background: #fff; padding: 10px; }
    .failure-item strong { display: block; font-size: 12px; color: #5f6368; margin-bottom: 4px; }
    .failure-summary pre { height: auto; max-height: 160px; margin: 0; background: #2b1618; }
    .failure-summary img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; }
    .run-summary { display: none; border: 1px solid #b7c9ef; border-radius: 8px; background: #f7faff; padding: 14px; margin-top: 12px; }
    .run-summary.visible { display: grid; gap: 10px; }
    .run-summary h3 { margin: 0; font-size: 15px; color: #174ea6; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
    .summary-item { border: 1px solid #d6e2fb; border-radius: 6px; background: #fff; padding: 10px; }
    .summary-item strong { display: block; font-size: 12px; color: #5f6368; margin-bottom: 4px; }
    .summary-number { font-size: 22px; font-weight: 700; color: #174ea6; }
    .input-data-panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcff; display: grid; gap: 10px; }
    .input-data-grid { display: grid; gap: 8px; }
    .input-data-row { display: grid; grid-template-columns: minmax(120px, .45fr) minmax(180px, 1fr); gap: 10px; align-items: center; }
    .input-data-row span { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .insight-frame { border: 1px solid var(--line); border-radius: 8px; background: #fbfcff; padding: 10px 12px; margin: 10px 0 12px; color: #3c4960; }
    .insight-frame:empty { display: none; }
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
    .scenario-status.failed, .scenario-status.needs_attention { background: #fce8e6; color: #a50e0e; border-color: #f4b4ae; }
    .scenario-status.ready { background: #e8eef8; color: #174ea6; border-color: #b7c9ef; }
    .scenario-status.completed { background: #e8eef8; color: #174ea6; border-color: #b7c9ef; }
    .agent-work-status { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; font-size: 12px; color: #27415f; background: #f8fafd; }
    .agent-work-status::before { content: ""; width: 8px; height: 8px; border-radius: 99px; background: var(--muted); }
    .agent-work-status.working::before { background: var(--warn); animation: pulse 1s infinite; }
    .agent-work-status.ready::before { background: var(--ok); }
    .agent-work-status.failed::before { background: #c5221f; }
    .scenario-body { padding: 12px; display: grid; gap: 10px; }
    .empty-state { border: 1px dashed var(--line); border-radius: 8px; padding: 16px; color: var(--muted); background: #fbfcff; }
    .status { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; background: #fff; color: #202124; }
    .dot { width: 9px; height: 9px; border-radius: 99px; background: var(--muted); }
    .status.running .dot { background: var(--warn); animation: pulse 1s infinite; }
    .status.passed .dot { background: var(--ok); }
    .status.failed .dot { background: #c5221f; }
    @keyframes pulse { 50% { opacity: .35; } }
    .review-drawer-toggle { position: fixed; right: 18px; bottom: 18px; z-index: 51; box-shadow: 0 12px 34px rgba(16, 32, 51, .24); }
    .review-side-drawer { position: fixed; top: 0; right: 0; z-index: 60; width: min(760px, calc(100vw - 28px)); height: 100vh; background: #f5f7fb; border-left: 1px solid var(--line); box-shadow: -18px 0 44px rgba(16, 32, 51, .24); transform: translateX(100%); transition: transform .22s ease; display: grid; grid-template-rows: auto 1fr; padding: 0; }
    .review-side-drawer.open { transform: translateX(0); }
    .drawer-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; background: #102033; color: #fff; }
    .drawer-header h2 { margin: 0; font-size: 15px; }
    .drawer-header button { background: #e8eef8; color: #123; padding: 7px 10px; }
    .drawer-body { overflow: auto; padding: 14px; display: grid; gap: 14px; align-content: start; }
    .drawer-panel { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 0; overflow: hidden; box-shadow: 0 10px 28px rgba(16, 32, 51, .10); }
    .console-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; background: #102033; color: #fff; }
    .console-header h2 { margin: 0; font-size: 14px; }
    .console-actions { display: flex; align-items: center; gap: 8px; }
    .console-actions button { padding: 7px 9px; background: #e8eef8; color: #123; }
    .preview-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; background: #1f3a2e; color: #fff; }
    .preview-header h2 { margin: 0; font-size: 14px; }
    .preview-body { padding: 12px; background: var(--panel); display: grid; gap: 10px; }
    .preview-meta { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
    .preview-title { font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
    .preview-frame { border: 1px solid var(--line); border-radius: 8px; background: #f8fafd; min-height: 180px; display: grid; place-items: center; overflow: hidden; }
    .preview-frame img { width: 100%; height: auto; display: block; }
    .console-body { padding: 12px; background: var(--panel); }
    pre { width: 100%; height: min(360px, 38vh); overflow: auto; margin: 10px 0 0; background: #101820; color: #e7edf3; border-radius: 8px; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.35; }
    .split { display: grid; gap: 14px; }
    .type-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; }
    .type-grid label { display: flex; align-items: center; gap: 7px; margin: 0; font-weight: 500; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: #fbfcff; }
    @media (max-width: 900px) {
      .review-flow { grid-template-columns: 1fr; gap: 8px; }
      .flow-step:not(:last-child)::after { content: "↓"; right: 14px; top: auto; bottom: -16px; transform: none; }
      .review-flow .flow-step:not(:last-child)::after { content: "v"; right: 14px; top: auto; bottom: -16px; transform: none; }
      .review-drawer-toggle { right: 10px; bottom: 10px; }
      .review-side-drawer { width: 100vw; }
    }
  </style>
</head>
<body>
  <header>
    <h1>QA Agent Review Console</h1>
    <p>Private review demo</p>
  </header>
  <main>
    <section>
      <div class="split">
        <div class="review-modal">
          <div class="review-modal-head">
            <h2>Review Steps</h2>
            <button class="secondary" id="openWalkthroughBtn" type="button">Open Walkthrough</button>
          </div>
          <div class="review-flow" aria-label="Review flow">
            <button class="flow-step" type="button" data-walkthrough-step="0"><strong>1. Create scenarios</strong>Choose a count and create drafts.</button>
            <button class="flow-step" type="button" data-walkthrough-step="1"><strong>2. Select, edit, or remove scenarios</strong>Edit or remove drafts.</button>
            <button class="flow-step" type="button" data-walkthrough-step="2"><strong>3. Generate tests</strong>Create Playwright artifacts.</button>
            <button class="flow-step" type="button" data-walkthrough-step="3"><strong>4. Run tests</strong>Choose generated tests to execute.</button>
            <button class="flow-step" type="button" data-walkthrough-step="4"><strong>5. Review results</strong>Open report or failure summary.</button>
          </div>
        </div>
        <div>
          <div class="section-heading"><h3>A. Site Discovery</h3></div>
          <label for="siteUrl">Review a Site URL</label>
          <div class="row">
            <input id="siteUrl" type="url" placeholder="https://example.com">
          </div>
          <div class="row" style="margin-top: 10px;">
            <input id="startClean" type="checkbox">
            <label for="startClean">Start Clean? Clear previous scenarios and generated tests before this review</label>
          </div>
          <div class="row" style="margin-top: 10px;">
            <button class="secondary" id="discoverBtn" type="button">Start Review</button>
          </div>
          <div class="hint">Start the guided review to choose scenario count, create drafts, generate tests, run them, and review results.</div>
        </div>
        <div>
          <div class="section-heading"><h3>B. Coverage Types</h3><span class="hint">Choose what the agent should look for.</span></div>
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
            <div class="section-heading"><h3>C. Review scenario drafts</h3><span class="hint" id="scenarioMeta">0 selected</span></div>
            <div class="row">
              <span class="agent-work-status" id="agentWorkStatus">Ready</span>
            </div>
          </div>
          <div class="insight-frame" id="siteInsight"></div>
          <div id="scenarioList" class="scenario-list"></div>
        </div>
        <input id="cleanup" type="hidden" checked value="on">
        <div class="input-data-panel" style="display:none;" aria-hidden="true">
          <div class="section-heading"><h3>D. Test Data Options</h3><span class="hint">Optional controls for detected input fields.</span></div>
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
          <button id="runBtn" type="button">Generate Tests for Selected Scenarios</button>
          <button class="secondary" id="selectAllBtn" type="button">Select All</button>
          <button class="secondary" id="deleteSelectedBtn" type="button">Delete Selected</button>
          <button class="secondary" id="cleanScenarioBtn" type="button">Clean All</button>
        </div>
        <div>
          <div class="row toolbar">
            <label>E. Generated test artifacts</label>
            <span class="hint" id="testMeta">0 tests</span>
          </div>
          <div id="generatedTestList" class="test-list"></div>
          <div class="row" style="margin-top: 10px;">
            <button class="secondary" id="refreshTestsBtn" type="button">Refresh Tests</button>
            <button id="runAllTestsBtn" type="button">Run All Generated Tests</button>
            <button class="secondary" id="runSpecificTestsBtn" type="button">Run Selected Generated Tests</button>
          </div>
          <div class="row" style="margin-top: 10px;">
            <input id="runTestsInParallel" type="checkbox">
            <label for="runTestsInParallel">Run selected generated tests in parallel</label>
          </div>
          <div id="runSummary" class="run-summary"></div>
          <div id="failureSummary" class="failure-summary"></div>
        </div>
      </div>
    </section>
    <div class="walkthrough-backdrop" id="walkthroughModal" role="dialog" aria-modal="true" aria-labelledby="walkthroughHeaderTitle">
      <div class="walkthrough-dialog">
        <div class="walkthrough-header">
          <h2 id="walkthroughHeaderTitle">Create scenarios</h2>
          <button id="closeWalkthroughBtn" type="button">Close</button>
        </div>
        <div class="walkthrough-body">
          <div class="walkthrough-step-label" id="walkthroughStepLabel">Step 1 of 6</div>
          <div class="walkthrough-mini-progress" id="wizardProgressText">Step 1 of 5</div>
          <div id="walkthroughContent"></div>
        </div>
        <div class="walkthrough-actions">
          <button class="secondary" id="prevWalkthroughBtn" type="button">Back</button>
          <button id="nextWalkthroughBtn" type="button">Next</button>
        </div>
      </div>
    </div>
    <button class="review-drawer-toggle" id="toggleReviewDrawerBtn" type="button">Open Live Logs</button>
    <aside class="review-side-drawer" id="reviewSideDrawer" aria-label="Run monitor drawer">
      <div class="drawer-header">
        <h2>Run Monitor</h2>
        <button class="secondary" id="closeReviewDrawerBtn" type="button">Close</button>
      </div>
      <div class="drawer-body">
        <section class="drawer-panel" id="floatingPreview">
          <div class="preview-header">
            <h2>Live Run Preview</h2>
          </div>
          <div class="preview-body">
            <div class="preview-meta">
              <span class="preview-title" id="previewTitle">No active test</span>
              <span id="previewStatus">idle</span>
              <a id="previewReport" href="#" target="_blank" rel="noreferrer" style="display:none;">Open Playwright report</a>
            </div>
            <div class="preview-frame" id="previewFrame">
              <span class="hint">Latest test screenshot will appear here when Playwright creates one.</span>
            </div>
          </div>
        </section>
        <section class="drawer-panel" id="floatingConsole">
          <div class="console-header">
            <h2>Run Logs</h2>
            <div class="console-actions">
              <div id="status" class="status"><span class="dot"></span><span>idle</span></div>
            </div>
          </div>
          <div class="console-body">
            <button class="secondary" id="clearLogsBtn" type="button">Clear Logs</button>
            <pre id="logs"></pre>
          </div>
        </section>
      </div>
    </aside>
  </main>
  <script>
    const initialScenarioText = ${JSON.stringify(initialScenario || "")};
    const initialScenarioDrafts = ${JSON.stringify(normalizeScenarioDrafts(initialUiState.scenarioDrafts))};
    const initialDiscoveryInsight = ${JSON.stringify(initialUiState.discoveryInsight || "")};
    let scenarios = initialScenarioDrafts.length
      ? initialScenarioDrafts
      : initialScenarioText.trim()
      ? [{ id: 'scenario-1', title: readSubject(initialScenarioText) || 'Manual scenario', category: 'MANUAL', selected: true, open: true, text: initialScenarioText }]
      : [];
    let discoveryInsight = initialDiscoveryInsight;
    let lastScenarioStatuses = [];
    let generatedTests = [];
    let selectedGeneratedTests = new Set();
    let lastTestStatuses = [];
    let lastAiProviderStatusText = '';
    let detectedInputFields = [];
    let wizardScenarioCountValue = '5';
    let discoveryActivityTimer = null;
    let discoveryActivityIndex = 0;
    let discoveryInProgress = false;
    let generationActivityTimer = null;
    let generationActivityIndex = 0;
    let generationInProgress = false;
    let generationHasStartedRunning = false;
    let generationActivityState = 'idle';
    let requiredScenarioInputValues = {};
    let wizardDetectedInputValues = {};
    let testRunActivityState = 'idle';
    let agentRunInProgress = false;

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
    const startClean = document.getElementById('startClean');
    const floatingConsole = document.getElementById('floatingConsole');
    const floatingPreview = document.getElementById('floatingPreview');
    const reviewSideDrawer = document.getElementById('reviewSideDrawer');
    const toggleReviewDrawerBtn = document.getElementById('toggleReviewDrawerBtn');
    const closeReviewDrawerBtn = document.getElementById('closeReviewDrawerBtn');
    const previewTitle = document.getElementById('previewTitle');
    const previewStatus = document.getElementById('previewStatus');
    const previewReport = document.getElementById('previewReport');
    const previewFrame = document.getElementById('previewFrame');
    const runSummary = document.getElementById('runSummary');
    const failureSummary = document.getElementById('failureSummary');
    const walkthroughModal = document.getElementById('walkthroughModal');
    const walkthroughHeaderTitle = document.getElementById('walkthroughHeaderTitle');
    const walkthroughStepLabel = document.getElementById('walkthroughStepLabel');
    const walkthroughContent = document.getElementById('walkthroughContent');
    const wizardProgressText = document.getElementById('wizardProgressText');
    const prevWalkthroughBtn = document.getElementById('prevWalkthroughBtn');
    const nextWalkthroughBtn = document.getElementById('nextWalkthroughBtn');
    let lastPreviewScreenshotUrl = '';
    let activeWalkthroughStep = 0;

    const walkthroughSteps = [
      { title: 'Create scenarios' },
      { title: 'Select, edit, or remove scenarios' },
      { title: 'Generate tests' },
      { title: 'Run Tests' },
      { title: 'Review results' }
    ];
    const discoveryActivitySteps = [
      'Opening target URL',
      'Handling cookie/privacy interruptions',
      'Reading page title, headings, links, and forms',
      'Asking AI to understand the site purpose',
      'Drafting review scenarios',
      'Saving scenario drafts'
    ];
    const generationActivitySteps = [
      'Saving selected scenario drafts',
      'Creating Playwright test skeletons',
      'Calling AI for scenario-specific implementation',
      'Running validation and healing attempts',
      'Saving generated test files'
    ];
    const testRunActivitySteps = [
      'Preparing selected generated tests',
      'Starting Playwright execution',
      'Running browser checks',
      'Collecting pass/fail evidence',
      'Preparing review results'
    ];

    function selectedTestTypes() {
      const types = Array.from(document.querySelectorAll('#testTypeGrid input[type="checkbox"]:checked')).map(input => input.value);
      return types.length ? types : ['UI_E2E'];
    }

    function setSelectedTestTypes(types) {
      const selected = new Set(types && types.length ? types : ['UI_E2E']);
      document.querySelectorAll('#testTypeGrid input[type="checkbox"]').forEach(input => {
        input.checked = selected.has(input.value);
      });
    }

    function renderWalkthroughStep() {
      const step = walkthroughSteps[activeWalkthroughStep];
      walkthroughStepLabel.textContent = 'Step ' + (activeWalkthroughStep + 1) + ' of ' + walkthroughSteps.length;
      walkthroughHeaderTitle.textContent = step.title;
      prevWalkthroughBtn.disabled = activeWalkthroughStep === 0;
      nextWalkthroughBtn.textContent = activeWalkthroughStep === 0
        ? 'Review Generated Scenarios'
        : activeWalkthroughStep === 1
        ? 'Generate Tests'
        : activeWalkthroughStep === 2
        ? 'Run Generated Tests'
        : activeWalkthroughStep === 3
        ? 'Review Results'
        : activeWalkthroughStep === walkthroughSteps.length - 1 ? 'Finish' : 'Next';
      updateWizardNavControls();
      renderWizardProgress();
      renderWizardContent();
    }

    function updateWizardNavControls() {
      if (activeWalkthroughStep === 0) {
        nextWalkthroughBtn.disabled = discoveryInProgress || scenarios.length === 0;
        return;
      }
      if (activeWalkthroughStep === 2) {
        nextWalkthroughBtn.disabled = generationInProgress || generatedTests.length === 0;
        return;
      }
      nextWalkthroughBtn.disabled = false;
    }

    function renderWizardProgress() {
      const labels = [
        scenarios.length ? 'Scenarios ready' : 'Create scenario drafts',
        selectedScenarios().length + ' selected of ' + scenarios.length,
        generatedTests.length ? generatedTests.length + ' generated test files' : 'Generate test files',
        lastTestStatuses.length ? 'Test run started' : 'Run tests',
        'Review results'
      ];
      wizardProgressText.textContent = labels[activeWalkthroughStep];
    }

    function renderDiscoveryActivity(state = 'idle') {
      const container = document.getElementById('wizardDiscoveryActivity');
      if (!container) return;
      if (state === 'idle') {
        container.innerHTML = '';
        return;
      }
      const failed = state === 'failed';
      const doneAll = state === 'done';
      container.innerHTML = '<div class="activity-feed">' + discoveryActivitySteps.map((label, index) => {
        let cls = '';
        if (doneAll || index < discoveryActivityIndex) cls = 'done';
        if (!doneAll && !failed && index === discoveryActivityIndex) cls = 'active';
        if (failed && index === discoveryActivityIndex) cls = 'failed';
        return '<div class="activity-step ' + cls + '"><span class="activity-dot"></span><span>' + escapeHtmlClient(label) + '</span></div>';
      }).join('') + '</div>';
    }

    function startDiscoveryActivity() {
      clearInterval(discoveryActivityTimer);
      discoveryActivityIndex = 0;
      renderDiscoveryActivity('running');
      discoveryActivityTimer = setInterval(() => {
        discoveryActivityIndex = Math.min(discoveryActivityIndex + 1, discoveryActivitySteps.length - 1);
        renderDiscoveryActivity('running');
      }, 1800);
    }

    function finishDiscoveryActivity(success) {
      clearInterval(discoveryActivityTimer);
      discoveryActivityIndex = success ? discoveryActivitySteps.length : Math.min(discoveryActivityIndex, discoveryActivitySteps.length - 1);
      renderDiscoveryActivity(success ? 'done' : 'failed');
    }

    function renderGenerationActivity(state = 'idle') {
      const container = document.getElementById('wizardGenerationActivity');
      if (!container) return;
      if (state === 'idle') {
        container.innerHTML = '';
        return;
      }
      const failed = state === 'failed';
      const doneAll = state === 'done';
      container.innerHTML = '<div class="activity-feed">' + generationActivitySteps.map((label, index) => {
        let cls = '';
        if (doneAll || index < generationActivityIndex) cls = 'done';
        if (!doneAll && !failed && index === generationActivityIndex) cls = 'active';
        if (failed && index === generationActivityIndex) cls = 'failed';
        return '<div class="activity-step ' + cls + '"><span class="activity-dot"></span><span>' + escapeHtmlClient(label) + '</span></div>';
      }).join('') + '</div>';
    }

    function startGenerationActivity() {
      clearInterval(generationActivityTimer);
      generationInProgress = true;
      generationHasStartedRunning = false;
      generationActivityState = 'running';
      generationActivityIndex = 0;
      renderGenerationActivity('running');
      generationActivityTimer = setInterval(() => {
        generationActivityIndex = Math.min(generationActivityIndex + 1, generationActivitySteps.length - 1);
        renderGenerationActivity('running');
      }, 2200);
    }

    function finishGenerationActivity(success) {
      clearInterval(generationActivityTimer);
      generationInProgress = false;
      generationHasStartedRunning = false;
      generationActivityState = success ? 'done' : 'failed';
      generationActivityIndex = success ? generationActivitySteps.length : Math.min(generationActivityIndex, generationActivitySteps.length - 1);
      renderGenerationActivity(success ? 'done' : 'failed');
    }

    function testRunStepIndex() {
      if (!lastTestStatuses.length) return 0;
      if (lastTestStatuses.some(item => item.status === 'running')) return 2;
      if (lastTestStatuses.some(item => item.status === 'queued')) return 1;
      return 4;
    }

    function renderTestRunActivity(state = testRunActivityState) {
      const container = document.getElementById('wizardTestRunActivity');
      if (!container) return;
      if (state === 'idle' && !lastTestStatuses.length) {
        container.innerHTML = '';
        return;
      }
      const failed = state === 'failed' || lastTestStatuses.some(item => item.status === 'failed' || item.status === 'needs_attention');
      const doneAll = state === 'done' || (lastTestStatuses.length && lastTestStatuses.every(item => ['passed', 'completed', 'failed', 'needs_attention'].includes(item.status)));
      const activeIndex = testRunStepIndex();
      container.innerHTML = '<div class="activity-feed">' + testRunActivitySteps.map((label, index) => {
        let cls = '';
        if (doneAll || index < activeIndex) cls = 'done';
        if (!doneAll && !failed && index === activeIndex) cls = 'active';
        if (failed && index === activeIndex) cls = 'failed';
        return '<div class="activity-step ' + cls + '"><span class="activity-dot"></span><span>' + escapeHtmlClient(label) + '</span></div>';
      }).join('') + '</div>';
    }

    function startTestRunActivity() {
      testRunActivityState = 'running';
      renderTestRunActivity('running');
    }

    function finishTestRunActivity(success) {
      testRunActivityState = success ? 'done' : 'failed';
      renderTestRunActivity(testRunActivityState);
    }

    function openWalkthrough(index = 0) {
      activeWalkthroughStep = Math.max(0, Math.min(walkthroughSteps.length - 1, Number(index) || 0));
      renderWalkthroughStep();
      walkthroughModal.classList.add('visible');
    }

    function closeWalkthrough() {
      walkthroughModal.classList.remove('visible');
    }

    function renderWizardContent() {
      if (activeWalkthroughStep === 0) {
        const currentCount = wizardScenarioCountValue || '5';
        const rawReviewUrl = document.getElementById('siteUrl').value.trim();
        const reviewUrlLabel = rawReviewUrl ? truncateMiddle(rawReviewUrl, 118) : 'Enter a URL in the main page first';
        walkthroughContent.innerHTML = \`
          <div class="walkthrough-card">
            <strong>1. Choose how many scenarios to create</strong>
            <div class="row">
              <select id="wizardScenarioCount">
                \${[1,2,3,4,5,6,7,8,9,10].map(n => '<option value="' + n + '" ' + (String(n) === String(currentCount) ? 'selected' : '') + '>' + n + ' scenario' + (n > 1 ? 's' : '') + '</option>').join('')}
              </select>
              <button id="wizardCreateScenariosBtn" type="button">Create Scenarios</button>
            </div>
            <div class="hint url-preview" title="\${escapeHtmlClient(rawReviewUrl)}">URL: \${escapeHtmlClient(reviewUrlLabel)}</div>
            <div id="wizardDiscoveryActivity"></div>
          </div>
          <div class="walkthrough-card">
            <strong>Coverage types</strong>
            <div class="type-grid" id="wizardTestTypeGrid">
              \${[
                ['UI_E2E', 'UI E2E'],
                ['BE_API', 'BE API'],
                ['PERFORMANCE', 'Performance'],
                ['SECURITY', 'Security'],
                ['ACCESSIBILITY', 'Accessibility'],
                ['SEO', 'SEO'],
                ['RESPONSIVE', 'Responsive'],
                ['QUALITY', 'Quality']
              ].map(([value, label]) => '<label><input type="checkbox" value="' + value + '" ' + (selectedTestTypes().includes(value) ? 'checked' : '') + '> ' + label + '</label>').join('')}
            </div>
            <div class="hint">The agent will create scenario drafts only for selected coverage types.</div>
          </div>
          <div class="walkthrough-card">
            <strong>Generated scenarios</strong>
            <div id="wizardScenarioPreview" class="wizard-list"></div>
          </div>
        \`;
        document.getElementById('wizardCreateScenariosBtn').onclick = async () => {
          wizardScenarioCountValue = document.getElementById('wizardScenarioCount').value;
          setSelectedTestTypes(Array.from(document.querySelectorAll('#wizardTestTypeGrid input[type="checkbox"]:checked')).map(input => input.value));
          await runScenarioDiscovery();
          renderWizardScenarioPreview(false);
          renderWizardProgress();
        };
        renderWizardScenarioPreview(false);
        return;
      }

      if (activeWalkthroughStep === 1) {
        scenarios.forEach(item => item.open = false);
        walkthroughContent.innerHTML = \`
          <div class="walkthrough-card">
            <div class="hint">Select only the drafts you want to generate. You can edit text directly here.</div>
            <div id="wizardScenarioEditor" class="wizard-list"></div>
          </div>
        \`;
        renderWizardScenarioPreview(true);
        return;
      }

      if (activeWalkthroughStep === 2) {
        const requiredFields = requiredInputFieldsForSelectedScenarios();
        const missingRequiredFields = requiredFields.filter(field => !String(requiredScenarioInputValues[field.key] || '').trim());
        walkthroughContent.innerHTML = \`
          <div class="walkthrough-card">
            <div class="hint">\${selectedScenarios().length} selected scenario(s) will be sent to the agent pipeline.</div>
            \${requiredFields.length ? renderRequiredScenarioInputCard(requiredFields) : ''}
            \${renderWizardTestDataOptionsCard()}
            <button id="wizardGenerateTestsBtn" type="button" \${generationInProgress || missingRequiredFields.length ? 'disabled' : ''}>\${generationInProgress ? 'Generating...' : 'Generate Tests'}</button>
            \${missingRequiredFields.length ? '<div class="hint">Provide the required data above before generating tests.</div>' : ''}
            <div id="wizardGenerationActivity"></div>
          </div>
          <div class="walkthrough-card"><strong>Generated files</strong><div id="wizardGeneratedFiles" class="wizard-list"></div></div>
        \`;
        document.querySelectorAll('[data-required-input-key]').forEach(input => {
          input.oninput = () => {
            requiredScenarioInputValues[input.dataset.requiredInputKey] = input.value;
            updateWizardGenerateButton();
          };
        });
        const wizardCreateDataProviders = document.getElementById('wizardCreateDataProviders');
        if (wizardCreateDataProviders) {
          wizardCreateDataProviders.onchange = () => {
            createDataProviders.checked = wizardCreateDataProviders.checked;
          };
        }
        const wizardUseCustomInputData = document.getElementById('wizardUseCustomInputData');
        if (wizardUseCustomInputData) {
          wizardUseCustomInputData.onchange = () => {
            useCustomInputData.checked = wizardUseCustomInputData.checked;
            renderWizardContent();
          };
        }
        const wizardOptionalDataProviders = document.getElementById('wizardOptionalDataProviders');
        if (wizardOptionalDataProviders) {
          wizardOptionalDataProviders.onchange = () => {
            createDataProviders.checked = wizardOptionalDataProviders.checked;
            renderWizardContent();
          };
        }
        document.querySelectorAll('[data-wizard-input-key]').forEach(input => {
          input.oninput = () => {
            wizardDetectedInputValues[input.dataset.wizardInputKey] = input.value;
          };
        });
        document.getElementById('wizardGenerateTestsBtn').onclick = () => {
          startGenerationActivity();
          runBtn.click();
          renderWalkthroughStep();
          updateWizardNavControls();
        };
        if (generationActivityState !== 'idle') renderGenerationActivity(generationActivityState);
        else if (generatedTests.length) renderGenerationActivity('done');
        renderWizardGeneratedFiles();
        return;
      }

      if (activeWalkthroughStep === 3) {
        walkthroughContent.innerHTML = \`
          <div class="walkthrough-card">
            <div class="hint">Select generated tests, then start the Playwright run.</div>
            <div id="wizardGeneratedTests" class="wizard-list"></div>
            <div class="row" style="margin-top:10px;">
              <input id="wizardParallel" type="checkbox" \${document.getElementById('runTestsInParallel').checked ? 'checked' : ''}>
              <label for="wizardParallel">Run in parallel</label>
            </div>
            <div class="row" style="margin-top:10px;">
              <button id="wizardRunAllBtn" type="button" \${agentRunInProgress ? 'disabled' : ''}>Run All Tests</button>
              <button class="secondary" id="wizardRunSelectedBtn" type="button" \${agentRunInProgress ? 'disabled' : ''}>Run Selected Tests</button>
            </div>
            <div id="wizardTestRunActivity"></div>
          </div>
        \`;
        renderWizardGeneratedTests();
        renderTestRunActivity();
        document.getElementById('wizardParallel').onchange = event => {
          document.getElementById('runTestsInParallel').checked = event.target.checked;
        };
        document.getElementById('wizardRunAllBtn').onclick = () => {
          startTestRunActivity();
          document.getElementById('runAllTestsBtn').click();
        };
        document.getElementById('wizardRunSelectedBtn').onclick = () => {
          startTestRunActivity();
          document.getElementById('runSpecificTestsBtn').click();
        };
        return;
      }

      walkthroughContent.innerHTML = \`
        <div class="walkthrough-card">
          <strong>5. Review results</strong>
          <div id="wizardResults"></div>
        </div>
      \`;
      renderWizardResults();
    }

    function renderWizardScenarioPreview(editable) {
      const container = document.getElementById(editable ? 'wizardScenarioEditor' : 'wizardScenarioPreview');
      if (!container) return;
      if (!scenarios.length) {
        container.innerHTML = '<div class="empty-state">No scenarios created yet.</div>';
        return;
      }
      container.innerHTML = scenarios.map((item, index) => {
        const title = escapeHtmlClient(readSubject(item.text) || item.title || 'Scenario');
        const category = escapeHtmlClient(item.category || 'SCENARIO');
        if (!editable) {
          return \`
            <div class="wizard-row">
              <div class="wizard-row-head">
                <strong>\${index + 1}. \${title}</strong>
                <span class="badge">\${category}</span>
              </div>
              <div class="hint">\${escapeHtmlClient((item.text || '').split('\\n').slice(0, 3).join(' '))}</div>
            </div>
          \`;
        }
        return \`
          <details class="wizard-scenario-details" \${item.open ? 'open' : ''} data-wizard-scenario-details="\${item.id}">
            <summary>
              <input type="checkbox" data-wizard-scenario-select="\${item.id}" \${item.selected ? 'checked' : ''} onclick="event.stopPropagation()">
              <span class="scenario-title">\${index + 1}. \${title}</span>
              <span class="row">
                <span class="badge">\${category}</span>
                <button class="danger summary-remove" type="button" data-wizard-scenario-delete="\${item.id}" onclick="event.preventDefault(); event.stopPropagation()">Remove</button>
              </span>
            </summary>
            <div class="wizard-scenario-body">
              <textarea data-wizard-scenario-text="\${item.id}">\${escapeHtmlClient(item.text)}</textarea>
              <div class="row">
                <span class="hint">Edits are kept in this review and sent directly to test generation.</span>
              </div>
            </div>
          </details>
        \`;
      }).join('');
      container.querySelectorAll('[data-wizard-scenario-select]').forEach(input => {
        input.onchange = () => {
          const item = scenarios.find(s => s.id === input.dataset.wizardScenarioSelect);
          if (item) item.selected = input.checked;
          renderScenarios();
          persistScenarioDrafts();
          renderWizardProgress();
          renderWizardScenarioPreview(true);
        };
      });
      container.querySelectorAll('[data-wizard-scenario-text]').forEach(textarea => {
        textarea.oninput = () => {
          const item = scenarios.find(s => s.id === textarea.dataset.wizardScenarioText);
          if (item) {
            item.text = textarea.value;
            item.title = readSubject(item.text) || item.title;
          }
          renderScenarios();
          persistScenarioDrafts();
        };
      });
      container.querySelectorAll('[data-wizard-scenario-delete]').forEach(button => {
        button.onclick = () => {
          scenarios = scenarios.filter(s => s.id !== button.dataset.wizardScenarioDelete);
          renderScenarios();
          persistScenarioDrafts();
          renderWalkthroughStep();
        };
      });
      container.querySelectorAll('[data-wizard-scenario-details]').forEach(details => {
        details.ontoggle = () => {
          const item = scenarios.find(s => s.id === details.dataset.wizardScenarioDetails);
          if (item) {
            item.open = details.open;
            persistScenarioDrafts();
          }
        };
      });
    }

    function renderWizardGeneratedFiles() {
      const container = document.getElementById('wizardGeneratedFiles');
      if (!container) return;
      container.innerHTML = generatedTests.length
        ? generatedTests.map(test => '<div class="wizard-row"><strong>' + escapeHtmlClient(test.name) + '</strong></div>').join('')
        : '<div class="empty-state">Generated files will appear here after the agent finishes.</div>';
    }

    function renderWizardGeneratedTests() {
      const container = document.getElementById('wizardGeneratedTests');
      if (!container) return;
      container.innerHTML = generatedTests.length
        ? generatedTests.map(test => '<label class="wizard-row"><input type="checkbox" data-wizard-test-select="' + escapeHtmlClient(test.name) + '" ' + (selectedGeneratedTests.has(test.name) ? 'checked' : '') + '> ' + escapeHtmlClient(test.name) + '</label>').join('')
        : '<div class="empty-state">No generated tests found yet.</div>';
      container.querySelectorAll('[data-wizard-test-select]').forEach(input => {
        input.onchange = () => {
          if (input.checked) selectedGeneratedTests.add(input.dataset.wizardTestSelect);
          else selectedGeneratedTests.delete(input.dataset.wizardTestSelect);
          renderGeneratedTests();
        };
      });
    }

    function renderWizardResults() {
      const container = document.getElementById('wizardResults');
      if (!container) return;
      const passed = lastTestStatuses.filter(item => item.status === 'passed').length;
      const failed = lastTestStatuses.filter(item => item.status === 'failed' || item.status === 'needs_attention').length;
      const coverage = scenarios.reduce((acc, item) => {
        const key = item.category || 'SCENARIO';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const coverageText = Object.keys(coverage).length
        ? Object.entries(coverage).map(([key, value]) => key + ': ' + value).join(', ')
        : 'No scenario coverage yet';
      container.innerHTML = \`
        <div class="summary-grid">
          <div class="summary-item"><strong>Generated files</strong><span class="summary-number">\${generatedTests.length}</span></div>
          <div class="summary-item"><strong>Passed</strong><span class="summary-number">\${passed}</span></div>
          <div class="summary-item"><strong>Needs attention</strong><span class="summary-number">\${failed}</span></div>
          <div class="summary-item"><strong>Coverage</strong>\${escapeHtmlClient(coverageText)}</div>
          <div class="summary-item"><strong>Report</strong>\${previewReport.href && previewReport.style.display !== 'none' ? '<a href="' + previewReport.href + '" target="_blank" rel="noreferrer">Open report</a>' : '<span class="hint">Run tests to create a report.</span>'}</div>
        </div>
        <div class="hint">Detailed results and any friendly failure summary are also shown on the main page.</div>
      \`;
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

    function truncateMiddle(value, maxLength = 118) {
      const text = String(value || '');
      if (text.length <= maxLength) return text;
      const keep = Math.max(20, maxLength - 3);
      const headLength = Math.ceil(keep * 0.62);
      const tailLength = Math.floor(keep * 0.38);
      return text.slice(0, headLength) + '...' + text.slice(-tailLength);
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

    function sanitizeInputKeyClient(value, fallback = 'input') {
      const key = String(value || fallback)
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || fallback;
      return /^[a-zA-Z_$]/.test(key) ? key : 'input_' + key;
    }

    function requiredInputFieldsForSelectedScenarios() {
      const rules = [
        { key: 'booking_reference', label: 'Booking reference / booking number', placeholder: 'Real booking reference', pattern: /booking\s*(reference|number|code)|reservation\s*(number|code)|pnr/i },
        { key: 'last_name', label: 'Last name', placeholder: 'Passenger last name', pattern: /last\s*name|surname|family\s*name/i },
        { key: 'email', label: 'Email', placeholder: 'user@example.com', pattern: /email|e-mail/i },
        { key: 'phone', label: 'Phone number', placeholder: 'Phone number', pattern: /phone|mobile|telephone/i },
        { key: 'passport_number', label: 'Passport number', placeholder: 'Passport number', pattern: /passport/i },
        { key: 'id_number', label: 'ID number', placeholder: 'ID number', pattern: /\bid\b|identity|national\s*id/i },
        { key: 'flight_number', label: 'Flight number', placeholder: 'Flight number', pattern: /flight\s*(number|code)/i },
        { key: 'order_number', label: 'Order / confirmation number', placeholder: 'Order or confirmation number', pattern: /order\s*(number|id)|confirmation\s*(number|code)/i },
        { key: 'username', label: 'Username', placeholder: 'Username', pattern: /username|user\s*name/i },
        { key: 'password', label: 'Password', placeholder: 'Password', pattern: /password/i }
      ];
      const selectedText = selectedScenarios().map(item => item.text).join('\\n');
      const realDataFlow = /valid\s+(booking|reservation|check-?in|passenger|account|payment|order)|real\s+(booking|account|payment|user|passenger)|cannot\s+use\s+mock|no\s+mock/i.test(selectedText);
      const fields = rules
        .filter(rule => rule.pattern.test(selectedText))
        .map(rule => ({ ...rule, key: sanitizeInputKeyClient(rule.key), required: realDataFlow || /booking|last\s*name|passport|password|payment/i.test(rule.label) }));
      const unique = [];
      const seen = new Set();
      for (const field of fields) {
        if (seen.has(field.key)) continue;
        seen.add(field.key);
        unique.push(field);
      }
      return unique;
    }

    function renderRequiredScenarioInputCard(fields) {
      return \`
        <div class="input-data-panel" style="margin: 10px 0;">
          <strong>Real test data required</strong>
          <div class="hint">The selected scenario needs data the agent should not guess. Enter safe review data that can be used for this test run.</div>
          <div class="input-data-grid">
            \${fields.map(field => \`
              <label class="input-data-row">
                <span>\${escapeHtmlClient(field.label)}</span>
                <input data-required-input-key="\${escapeHtmlClient(field.key)}" type="text" value="\${escapeHtmlClient(requiredScenarioInputValues[field.key] || '')}" placeholder="\${escapeHtmlClient(field.placeholder)}">
              </label>
            \`).join('')}
          </div>
          <label class="row" style="margin-top: 6px;">
            <input id="wizardCreateDataProviders" type="checkbox" \${createDataProviders.checked ? 'checked' : ''}>
            Create 5 data-provider cases from these values
          </label>
        </div>
      \`;
    }

    function renderWizardTestDataOptionsCard() {
      const fieldRows = detectedInputFields.length
        ? detectedInputFields.map(field => \`
          <label class="input-data-row">
            <span>\${escapeHtmlClient(field.label)}</span>
            <input data-wizard-input-key="\${escapeHtmlClient(field.key)}" type="text" value="\${escapeHtmlClient(wizardDetectedInputValues[field.key] || '')}" placeholder="\${escapeHtmlClient(field.placeholder || 'Value to use in test')}">
          </label>
        \`).join('')
        : '<div class="empty-state">No usable input fields were detected for this page. The agent will use safe fallback data only if needed.</div>';

      return \`
        <div class="input-data-panel" style="margin: 10px 0;">
          <strong>Test data options</strong>
          <div class="hint">Optional controls for detected input fields.</div>
          <label class="row">
            <input id="wizardUseCustomInputData" type="checkbox" \${useCustomInputData.checked ? 'checked' : ''}>
            Ask me for input field data when fields are detected
          </label>
          <label class="row">
            <input id="wizardOptionalDataProviders" type="checkbox" \${createDataProviders.checked ? 'checked' : ''} \${!useCustomInputData.checked && !requiredInputFieldsForSelectedScenarios().length ? 'disabled' : ''}>
            Create data providers for each input field
          </label>
          <div class="input-data-grid" style="\${useCustomInputData.checked ? '' : 'display:none;'}">\${fieldRows}</div>
          <div class="hint">When enabled, generated tests use your values. With data providers enabled, the test creates at least 5 data cases based on each value.</div>
        </div>
      \`;
    }

    function updateWizardGenerateButton() {
      const button = document.getElementById('wizardGenerateTestsBtn');
      if (!button) return;
      const missingRequiredFields = requiredInputFieldsForSelectedScenarios()
        .filter(field => !String(requiredScenarioInputValues[field.key] || '').trim());
      button.disabled = generationInProgress || missingRequiredFields.length > 0;
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
        for (const [key, value] of Object.entries(wizardDetectedInputValues)) {
          if (String(value || '').trim()) fields[key] = value;
        }
      }
      for (const [key, value] of Object.entries(requiredScenarioInputValues)) {
        if (String(value || '').trim()) fields[key] = value;
      }
      const hasRequiredScenarioData = Object.keys(requiredScenarioInputValues)
        .some(key => String(requiredScenarioInputValues[key] || '').trim());
      return {
        enabled: useCustomInputData.checked || hasRequiredScenarioData,
        createDataProviders: (useCustomInputData.checked || hasRequiredScenarioData) && createDataProviders.checked,
        fields
      };
    }

    let persistDraftTimer = null;
    function persistScenarioDrafts() {
      clearTimeout(persistDraftTimer);
      persistDraftTimer = setTimeout(() => {
        fetch('/api/scenario-drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioDrafts: scenarios, discoveryInsight })
        }).catch(() => {});
      }, 300);
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
      if (live.status === 'failed' || live.status === 'needs_attention') return { label: 'Needs attention', kind: 'needs_attention' };
      return { label: 'Queued', kind: 'queued' };
    }

    function displayTestStatus(test, index) {
      const live = lastTestStatuses.find(item => item.name === test.name) || lastTestStatuses[index];
      if (!live) return { label: 'Ready', kind: 'ready' };
      if (live.status === 'queued') return { label: 'Queued', kind: 'queued' };
      if (live.status === 'running') return { label: 'Working...', kind: 'running' };
      if (live.status === 'passed') return { label: 'Passed', kind: 'passed' };
      if (live.status === 'failed' || live.status === 'needs_attention') return { label: 'Needs attention', kind: 'needs_attention' };
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

    function renderFailureSummary(summary) {
      if (!summary) {
        failureSummary.className = 'failure-summary';
        failureSummary.innerHTML = '';
        return;
      }

      const screenshot = summary.screenshotUrl
        ? '<div class="failure-item"><strong>Screenshot</strong><img alt="Failure screenshot" src="' + summary.screenshotUrl + '"></div>'
        : '';
      const report = summary.reportUrl
        ? '<a href="' + location.origin + summary.reportUrl + '" target="_blank" rel="noreferrer">Open Playwright report</a>'
        : '';

      failureSummary.className = 'failure-summary visible';
      failureSummary.innerHTML = \`
        <h3>\${escapeHtmlClient(summary.title || 'Test failed')}</h3>
        <div class="failure-grid">
          <div class="failure-item"><strong>Which test failed</strong>\${escapeHtmlClient(summary.failedTest || 'Unknown test')}</div>
          <div class="failure-item"><strong>Where it failed</strong>\${escapeHtmlClient(summary.failedStep || 'Unknown step')}</div>
          <div class="failure-item"><strong>File and line</strong>\${escapeHtmlClient(summary.location || 'Not detected')}</div>
          <div class="failure-item"><strong>Plain-English reason</strong>\${escapeHtmlClient(summary.plainReason || '')}</div>
          <div class="failure-item"><strong>Suggested next action</strong>\${escapeHtmlClient(summary.nextAction || '')}<br>\${report}</div>
          \${screenshot}
        </div>
        <div class="failure-item">
          <strong>Technical error</strong>
          <pre>\${escapeHtmlClient(summary.technicalError || '')}</pre>
        </div>
      \`;
    }

    function renderRunSummary(state) {
      const scenarioStatuses = Array.isArray(state.scenarioStatuses) ? state.scenarioStatuses : [];
      const testStatuses = Array.isArray(state.testStatuses) ? state.testStatuses : [];
      const generatedCount = Array.isArray(state.generatedTests) ? state.generatedTests.length : generatedTests.length;
      const passed = testStatuses.filter(item => item.status === 'passed').length + scenarioStatuses.filter(item => item.status === 'passed').length;
      const failed = testStatuses.filter(item => item.status === 'failed' || item.status === 'needs_attention').length
        + scenarioStatuses.filter(item => item.status === 'failed' || item.status === 'needs_attention').length;
      const running = testStatuses.filter(item => item.status === 'running').length + scenarioStatuses.filter(item => item.status === 'running').length;
      const coverage = scenarios.reduce((acc, item) => {
        const key = item.category || 'SCENARIO';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const coverageText = Object.keys(coverage).length
        ? Object.entries(coverage).map(([key, value]) => key + ': ' + value).join(', ')
        : 'No scenario coverage yet';

      if (!state.running && !state.reportUrl && !scenarioStatuses.length && !testStatuses.length) {
        runSummary.className = 'run-summary';
        runSummary.innerHTML = '';
        return;
      }

      const report = state.reportUrl
        ? '<a href="' + location.origin + state.reportUrl + '" target="_blank" rel="noreferrer">Open HTML Report</a>'
        : '<span class="hint">Report appears after a generated test run completes.</span>';

      runSummary.className = 'run-summary visible';
      runSummary.innerHTML = \`
        <h3>Review run summary</h3>
        <div class="summary-grid">
          <div class="summary-item"><strong>Generated test files</strong><span class="summary-number">\${generatedCount}</span></div>
          <div class="summary-item"><strong>Passed</strong><span class="summary-number">\${passed}</span></div>
          <div class="summary-item"><strong>Needs attention</strong><span class="summary-number">\${failed}</span></div>
          <div class="summary-item"><strong>Currently running</strong><span class="summary-number">\${running}</span></div>
          <div class="summary-item"><strong>Scenario coverage</strong>\${escapeHtmlClient(coverageText)}</div>
          <div class="summary-item"><strong>Report</strong>\${report}</div>
        </div>
      \`;
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
        scenarioList.innerHTML = '<div class="empty-state">No scenarios yet. Enter a URL and click Start Review, or reload scenario.txt.</div>';
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
          persistScenarioDrafts();
          renderScenarios();
        });
      });

      scenarioList.querySelectorAll('[data-scenario-text]').forEach(textarea => {
        textarea.addEventListener('input', () => {
          syncScenarioFromTextarea(textarea.dataset.scenarioText);
          scenarioMeta.textContent = selectedScenarios().length + ' selected of ' + scenarios.length;
          persistScenarioDrafts();
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
          persistScenarioDrafts();
          renderScenarios();
        });
      });

      scenarioList.querySelectorAll('details.scenario-card').forEach(details => {
        details.addEventListener('toggle', () => {
          const item = scenarios.find(s => s.id === details.dataset.scenarioId);
          if (item) item.open = details.open;
          persistScenarioDrafts();
        });
      });
    }

    function setStatus(state) {
      const previousStatuses = JSON.stringify(lastScenarioStatuses || []);
      const previousTestStatuses = JSON.stringify(lastTestStatuses || []);
      const previousGeneratedTests = JSON.stringify(generatedTests.map(test => test.name));
      if (!scenarios.length && Array.isArray(state.scenarioDrafts) && state.scenarioDrafts.length) {
        scenarios = state.scenarioDrafts;
        discoveryInsight = state.discoveryInsight || discoveryInsight;
        renderScenarios();
      }
      lastScenarioStatuses = Array.isArray(state.scenarioStatuses) ? state.scenarioStatuses : [];
      lastTestStatuses = Array.isArray(state.testStatuses) ? state.testStatuses : [];
      agentRunInProgress = !!state.running;
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
        setAgentWorkStatus('Needs attention', 'failed');
      } else if (scenarios.length) {
        setAgentWorkStatus('Scenarios Ready', 'ready');
      } else {
        setAgentWorkStatus('Ready', 'idle');
      }
      runBtn.disabled = !!state.running;
      discoverBtn.disabled = !!state.running;
      startClean.disabled = !!state.running;
      document.getElementById('runAllTestsBtn').disabled = !!state.running;
      document.getElementById('runSpecificTestsBtn').disabled = !!state.running;
      document.getElementById('refreshTestsBtn').disabled = !!state.running;
      document.getElementById('runTestsInParallel').disabled = !!state.running;
      logs.textContent = cleanLogText((state.logs || []).join(''));
      if (state.reportUrl) {
        logs.textContent += '\\nReport: ' + location.origin + state.reportUrl + '\\n';
      }
      updatePreview(state.preview || {});
      renderRunSummary(state);
      renderFailureSummary(state.failureSummary || null);
      if (generationInProgress && state.running) {
        generationHasStartedRunning = true;
      }
      if (generationInProgress && generationHasStartedRunning && !state.running && (state.status === 'passed' || state.status === 'failed')) {
        finishGenerationActivity(state.status === 'passed' || generatedTests.length > 0);
      }
      if (lastTestStatuses.length) {
        if (state.running) {
          testRunActivityState = 'running';
        } else if (state.status === 'passed' || state.status === 'failed') {
          finishTestRunActivity(state.status === 'passed');
        }
      }
      updateWizardNavControls();
      if (walkthroughModal.classList.contains('visible') && activeWalkthroughStep === 3) {
        renderTestRunActivity();
        renderWizardProgress();
      }
      if (walkthroughModal.classList.contains('visible') && activeWalkthroughStep === 4) {
        renderWizardResults();
        renderWizardProgress();
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
        if (walkthroughModal.classList.contains('visible') && activeWalkthroughStep === 2) {
          renderWizardGeneratedFiles();
          renderWizardProgress();
        }
        if (walkthroughModal.classList.contains('visible') && activeWalkthroughStep === 3) {
          renderWizardGeneratedTests();
          renderTestRunActivity();
          renderWizardProgress();
        }
      }
    }

    async function refresh() {
      const res = await fetch('/api/status');
      setStatus(await res.json());
      if (walkthroughModal.classList.contains('visible')) {
        renderWizardProgress();
        if (activeWalkthroughStep === 2) {
          renderGenerationActivity(generationActivityState);
          renderWizardGeneratedFiles();
          updateWizardNavControls();
        } else if (![0, 1].includes(activeWalkthroughStep)) {
          renderWizardContent();
        }
      }
    }

    async function startCleanReviewIfNeeded() {
      if (!startClean.checked) return true;
      const confirmed = confirm('Start clean? This will delete previous scenario drafts, scenario.txt, and generated test files.');
      if (!confirmed) return false;
      const res = await fetch('/api/review-artifacts', { method: 'DELETE' });
      if (!res.ok) {
        alert((await res.json()).error || 'Failed to clean previous review artifacts');
        return false;
      }
      scenarios = [];
      discoveryInsight = '';
      lastScenarioStatuses = [];
      lastTestStatuses = [];
      generatedTests = [];
      requiredScenarioInputValues = {};
      wizardDetectedInputValues = {};
      testRunActivityState = 'idle';
      generationInProgress = false;
      generationHasStartedRunning = false;
      generationActivityState = 'idle';
      clearInterval(generationActivityTimer);
      selectedGeneratedTests.clear();
      renderScenarios();
      renderGeneratedTests();
      renderRunSummary({});
      renderFailureSummary(null);
      startClean.checked = false;
      await refresh();
      return true;
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
          scenarioDrafts: scenarios,
          cleanupFirst: document.getElementById('cleanup').checked,
          inputDataOptions: collectInputDataOptions()
        })
      });
      if (!res.ok) {
        if (generationInProgress) finishGenerationActivity(false);
        alert((await res.json()).error || 'Failed to start agent');
      }
      await refresh();
    };

    async function runScenarioDiscovery() {
      const url = document.getElementById('siteUrl').value.trim();
      const count = Math.max(1, Math.min(10, Number(wizardScenarioCountValue || 5)));
      if (!url) return alert('Enter a URL first.');
      discoveryInProgress = true;
      updateWizardNavControls();
      discoverBtn.disabled = true;
      discoverBtn.textContent = 'Discovering...';
      setAgentWorkStatus('Discovering', 'working');
      if (walkthroughModal.classList.contains('visible') && activeWalkthroughStep === 0) startDiscoveryActivity();
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
        persistScenarioDrafts();
        setAgentWorkStatus('Scenarios Ready', 'ready');
        finishDiscoveryActivity(true);
        if (walkthroughModal.classList.contains('visible') && activeWalkthroughStep === 0) {
          renderWizardScenarioPreview(false);
          renderWizardProgress();
        }
      } catch (error) {
        setAgentWorkStatus('Discovery Failed', 'failed');
        finishDiscoveryActivity(false);
        alert(error.message);
      } finally {
        discoveryInProgress = false;
        updateWizardNavControls();
        discoverBtn.disabled = false;
        discoverBtn.textContent = 'Start Review';
      }
    }

    document.getElementById('discoverBtn').onclick = async () => {
      const url = document.getElementById('siteUrl').value.trim();
      if (!url) return alert('Enter a URL first.');
      if (!(await startCleanReviewIfNeeded())) return;
      openWalkthrough(0);
    };

    document.getElementById('selectAllBtn').onclick = () => {
      const allSelected = scenarios.length > 0 && scenarios.every(item => item.selected);
      scenarios.forEach(item => item.selected = !allSelected);
      renderScenarios();
      persistScenarioDrafts();
    };

    document.getElementById('deleteSelectedBtn').onclick = () => {
      const selected = selectedScenarios();
      if (!selected.length) return alert('Select scenarios to delete.');
      if (!confirm('Delete selected scenarios from the UI?')) return;
      scenarios = scenarios.filter(item => !item.selected);
      renderScenarios();
      persistScenarioDrafts();
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

    toggleReviewDrawerBtn.onclick = () => {
      reviewSideDrawer.classList.add('open');
      logs.scrollTop = logs.scrollHeight;
    };

    closeReviewDrawerBtn.onclick = () => {
      reviewSideDrawer.classList.remove('open');
    };

    function updatePreview(preview) {
      previewTitle.textContent = preview.title || 'No active test';
      previewStatus.textContent = preview.status || 'idle';
      if (preview.reportUrl) {
        previewReport.style.display = 'inline';
        previewReport.href = location.origin + preview.reportUrl;
      } else {
        previewReport.style.display = 'none';
      }

      if (preview.screenshotUrl && preview.screenshotUrl !== lastPreviewScreenshotUrl) {
        lastPreviewScreenshotUrl = preview.screenshotUrl;
        previewFrame.innerHTML = '<img alt="Latest Playwright screenshot" src="' + preview.screenshotUrl + '">';
      } else if (!preview.screenshotUrl && !lastPreviewScreenshotUrl) {
        previewFrame.innerHTML = '<span class="hint">Latest test screenshot will appear here when Playwright creates one.</span>';
      }
    }

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
        body: JSON.stringify({
          all: true,
          parallel: document.getElementById('runTestsInParallel').checked
        })
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
        body: JSON.stringify({
          files,
          parallel: document.getElementById('runTestsInParallel').checked
        })
      });
      if (!res.ok) return alert((await res.json()).error || 'Failed to run selected tests');
      await refresh();
    };

    document.getElementById('openWalkthroughBtn').onclick = () => openWalkthrough(0);
    document.getElementById('closeWalkthroughBtn').onclick = closeWalkthrough;
    walkthroughModal.addEventListener('click', event => {
      if (event.target === walkthroughModal) event.stopPropagation();
    });
    document.querySelectorAll('[data-walkthrough-step]').forEach(button => {
      button.addEventListener('click', () => openWalkthrough(button.dataset.walkthroughStep));
    });
    prevWalkthroughBtn.onclick = () => {
      activeWalkthroughStep -= 1;
      renderWalkthroughStep();
    };
    nextWalkthroughBtn.onclick = () => {
      if (activeWalkthroughStep >= walkthroughSteps.length - 1) {
        closeWalkthrough();
        return;
      }
      activeWalkthroughStep += 1;
      renderWalkthroughStep();
    };
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && walkthroughModal.classList.contains('visible')) closeWalkthrough();
    });

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

        if (req.method === "GET" && url.pathname.startsWith("/test-results")) {
            const resultPath = url.pathname.replace(/^\/test-results\/?/, "");
            serveStaticFile(res, testResultsDir, resultPath);
            return;
        }

        if (req.method === "GET" && url.pathname === "/") {
            const initialScenario = fs.existsSync(testsScenarioPath)
                ? fs.readFileSync(testsScenarioPath, "utf8")
                : "";
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(pageHtml(initialScenario, runState));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/status") {
            runState.aiProviderStatus = readAiProviderStatus();
            runState.generatedTests = listGeneratedTests();
            sendJson(res, 200, { ...runState, preview: currentPreviewState() });
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
            runState.scenarioDrafts = normalizeScenarioDrafts([{
                id: "scenario-1",
                title: scenarioSubject(payload.scenarioText, "Manual scenario"),
                category: "MANUAL",
                selected: true,
                open: true,
                text: payload.scenarioText
            }]);
            runState.discoveryInsight = "";
            savePersistentUiState();
            pushLog("Scenario saved to scenario.txt.\n");
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/scenario-drafts") {
            const payload = JSON.parse(await readBody(req) || "{}");
            runState.scenarioDrafts = normalizeScenarioDrafts(payload.scenarioDrafts);
            runState.discoveryInsight = String(payload.discoveryInsight || "");
            savePersistentUiState();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === "DELETE" && url.pathname === "/api/scenario") {
            fs.mkdirSync(path.dirname(testsScenarioPath), { recursive: true });
            fs.writeFileSync(testsScenarioPath, "", "utf8");
            runState.scenarioDrafts = [];
            runState.discoveryInsight = "";
            savePersistentUiState();
            pushLog("Scenario text cleared.\n");
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === "DELETE" && url.pathname === "/api/review-artifacts") {
            if (runState.running) {
                sendJson(res, 409, { error: "Agent is already running." });
                return;
            }
            cleanReviewArtifacts();
            pushLog("Previous scenarios and generated tests cleared.\n");
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
            runState.scenarioDrafts = normalizeScenarioDrafts(result.scenarios);
            runState.discoveryInsight = discoveryInsightFromResult(result);
            savePersistentUiState();
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
                scenarioDrafts: normalizeScenarioDrafts(payload.scenarioDrafts),
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
                files: payload.files,
                parallel: payload.parallel === true
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
