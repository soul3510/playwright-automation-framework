// agent/4_healer.mjs
// Agent: Healer / Tester
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";

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
    console.error("❌ Missing pageId. Provide --pageId or set CONFLUENCE_PAGE_ID.");
    process.exit(1);
}

const MAX_RETRIES = 15;
const repoKnowledgePath = path.join(agentDir, `repo_knowledge.json`);
const repoKnowledge = fs.existsSync(repoKnowledgePath)
    ? JSON.parse(fs.readFileSync(repoKnowledgePath, "utf8"))
    : {};

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

        const child = spawn("npx", ["playwright", "test", targetPath, "--headed", "--reporter=line"], {
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
                const stepMatches = output.match(/STEP:/g);
                const stepCount = stepMatches ? stepMatches.length : 0;
                
                console.log(`\n📊 Verification: Detected ${stepCount} 'STEP:' logs.`);

                // Requirement: At least 3 logs (Login + 2 business logic steps)
                if (stepCount < 3) {
                    console.warn(`\n⚠️ Business Logic Verification Failed: Only ${stepCount} 'STEP:' logs detected (minimum 3 required).`);
                    success = false;
                    resolve({
                        success: false,
                        output: output + `\n\n❌ ERROR: Test passed login but failed to execute business logic steps. Only ${stepCount} 'STEP:' logs found. At least 3 are required (Login + 2 business logic steps). The AI_IMPLEMENTATION_START block might be empty or missing required console.log('...') for major actions.`
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
    console.log(`\n🩹 Attempting Self-Healing (Attempt ${attempt}/${MAX_RETRIES})...`);
    const currentCode = fs.readFileSync(testFile, "utf8");
    
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
\${JSON.stringify(repoKnowledge, null, 2)}
\${metadataSection}
\${goldenPatternsSection}

\${DIAGNOSTIC_HELPER}

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

    return new Promise((resolve, reject) => {
        const child = spawn("gemini", [], { 
            shell: true,
            env: { ...process.env, GOOGLE_CLOUD_PROJECT: "codeassist-preview" }
        });
        
        let fullOutput = "";
        child.stdin.write(prompt);
        child.stdin.end();

        child.stdout.on("data", (data) => { fullOutput += data.toString(); });
        child.on("close", (code) => {
            let extractedCode = "";
            const match = fullOutput.match(/```(?:typescript|ts|js)?([\s\S]*?)```/);
            if (match) {
                extractedCode = match[1].trim();
                fs.writeFileSync(testFile, extractedCode, "utf8");
                console.log(`✅ Fixed code written to ${path.basename(testFile)}`);
            } else {
                console.error("❌ AI did not return valid code for healing.");
                resolve(false);
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

            resolve(true);
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
        return;
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
            return;
        }
        targetFilePath = path.join(outDir, actualTargetFile);
    }

    if (!fs.existsSync(targetFilePath)) {
        console.error(`❌ Target test file does not exist at path: ${targetFilePath}`);
        return;
    }

    for (let i = 1; i <= MAX_RETRIES; i++) {
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
            if (!healed) break;
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
            
            const diagChild = spawn("gemini", [], { shell: true, env: { ...process.env, GOOGLE_CLOUD_PROJECT: "codeassist-preview" } });
            let diagOutput = "";
            diagChild.stdin.write(diagnosticPrompt);
            diagChild.stdin.end();
            diagChild.stdout.on("data", (data) => { diagOutput += data.toString(); });
            await new Promise((resolve) => {
                diagChild.on("close", () => {
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
}

main().catch(err => {
    console.error("❌ Verification/Healing failed:", err);
    process.exit(1);
});
