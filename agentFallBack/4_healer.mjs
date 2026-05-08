// agent/4_healer.mjs
// Agent: Healer / Tester with MCP integration
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import { createRequire } from "node:module";

const agentDir = process.cwd();
const repoRoot = path.resolve(agentDir, "..");
const generatedDir = path.join(agentDir, "generated");
const require = createRequire(import.meta.url);

function argValue(name) {
    const idx = process.argv.indexOf(name);
    return idx !== -1 ? process.argv[idx + 1] : null;
}

const pageIdEnv = (process.env.CONFLUENCE_PAGE_ID || "").trim();
const pageIdArg = (argValue("--pageId") || "").trim();
const effectivePageId = pageIdArg || pageIdEnv;

if (!effectivePageId) {
    console.error("❌ Missing pageId. Provide --pageId or set CONFLUENCE_PAGE_ID.");
    process.exit(1);
}

const MAX_RETRIES = 15;
const repoKnowledgePath = path.join(agentDir, `repo_knowledge.json`);
const repoKnowledge = fs.existsSync(repoKnowledgePath)
    ? JSON.parse(fs.readFileSync(repoKnowledgePath, "utf8"))
    : {};

function logHealingProgress(message, attempt = null) {
    const prefix = attempt ? `[Healing ${attempt}/${MAX_RETRIES}]` : "[Healing]";
    console.log(`\n${prefix} ${message}`);
}

function startHealingLoader(message, attempt = null) {
    const prefix = attempt ? `[Healing ${attempt}/${MAX_RETRIES}]` : "[Healing]";
    const frames = ["|", "/", "-", "\\"];
    let index = 0;

    process.stdout.write(`\n${prefix} ${message} ${frames[index]}`);
    const timer = setInterval(() => {
        index = (index + 1) % frames.length;
        process.stdout.write(`\r${prefix} ${message} ${frames[index]}`);
    }, 150);

    return {
        stop(doneMessage = "done") {
            clearInterval(timer);
            process.stdout.write(`\r${prefix} ${message} ${doneMessage}\n`);
        }
    };
}

function writePromptToChild(child, prompt, onError) {
    child.stdin.on("error", (error) => {
        onError(error);
    });

    try {
        child.stdin.end(prompt);
    } catch (error) {
        onError(error);
    }
}

function extractUrlForInspection(code, errorLog) {
    const errorUrl = String(errorLog || "").match(/https?:\/\/[^\s"')]+/);
    if (errorUrl) return errorUrl[0].replace(/[.,;]+$/, "");

    const codeUrl = String(code || "").match(/(?:page\.goto|navigateTo)\(\s*['"`](https?:\/\/[^'"`]+)['"`]/);
    if (codeUrl) return codeUrl[1].replace(/[.,;]+$/, "");

    return "";
}

function simplifyText(value, max = 120) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function stringifyMcpContent(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    return content
        .map(item => {
            if (item?.type === "text") return item.text || "";
            if (item?.text) return item.text;
            return JSON.stringify(item);
        })
        .filter(Boolean)
        .join("\n");
}

async function collectOfficialMcpSnapshot(targetUrl, attempt) {
    let createConnection;
    let Client;
    let InMemoryTransport;

    try {
        ({ createConnection } = require("@playwright/mcp"));
        ({ Client } = require("@modelcontextprotocol/sdk/client/index.js"));
        ({ InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js"));
    } catch (error) {
        logHealingProgress(`Official MCP unavailable: ${error.message}`, attempt);
        return null;
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent-fallback-healer", version: "1.0.0" });
    const server = await createConnection({
        browser: {
            launchOptions: { headless: true }
        },
        outputDir: generatedDir,
        network: {
            allowedOrigins: undefined,
            blockedOrigins: undefined
        }
    });

    try {
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport)
        ]);

        const tools = await client.listTools();
        const toolNames = (tools.tools || []).map(tool => tool.name);
        logHealingProgress(`Official MCP connected with ${toolNames.length} tools.`, attempt);

        await client.callTool({
            name: "browser_navigate",
            arguments: { url: targetUrl }
        });

        const snapshotResult = await client.callTool({
            name: "browser_snapshot",
            arguments: {}
        });

        const snapshotText = stringifyMcpContent(snapshotResult);
        const context = {
            source: "official-playwright-mcp",
            attempt,
            url: targetUrl,
            tools: toolNames,
            snapshot: snapshotText
        };
        const contextPath = path.join(generatedDir, `official_mcp_context_attempt_${attempt}.json`);
        fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf8");

        return {
            contextPath,
            text: `
OFFICIAL PLAYWRIGHT MCP SNAPSHOT:
URL: ${targetUrl}
SAVED_TO: ${contextPath}
AVAILABLE_TOOLS: ${toolNames.join(", ")}
SNAPSHOT:
${snapshotText || "(Official MCP returned an empty snapshot.)"}
`
        };
    } finally {
        await client.close().catch(() => {});
        await server.close().catch(() => {});
    }
}

async function collectPlaywrightMcpContext(testFile, currentCode, errorLog, attempt) {
    logHealingProgress("Collecting official Playwright MCP snapshot before Gemini...", attempt);

    const targetUrl = extractUrlForInspection(currentCode, errorLog);
    if (!targetUrl) {
        logHealingProgress("MCP snapshot skipped: no URL found in test or error log.", attempt);
        return "";
    }

    try {
        const officialSnapshot = await collectOfficialMcpSnapshot(targetUrl, attempt);
        if (officialSnapshot?.text) {
            logHealingProgress(`Official MCP snapshot saved: ${officialSnapshot.contextPath}`, attempt);
            return officialSnapshot.text;
        }
    } catch (error) {
        logHealingProgress(`Official MCP snapshot failed: ${error.message}. Falling back to direct Playwright snapshot.`, attempt);
    }

    let chromium;
    try {
        ({ chromium } = require("playwright"));
    } catch (error) {
        logHealingProgress(`MCP snapshot skipped: Playwright package unavailable (${error.message}).`, attempt);
        return "";
    }

    const contextPath = path.join(generatedDir, `mcp_context_attempt_${attempt}.json`);
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1500);

        const snapshot = await page.evaluate(() => {
            const selectors = [
                "button",
                "a",
                "input",
                "select",
                "textarea",
                "[role]",
                "[aria-label]",
                "[data-testid]",
                "[data-test]",
                "[data-cy]",
                "#add-to-cart-button",
                "[name='submit.add-to-cart']"
            ];

            return Array.from(document.querySelectorAll(selectors.join(",")))
                .map((el, index) => {
                    const rect = el.getBoundingClientRect();
                    const attrs = {};
                    for (const name of ["id", "name", "type", "role", "aria-label", "placeholder", "href", "data-testid", "data-test", "data-cy"]) {
                        const value = el.getAttribute(name);
                        if (value) attrs[name] = value;
                    }

                    return {
                        index,
                        tag: el.tagName.toLowerCase(),
                        text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
                        attrs,
                        visible: !!(rect.width || rect.height || el.getClientRects().length),
                        enabled: !(el.disabled || el.getAttribute("aria-disabled") === "true")
                    };
                })
                .filter(item => item.visible)
                .slice(0, 80);
        });

        const context = {
            source: "playwright-mcp-pre-gemini",
            note: "MCP-style live browser snapshot collected before Gemini healing.",
            attempt,
            testFile: path.basename(testFile),
            url: page.url(),
            title: await page.title(),
            elements: snapshot
        };

        fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf8");
        logHealingProgress(`MCP snapshot saved: ${contextPath}`, attempt);

        const focused = snapshot
            .map(el => `${el.tag}${el.attrs.id ? `#${el.attrs.id}` : ""}${el.attrs.name ? `[name="${el.attrs.name}"]` : ""}${el.attrs.role ? `[role="${el.attrs.role}"]` : ""} text="${simplifyText(el.text, 80)}" aria="${simplifyText(el.attrs["aria-label"], 80)}"`)
            .join("\n");

        return `
PLAYWRIGHT MCP SNAPSHOT (LIVE CONTEXT BEFORE GEMINI):
URL: ${context.url}
TITLE: ${context.title}
SAVED_TO: ${contextPath}
INTERACTIVE ELEMENTS:
${focused || "(No visible interactive elements captured.)"}
`;
    } catch (error) {
        logHealingProgress(`MCP snapshot failed: ${error.message}`, attempt);
        return `
PLAYWRIGHT MCP SNAPSHOT:
Failed to collect live context before Gemini: ${error.message}
`;
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

function applyDeterministicHealing(testFile, errorLog, attempt) {
    let code = fs.readFileSync(testFile, "utf8");
    const originalCode = code;
    const errorOutput = errorLog.toLowerCase();
    const changes = [];

    if (/test timeout.*waitforloadstate|networkidle|basepage\.ts:8/i.test(errorLog)) {
        code = code.replace(
            /await\s+landingPage\.navigateTo\(([^;]+)\);/g,
            [
                "await page.goto($1, { waitUntil: 'domcontentloaded', timeout: 60000 });",
                "    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });"
            ].join("\n    ")
        );
        changes.push("Replaced LandingPage.navigateTo networkidle wait with domcontentloaded navigation.");
    }

    if (errorOutput.includes("test timeout") && !/test\.setTimeout\(/.test(code)) {
        code = code.replace(
            /(test\([^,]+,\s*\{[^}]+\},\s*async\s*\(\{\s*page\s*\}\)\s*=>\s*\{)/,
            "$1\n    test.setTimeout(120000);"
        );
        changes.push("Raised this generated test timeout to 120 seconds.");
    }

    if (code !== originalCode) {
        fs.writeFileSync(testFile, code, "utf8");
        console.log(`✅ Deterministic healing applied on attempt ${attempt}:`);
        changes.forEach(change => console.log(`   - ${change}`));
        return true;
    }

    return false;
}

/**
 * MCP-based Healer that uses Playwright to dynamically discover and heal selectors
 */
class MCPHealer {
    constructor(page) {
        this.page = page;
        this.healingLog = [];
    }

    async log(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] 🔧 MCP HEALER: ${message}`;
        console.log(logEntry);
        this.healingLog.push(logEntry);
    }

    /**
     * Discover all clickable elements on the page
     */
    async discoverClickableElements() {
        await this.log('🔍 Starting element discovery...');
        
        const discoveryScript = `
            () => {
                const elements = [];
                
                try {
                    // Find all buttons
                    document.querySelectorAll('button').forEach((el, index) => {
                        elements.push({
                            type: 'button',
                            text: el.textContent?.trim() || '',
                            id: el.id || '',
                            class: el.className || '',
                            selector: \`button:nth-child(\${index + 1})\`,
                            xpath: \`//button[\${index + 1}]\`,
                            visible: el.offsetParent !== null
                        });
                    });
                    
                    // Find all links
                    document.querySelectorAll('a').forEach((el, index) => {
                        elements.push({
                            type: 'link',
                            text: el.textContent?.trim() || '',
                            href: el.href || '',
                            id: el.id || '',
                            class: el.className || '',
                            selector: \`a:nth-child(\${index + 1})\`,
                            xpath: \`//a[\${index + 1}]\`,
                            visible: el.offsetParent !== null
                        });
                    });
                    
                    // Find all input elements
                    document.querySelectorAll('input').forEach((el, index) => {
                        elements.push({
                            type: 'input',
                            type: el.type || '',
                            placeholder: el.placeholder || '',
                            id: el.id || '',
                            class: el.className || '',
                            selector: \`input:nth-child(\${index + 1})\`,
                            xpath: \`//input[\${index + 1}]\`,
                            visible: el.offsetParent !== null
                        });
                    });
                } catch (error) {
                    console.log('Element discovery error:', error.message);
                }
                
                return elements.filter(el => el.visible && el.text);
            }
        `;
        
        try {
            const elements = await this.page.evaluate(discoveryScript);
            await this.log(`📊 Discovered ${elements.length} interactive elements`);
            return elements;
        } catch (error) {
            await this.log(`❌ Element discovery failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Find the best matching element for a given action
     */
    async findBestElement(action, elements) {
        await this.log(`🎯 Finding best element for action: "${action}"`);
        
        const actionLower = action.toLowerCase();
        let bestMatch = null;
        let bestScore = 0;
        
        for (const element of elements) {
            let score = 0;
            
            // Score based on text content matching
            if (element.text) {
                const textLower = element.text.toLowerCase();
                
                if (actionLower.includes('login') && textLower.includes('login')) {
                    score += 10;
                }
                if (actionLower.includes('sign') && textLower.includes('sign')) {
                    score += 10;
                }
                if (actionLower.includes('in') && textLower.includes('in')) {
                    score += 5;
                }
                if (actionLower.includes('try') && textLower.includes('try')) {
                    score += 10;
                }
                if (actionLower.includes('free') && textLower.includes('free')) {
                    score += 10;
                }
                if (actionLower.includes('submit') && textLower.includes('submit')) {
                    score += 10;
                }
            }
            
            // Score based on element type
            if (actionLower.includes('click') || actionLower.includes('button')) {
                if (element.type === 'button') score += 5;
                if (element.type === 'link') score += 3;
            }
            
            // Score based on common patterns
            if (element.id && element.id.toLowerCase().includes('login')) score += 8;
            if (element.class && element.class.toLowerCase().includes('login')) score += 8;
            if (element.id && element.id.toLowerCase().includes('sign')) score += 8;
            if (element.class && element.class.toLowerCase().includes('sign')) score += 8;
            
            await this.log(`   📝 Element: ${element.text} | Score: ${score}`);
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = element;
            }
        }
        
        if (bestMatch) {
            await this.log(`✅ Best match found: "${bestMatch.text}" (score: ${bestScore})`);
            return bestMatch;
        } else {
            await this.log(`⚠️ No suitable element found for action: "${action}"`);
            return null;
        }
    }

    /**
     * Analyze page structure and provide recommendations
     */
    async analyzePageStructure() {
        await this.log('🏗️ Analyzing page structure...');
        
        const analysisScript = `
            () => {
                const structure = {
                    title: document.title || '',
                    url: window.location.href || '',
                    buttons: [],
                    links: [],
                    forms: [],
                    inputs: []
                };
                
                // Analyze buttons
                document.querySelectorAll('button').forEach((el, index) => {
                    structure.buttons.push({
                        index,
                        text: el.textContent?.trim(),
                        id: el.id,
                        class: el.className,
                        disabled: el.disabled,
                        visible: el.offsetParent !== null
                    });
                });
                
                // Analyze links
                document.querySelectorAll('a').forEach((el, index) => {
                    structure.links.push({
                        index,
                        text: el.textContent?.trim(),
                        href: el.href,
                        id: el.id,
                        class: el.className,
                        visible: el.offsetParent !== null
                    });
                });
                
                // Analyze forms
                document.querySelectorAll('form').forEach((el, index) => {
                    structure.forms.push({
                        index,
                        id: el.id,
                        class: el.className,
                        action: el.action,
                        method: el.method,
                        visible: el.offsetParent !== null
                    });
                });
                
                // Analyze inputs
                document.querySelectorAll('input').forEach((el, index) => {
                    structure.inputs.push({
                        index,
                        type: el.type,
                        id: el.id,
                        class: el.className,
                        placeholder: el.placeholder,
                        name: el.name,
                        visible: el.offsetParent !== null
                    });
                });
                
                return structure;
            }
        `;
        
        try {
            const structure = await this.page.evaluate(analysisScript);
            await this.log(`📊 Page analysis complete:`);
            await this.log(`   📄 Title: ${structure.title}`);
            await this.log(`   🔗 URL: ${structure.url}`);
            await this.log(`   🔘 Buttons: ${structure.buttons.length}`);
            await this.log(`   🔗 Links: ${structure.links.length}`);
            await this.log(`   📝 Forms: ${structure.forms.length}`);
            await this.log(`   ⌨️ Inputs: ${structure.inputs.length}`);
            
            return structure;
        } catch (error) {
            await this.log(`❌ Page analysis failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Generate healing suggestions based on discovered elements
     */
    async generateHealingSuggestions(failingLocator, elements) {
        await this.log(`💡 Generating healing suggestions for: "${failingLocator}"`);
        
        const suggestions = [];
        
        // Find elements that might match the failing action
        for (const element of elements.slice(0, 10)) { // Top 10 elements
            if (element.text && element.text.length > 0) {
                suggestions.push({
                    originalLocator: failingLocator,
                    suggestedLocator: `text=${element.text}`,
                    elementType: element.type,
                    confidence: element.text.toLowerCase().includes('login') ? 'high' : 'medium',
                    reason: `Found ${element.type} with text: "${element.text}"`
                });
            }
            
            if (element.id) {
                suggestions.push({
                    originalLocator: failingLocator,
                    suggestedLocator: `#${element.id}`,
                    elementType: element.type,
                    confidence: 'high',
                    reason: `Found ${element.type} with ID: "${element.id}"`
                });
            }
        }
        
        return suggestions;
    }

    /**
     * Get healing log
     */
    getHealingLog() {
        return this.healingLog.join('\n');
    }
}

// Metadata Directory for ElementDiscovery
const metadataDir = path.join(repoRoot, "tests/PlaywrightHelpFullScripts/ElementDiscovery/metadata");

/**
 * Loads UI metadata (ARIA, Roles) for the current page if it exists.
 * This acts as our "Success Snapshot" from a previous stable run.
 */
function loadUiMetadata(pageId) {
    if (!fs.existsSync(metadataDir)) return null;
    
    const files = fs.readdirSync(metadataDir);
    // Look for files containing the pageId
    let match = files.find(f => f.toLowerCase().includes(pageId.toLowerCase()) && f.endsWith(".json"));
    if (!match && pageId === "manual") {
        match = files.find(f => f.toLowerCase().includes("access_groups") && f.endsWith(".json"));
    }
    
    if (match) {
        const metadataPath = path.join(metadataDir, match);
        try {
            return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        } catch (e) {
            console.warn(`⚠️ Failed to parse metadata file: ${match}`);
        }
    }
    return null;
}

const DIAGNOSTIC_HELPER = `
DEBUGGING TIP:
If you are struggling to find the correct selector, you can temporarily inject the following helper function into the test and log its output (e.g. \`console.log(JSON.stringify(await getDiagnosticSnapshot(page), null, 2))\`). This will provide a clean snapshot of only the interactive and semantic elements currently on the page, helping you fix the locator without getting lost in a sea of <div> tags.

\`\`\`javascript
async function getDiagnosticSnapshot(page) {
  return await page.evaluate(() => {
    const interactiveSelectors = ['button', 'input', 'select', 'textarea', 'a', '[role]', '[data-testid]', '[data-hook]', 'header', 'h1', 'h2'];
    const elements = document.querySelectorAll(interactiveSelectors.join(','));
    return Array.from(elements).map(el => ({
      tagName: el.tagName, id: el.id, roles: el.getAttribute('role'),
      testId: el.getAttribute('data-testid') || el.getAttribute('data-hook'),
      text: el.innerText?.substring(0, 50), ariaLabel: el.getAttribute('aria-label'),
      isVisible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    })).filter(el => el.isVisible);
  });
}
\`\`\`
`;

async function runTest(testFile) {
    console.log(`\n🚀 Running test: ${path.basename(testFile)}`);

    if (!fs.existsSync(testFile)) {
        console.error(`❌ Test file does not exist: ${testFile}`);
        return { success: false, output: "File not found" };
    }

    const targetPath = testFile.replace(/\\/g, "/");
    
    return new Promise((resolve) => {
        const env = { ...process.env };
        delete env.CI;
        env.FORCE_COLOR = "0";
        env.PLAYWRIGHT_SERVICE_URL = ""; 

        const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
        const child = spawn(npxCommand, ["playwright", "test", targetPath, "--headed", "--reporter=line"], {
            cwd: repoRoot,
            shell: true,
            env: env
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => { 
            const chunk = data.toString();
            stdout += chunk; 
            process.stdout.write(chunk); 
        });
        child.stderr.on("data", (data) => { 
            const chunk = data.toString();
            stderr += chunk; 
            process.stderr.write(chunk);
        });

        child.on("close", (code) => {
            const output = stdout + "\n" + stderr;
            let success = code === 0;

            // Business Logic Verification: Check for 'STEP:' logs
            if (success) {
                const stepMatches = output.match(/STEP\s*\d*:/g);
                const stepCount = stepMatches ? stepMatches.length : 0;
                
                console.log(`\n📊 Verification: Detected ${stepCount} 'STEP:' logs.`);

                // Require visible step logging, but do not force every scenario into a login-shaped test.
                if (stepCount < 1) {
                    console.warn(`\n⚠️ Business Logic Verification Failed: No 'STEP:' logs detected.`);
                    success = false;
                    resolve({
                        success: false,
                        output: output + `\n\n❌ ERROR: Test passed but no business step logs were found. Add console.log('STEP <n>: ...') markers for major actions.`
                    });
                    return;
                }
            }

            resolve({
                success: success,
                output: output
            });
        });
    });
}

async function heal(testFile, errorLog, attempt) {
    logHealingProgress("Healing failed test...", attempt);

    if (applyDeterministicHealing(testFile, errorLog, attempt)) {
        logHealingProgress("Local deterministic fix applied. Re-running test next.", attempt);
        return true;
    }

    const currentCode = fs.readFileSync(testFile, "utf8");
    const liveMcpContextSection = await collectPlaywrightMcpContext(testFile, currentCode, errorLog, attempt);
    
    // MCP Healing: Check if we can discover elements from the error
    let mcpHealingSection = "";
    const isSelectorError = errorLog.includes('locator') || errorLog.includes('selector') || errorLog.includes('not found');
    
    if (isSelectorError) {
        logHealingProgress("Selector-related error detected. Preparing healing prompt.", attempt);
        mcpHealingSection = `
MCP HEALING INSTRUCTIONS:
This appears to be a selector-related failure. The test is trying to interact with an element that cannot be found.
Use the following MCP healing approach:

1. ELEMENT DISCOVERY: Inject this code into the test to discover available elements:
\`\`\`javascript
// Add this at the beginning of your test for element discovery
const mcpHealer = new MCPHealer(page);
await mcpHealer.analyzePageStructure();
const elements = await mcpHealer.discoverClickableElements();
console.log('MCP Discovered Elements:', JSON.stringify(elements, null, 2));
\`\`\`

2. SMART SELECTOR REPLACEMENT: Replace failing locators with discovered elements:
- Use text-based selectors: \`page.locator('text=Button Text')\`
- Use ID-based selectors: \`page.locator('#element-id')\`
- Use class-based selectors: \`page.locator('.class-name')\`

3. HEALING PATTERN: Instead of hardcoded selectors, use dynamic discovery:
\`\`\`javascript
// Example: Replace failing click with MCP healing
const action = "click login button";
const bestElement = await mcpHealer.findBestElement(action, elements);
if (bestElement) {
    await page.locator(\`text=\${bestElement.text}\`).click();
} else {
    // Fallback strategies
    await page.locator('button').first().click();
}
\`\`\`

4. WAIT STRATEGIES: Add proper waits before interactions:
\`\`\`javascript
await page.waitForLoadState('domcontentloaded');
await page.locator('selector').waitFor({ state: 'visible', timeout: 10000 });
\`\`\`

Focus on making the selectors robust and dynamic based on actual page content.
`;
    }
    
    // 1. Load Extra UI Metadata (Success Snapshot)
    const uiMetadata = loadUiMetadata(effectivePageId);
    let metadataSection = "";
    if (uiMetadata) {
        console.log(`🔍 Injecting UI metadata for page: ${uiMetadata.name}`);
        const focusedElements = (uiMetadata.elements || [])
            .filter(el => ["button", "input", "select", "li", "a"].includes(el.tagName) || el.attributes?.role)
            .map(el => ({
                text: el.text,
                role: el.attributes?.role || el.tagName,
                aria: el.attributes?.["aria-label"] || el.attributes?.["aria-labelledby"],
                dataHook: el.dataHook,
                xpath: el.xpath
            }))
            .slice(0, 50);

        metadataSection = `
SUCCESS SNAPSHOT (EXTRA UI METADATA):
${JSON.stringify({ page: uiMetadata.name, elements: focusedElements }, null, 2)}
`;
    }

    let goldenPatternsSection = "";
    if (repoKnowledge && repoKnowledge.goldenPatterns) {
        goldenPatternsSection = `
GOLDEN PATTERNS (SUCCESSFUL USAGE EXAMPLES):
${JSON.stringify(repoKnowledge.goldenPatterns, null, 2)}
`;
    }

    // 2. Determine Specific Instructions
    const errorOutput = errorLog.toLowerCase();
    const isStepLogFailure = errorOutput.includes("failed to execute business logic steps") ||
        errorOutput.includes("logs found");
    const isTimeout = errorOutput.includes("timeout") || errorOutput.includes("exceeded");
    const isIntercepted = errorOutput.includes("intercepted") || errorOutput.includes("not interactable") || errorOutput.includes("hidden") || errorOutput.includes("detached");
    const isRaceCondition = isTimeout || isIntercepted;

    let specificInstructions = "";

    if (isStepLogFailure) {
        specificInstructions = `
CRITICAL FAILURE: The test passed execution but failed our internal verification because it lacks 'STEP:' logs. 
Every major business action MUST be wrapped in a console.log with the 'STEP:' prefix.
Example: 
await console.log('STEP: Clicking the trash icon');
await page.locator('[data-hook="search-bar-linked-metrics-0"]').click();

You MUST ensure there are at least 3 distinct 'STEP:' logs in the final implementation.`;
    } else if (isRaceCondition) {
        specificInstructions = `
ROOT CAUSE ANALYSIS & SMART WAIT INJECTION:
The test failed due to a race condition (Timeout or Element Intercepted/Hidden).
1. Compare the failing locator from the ERROR LOG against the SUCCESS SNAPSHOT provided above to ensure it exists.
2. Do NOT just retry the exact same action. You MUST inject a smart wait before the failing action to stabilize the test.
Use one of the following wait strategies:
- await page.waitForResponse(response => response.url().includes('/api/') && response.status() === 200);
- await page.locator('...').waitFor({ state: 'visible', timeout: 10000 });
- await page.waitForLoadState('networkidle');
3. Review the GOLDEN PATTERNS to ensure your interaction matches project conventions.
4. Apply the fix and return the complete corrected code.`;
    } else {
        specificInstructions = `
ROOT CAUSE ANALYSIS:
1. Analyze the error log carefully.
2. Compare the failing locator against the SUCCESS SNAPSHOT (EXTRA UI METADATA) provided to see if the element definition differs.
3. Review the GOLDEN PATTERNS to ensure your interaction matches project conventions.
4. Fix the code so the test passes. Ensure all locators are correct and interactions are awaited.`;
    }

    const prompt = `
ROLE: Senior SDET
GOAL: Fix or Implement the Playwright test.

FILE: ${path.basename(testFile)}

CURRENT CODE:
\`\`\`typescript
${currentCode}
\`\`\`

ERROR LOG:
\`\`\`
${errorLog}
\`\`\`

REPO KNOWLEDGE (SELECTORS & CONVENTIONS):
${JSON.stringify(repoKnowledge, null, 2)}
${metadataSection}
${goldenPatternsSection}

${DIAGNOSTIC_HELPER}

${liveMcpContextSection}

${mcpHealingSection}

INSTRUCTIONS:
1. ${specificInstructions}
2. If the error is related to missing selectors or incorrect Page Object usage, consult the REPO KNOWLEDGE.
   - **IMPACT ANALYSIS**: Check \`pageObjectUsage\` in REPO KNOWLEDGE. If you need to override a Page Object locator/method:
     - If it is used in > 5 tests: Be extremely conservative. Do not break existing tests. Prefer using a raw inline locator in this specific test file instead.
     - If it is used in only 1 test: You can be aggressive in replacing or modifying the logic.
3. COMMON FIXES (CATEGORIZE ERROR FIRST):
   - **Selector Timeout**: Refine the locator using parent-child chaining or \`.first()\`. Check if it needs to be visible.
   - **Data Mismatch**: Check \`scenario.dataInputs\` for stale values. Ensure dynamic data variables are used rather than hardcoded examples.
   - **Strict Mode Violation**: Ensure the locator is unique to the specific modal or section before defaulting to \`.first()\`.
   - **Navigation**: Ensure \`await page.waitForURL(...)\` is used after navigation actions.

CRITICAL RULES TO MAINTAIN:
- **Environment Handling**: Never hardcode URLs. Use \`process.env.APP_ENV\`.
- **Utils Folder**: You MUST use the utils/ folder for testing helpers. Find the right methods in this folder's scripts or add new ones there if they do not exist.
- **Logging**: Ensure that EVERY healing attempt includes updated \`console.log('...')\` markers for visibility in the verification logs. Maintain these for EVERY major action/step.
- **Database**: Use \`dbUtils.ts\` for data setup/cleanup if applicable.
- **Failure Handling**: Ensure failure messages are descriptive.

4. Return ONLY the full corrected code in a \`\`\`typescript\`\`\` block.
5. IF you fixed a locator or identified a flaky element, output a brief JSON block at the very end wrapped in \`\`\`json\`\`\` containing \`{ "lessonsLearned": [{ "locator": "...", "fix": "...", "reason": "..." }] }\`.
`;

    const loader = startHealingLoader("Finding better selectors and code fix...", attempt);

    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(process.execPath, [path.join(agentDir, "gemini-cli.js")], {
                shell: false,
                env: { ...process.env, GOOGLE_CLOUD_PROJECT: "codeassist-preview" }
            });
        } catch (error) {
            loader.stop("failed");
            console.error(`❌ Could not start Gemini healer: ${error.message}`);
            resolve(false);
            return;
        }
        
        let fullOutput = "";
        let fullError = "";
        let settled = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        writePromptToChild(child, prompt, (error) => {
            loader.stop("failed");
            console.error(`❌ Gemini stdin closed before the healing prompt was accepted: ${error.message}`);
            if (fullError.trim()) console.error(fullError.trim());
            finish(false);
        });

        child.stdout.on("data", (data) => { fullOutput += data.toString(); });
        child.stderr.on("data", (data) => { fullError += data.toString(); });
        child.on("close", (code) => {
            if (settled) return;
            loader.stop(code === 0 ? "response received" : "failed");
            if (code !== 0) {
                console.error(`❌ Gemini healer exited with code ${code}.`);
                if (fullError.trim()) console.error(fullError.trim());
                finish(false);
                return;
            }

            let extractedCode = "";
            const match = fullOutput.match(/```(?:typescript|ts|js)?([\s\S]*?)```/);
            if (match) {
                extractedCode = match[1].trim();
                fs.writeFileSync(testFile, extractedCode, "utf8");
                logHealingProgress(`Gemini fix written to ${path.basename(testFile)}. Re-running test next.`, attempt);
            } else {
                console.error("❌ AI did not return valid code for healing.");
                finish(false);
                return;
            }

            // Extract lessons learned
            const jsonMatch = fullOutput.match(/```json\s*([\s\S]*?)\s*```/g);
            if (jsonMatch && jsonMatch.length > 0) {
                // Get the last json block which usually contains the lessons learned
                const lastJsonBlock = jsonMatch[jsonMatch.length - 1];
                const cleanJson = lastJsonBlock.replace(/```json\s*/, '').replace(/```/, '').trim();
                try {
                    const parsed = JSON.parse(cleanJson);
                    if (parsed.lessonsLearned && Array.isArray(parsed.lessonsLearned)) {
                        console.log(`🧠 Extracted ${parsed.lessonsLearned.length} lesson(s) learned.`);
                        
                        // Update task_state.json
                        const statePath = path.join(agentDir, 'task_state.json');
                        let state = {};
                        if (fs.existsSync(statePath)) {
                            try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch(e) {}
                        }
                        
                        state.healer = state.healer || {};
                        state.healer.lessonsLearned = state.healer.lessonsLearned || [];
                        state.healer.lessonsLearned.push(...parsed.lessonsLearned);
                        
                        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
                    }
                } catch(e) {
                    console.warn("⚠️ Failed to parse lessonsLearned JSON from LLM output:", e.message);
                }
            }

            finish(true);
        });
        child.on("error", (error) => {
            loader.stop("failed");
            console.error(`❌ Gemini healer process error: ${error.message}`);
            finish(false);
        });
    });
}

async function main() {
    console.log("\n**********************************************");
    console.log("Healer/Tester is starting to work...");
    console.log("**********************************************\n");
    
    // Initialize task_state tracking
    const statePath = path.join(agentDir, 'task_state.json');
    let state = {};
    if (fs.existsSync(statePath)) {
        try {
            state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        } catch(e) {}
    }
    
    const outDir = path.join(repoRoot, "tests/generated-from-agentFallBack");
    
    if (!fs.existsSync(outDir)) {
        console.error(`❌ Output directory not found: ${outDir}`);
        process.exit(1);
    }

    // NEW: Use Metadata Link
    const metadataPath = path.join(generatedDir, "last_generated_test.json");
    let targetFilePath = "";
    let actualTargetFile = "";

    if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        targetFilePath = metadata.absPath;
        actualTargetFile = metadata.fileName;
        console.log(`📎 Using metadata from last_generated_test.json: ${actualTargetFile}`);
    } else {
        // Fallback for standalone runs or legacy support
        console.log("⚠️ No last_generated_test.json found. Falling back to directory search...");
        const files = fs.readdirSync(outDir);
        actualTargetFile = files.find(f => f.includes(effectivePageId) && f.endsWith(".test.ts"));
        if (!actualTargetFile) {
            console.error(`❌ Could not find generated test file for page ${effectivePageId} in ${outDir}`);
            process.exit(1);
        }
        targetFilePath = path.join(outDir, actualTargetFile);
    }

    if (!fs.existsSync(targetFilePath)) {
        console.error(`❌ Target test file does not exist at path: ${targetFilePath}`);
        process.exit(1);
    }

    for (let i = 1; i <= MAX_RETRIES; i++) {
        if (i > 1) {
            logHealingProgress("Running healed test again...", i);
        }
        const result = await runTest(targetFilePath);
        
        if (result.success) {
            console.log(`\n🎉 Test PASSED on attempt ${i}!`);
            
            // Update task_state.json with success
            state.currentAgent = 'healer';
            state.healer = {
                targetFilePath: targetFilePath,
                targetFileName: actualTargetFile,
                pageId: effectivePageId,
                lastRunStatus: 'PASSED',
                healingAttempts: i,
                maxRetries: MAX_RETRIES,
                completed: true,
                completedAt: new Date().toISOString()
            };
            state.status = 'PASSED';
            state.logs = state.logs || [];
            state.logs.push({
                agent: 'healer',
                timestamp: new Date().toISOString(),
                message: `Test PASSED after ${i} attempt(s): ${actualTargetFile}`
            });
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
            console.log("Updated task_state.json");
            
            console.log("\n**********************************************");
            console.log("Healer/Tester finished.");
            console.log("Page Object Refactorer is now starting to work...");
            console.log("**********************************************");
            process.exit(0); // Explicit success exit code
        }

        console.log(`\n❌ Test FAILED on attempt ${i}.`);
        
        if (i < MAX_RETRIES) {
            const healed = await heal(targetFilePath, result.output, i);
            if (!healed) {
                console.warn(`⚠️ Healing attempt ${i} did not produce a code change. Retrying until ${MAX_RETRIES} attempts are exhausted.`);
            }
        } else {
            console.log("\n❌ Max retries reached. Test still failing.");
            console.log("\n🕵️ Performing Final Diagnostic Run to categorize the failure...");

            const diagnosticPrompt = `
ROLE: Senior SDET / QA Lead
GOAL: Categorize the final test failure after all healing attempts have been exhausted and provide a detailed bug report.

ENVIRONMENT BASE URL: ${process.env.APP_BASE_URL || 'https://qa-beta.veevacrossix.com'}

ERROR LOG:
\`\`\`
${result.output}
\`\`\`

INSTRUCTIONS:
1. Analyze the final error log.
2. If the error mentions 'API_BUG_INDICATOR' (e.g. 500 or 400 responses), categorize as 'API_FAILURE'.
3. If the error mentions 'CONSOLE_BUG_INDICATOR', categorize as 'CONSOLE_ERROR'.
4. If an element is missing from the DOM but the locator looks correct and idiomatic, or if an expect() assertion failed, categorize as 'UI_ASSERTION_FAILURE'.
5. If the code still has syntax errors, missing PO methods, or is just badly written, categorize as 'AUTOMATION_ERROR'.
6. Provide a comprehensive bug report for each issue found.
7. Return ONLY a JSON block wrapped in \`\`\`json\`\`\` like this:
{
  "detectedBugs": [
    {
      "type": "UI_ASSERTION_FAILURE",
      "severity": "High",
      "title": "Concise issue title",
      "description": "Detailed explanation of what went wrong",
      "stepsToReproduce": [
        "1. Open the application",
        "2. Navigate to...",
        "3. Click..."
      ],
      "pageLink": "URL or page reference where the issue exists",
      "scenario": "${effectivePageId}"
    }
  ]
}
`;
            
            const diagChild = spawn(process.execPath, [path.join(agentDir, "gemini-cli.js")], {
                shell: false,
                env: { ...process.env, GOOGLE_CLOUD_PROJECT: "codeassist-preview" }
            });
            let diagOutput = "";
            let diagError = "";
            let diagnosticSettled = false;
            writePromptToChild(diagChild, diagnosticPrompt, (error) => {
                diagnosticSettled = true;
                console.warn(`⚠️ Final diagnostic Gemini stdin closed early: ${error.message}`);
            });
            diagChild.stdout.on("data", (data) => { diagOutput += data.toString(); });
            diagChild.stderr.on("data", (data) => { diagError += data.toString(); });
            await new Promise((resolve) => {
                diagChild.on("close", (code) => {
                    if (diagnosticSettled) {
                        resolve();
                        return;
                    }
                    if (code !== 0 && diagError.trim()) {
                        console.warn(`⚠️ Final diagnostic Gemini call failed: ${diagError.trim()}`);
                    }
                    const jsonMatch = diagOutput.match(/```json\s*([\s\S]*?)\s*```/);
                    if (jsonMatch) {
                        try {
                            const parsedDiag = JSON.parse(jsonMatch[1].trim());
                            if (parsedDiag.detectedBugs) {
                                state.bugReport = state.bugReport || { detectedBugs: [] };
                                state.bugReport.detectedBugs.push(...parsedDiag.detectedBugs);
                                console.log(`🐛 Logged ${parsedDiag.detectedBugs.length} real bug(s) to task_state.json`);
                            }
                        } catch(e) {
                            console.warn("⚠️ Failed to parse diagnostic JSON.");
                        }
                    }
                    resolve();
                });
                diagChild.on("error", (error) => {
                    console.warn(`⚠️ Final diagnostic Gemini process error: ${error.message}`);
                    resolve();
                });
            });

            // Update task_state.json with failure
            state.currentAgent = 'healer';
            state.healer = {
                targetFilePath: targetFilePath,
                targetFileName: actualTargetFile,
                pageId: effectivePageId,
                lastRunStatus: 'FAILED',
                healingAttempts: MAX_RETRIES,
                maxRetries: MAX_RETRIES,
                completed: false,
                failedAt: new Date().toISOString()
            };
            state.status = 'FAILED';
            state.logs = state.logs || [];
            state.logs.push({
                agent: 'healer',
                timestamp: new Date().toISOString(),
                message: `Test FAILED after ${MAX_RETRIES} healing attempts: ${actualTargetFile}`
            });
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
            console.log("Updated task_state.json");
            
            console.log("\n**********************************************");
            console.log("Healer/Tester finished with failures.");
            console.log("**********************************************");
            process.exit(1); // Explicit failure exit code
        }
    }

    console.error(`❌ Healer exited retry loop without passing ${actualTargetFile}.`);
    process.exit(1);
}

main().catch(err => {
    console.error("❌ Verification/Healing failed:", err);
    process.exit(1);
});
