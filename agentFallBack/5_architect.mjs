// agent/5_architect.mjs
// Agent: Architect
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const agentDir = process.cwd();
const repoRoot = path.resolve(agentDir, "..");
const statePath = path.join(agentDir, 'task_state.json');

if (!fs.existsSync(statePath)) {
    console.error("❌ task_state.json not found.");
    process.exit(1);
}

let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

// Extract pageId from task_state
let pageId = state.qaEngineer?.pageId || state.testGenerator?.pageId || "manual";
if (process.argv.includes('--pageId')) {
    pageId = process.argv[process.argv.indexOf('--pageId') + 1];
}

console.log("\n**********************************************");
console.log("Architect is starting to work...");
console.log("**********************************************");
console.log("\n🏗️ Architecting Page Objects...");

state.currentAgent = 'architect';
state.logs = state.logs || [];
state.logs.push({
    agent: 'architect',
    timestamp: new Date().toISOString(),
    message: 'Architect started analyzing scenarios for missing Page Objects'
});
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

const scenarios = (state.businessAnalyst?.scenarios || []).join('\n').toLowerCase() || JSON.stringify(state.businessAnalyst || "").toLowerCase();
const available = (state.librarian?.availablePageObjects || []).join('\n').toLowerCase();

let plan = {};
let missingPageObjects = [];

// Existing logic to identify missing POs (enhanced or kept as is)
if (scenarios.includes('access group detail page') || scenarios.includes('edit users assigned to an access group')) {
    plan = {
        "page-objects/settings/accessGroup/AccessGroupDetailsPage.ts": {
            "description": "Page object for Access Group Details Page, containing methods to edit assigned users, verify eligible users, and manage access group details.",
            "methods": [
                "clickEditUsers()",
                "getEligibleUsers()",
                "getAssignedUsers()",
                "assignUser(email)"
            ],
            "mandatoryAssertionPoints": [
                "Verify the count of assigned users is greater than 0 if assignment was successful",
                "Verify the specific user email appears in the assigned users list",
                "Ensure the assigned users are visually differentiated from eligible users"
            ]
        }
    };
}

// ---------------------------------------------------------
// NEW: PO Scaffolding Logic (Diagnostic Snapshot / UI Metadata)
// ---------------------------------------------------------
const metadataDir = path.join(repoRoot, "tests/PlaywrightHelpFullScripts/ElementDiscovery/metadata");

function loadUiMetadata(pageId) {
    if (!fs.existsSync(metadataDir)) return null;
    const files = fs.readdirSync(metadataDir);
    // Look for files containing the pageId or the word "Access" since this is an example
    let match = files.find(f => f.toLowerCase().includes(pageId.toLowerCase()) && f.endsWith(".json"));
    if (!match && pageId === "manual") {
        // try to find access group metadata as fallback
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

async function callGemini(prompt) {
    return new Promise((resolve, reject) => {
        const child = spawn("gemini", [], { 
            shell: true,
            env: { ...process.env, GOOGLE_CLOUD_PROJECT: "codeassist-preview" }
        });
        
        let fullOutput = "";
        child.stdin.write(prompt);
        child.stdin.end();

        child.stdout.on("data", (data) => {
            fullOutput += data.toString();
            process.stdout.write(".");
        });

        child.on("close", (code) => resolve(fullOutput));
        child.on("error", (err) => reject(err));
    });
}

async function injectMethodsToExistingPO(absPath, poPath, missingMethods, poDetails, uiContextStr) {
    console.log(`\n🤖 Injecting missing methods into existing Page Object: ${poPath}...`);
    console.log(`Missing methods: ${missingMethods.join(', ')}`);

    const fileContent = fs.readFileSync(absPath, 'utf8');
    const classNameMatch = fileContent.match(/class\s+(\w+)/);
    const className = classNameMatch ? classNameMatch[1] : "ExistingPageObject";

    const prompt = `
ROLE: Senior SDET Architect
GOAL: Generate TypeScript methods to be injected into an existing Playwright Page Object class.

CLASS NAME: ${className}
FILE PATH: ${poPath}

DESCRIPTION: ${poDetails.description}

METHODS TO GENERATE:
${missingMethods.map(m => `- ${m}`).join("\n")}

ASSERTION POINTS REQUIRED:
${poDetails.mandatoryAssertionPoints.map(m => `- ${m}`).join("\n")}

DOM SNAPSHOT (UI METADATA):
\`\`\`json
${uiContextStr}
\`\`\`

INSTRUCTIONS:
1. Generate ONLY the TypeScript methods requested.
2. DO NOT generate the whole class, constructor, or imports.
3. Assume \`this.page\` is available.
4. IMPORTANT: Use the provided DOM Snapshot to create REALISTIC locators.
5. Include proper JSDoc comments for each method.
6. Return ONLY the methods inside a \`\`\`typescript\`\`\` block. Do not include class wrapper.
`;

    try {
        const aiResponse = await callGemini(prompt);
        const match = aiResponse.match(/```(?:typescript|ts)?\n([\s\S]*?)```/i);
        if (match && match[1]) {
            const newMethodCode = `\n    // AI_GENERATED_METHODS_START\n` + match[1].trim().split('\n').map(line => `    ${line}`).join('\n') + `\n    // AI_GENERATED_METHODS_END\n`;
            
            const closingBraceIndex = fileContent.lastIndexOf('}');
            if (closingBraceIndex !== -1) {
                const updatedContent = fileContent.slice(0, closingBraceIndex) + newMethodCode + fileContent.slice(closingBraceIndex);
                fs.writeFileSync(absPath, updatedContent, 'utf8');
                console.log(`\n✅ Successfully injected methods into ${poPath}`);
                
                state.logs.push({
                    agent: 'architect',
                    timestamp: new Date().toISOString(),
                    message: `Injected missing methods into ${poPath}: ${missingMethods.join(', ')}`
                });
            } else {
                console.error(`\n❌ Failed to find closing brace in ${poPath}`);
            }
        } else {
            console.error(`\n❌ Failed to extract code block for method injection in ${poPath}`);
        }
    } catch (e) {
        console.error(`\n❌ AI method injection failed for ${poPath}: ${e.message}`);
    }
}

async function scaffoldNewPO(absPath, poPath, poDetails, uiContextStr) {
    console.log(`\n🤖 Scaffolding new Page Object: ${poPath}...`);
    
    const classNameMatch = poPath.match(/\/([A-Z][a-zA-Z0-9]+)\.ts$/);
    const className = classNameMatch ? classNameMatch[1] : "NewPageObject";

    const prompt = `
ROLE: Senior SDET Architect
GOAL: Scaffold a missing Playwright Page Object class based on the provided UI metadata (DOM snapshot).

CLASS NAME: ${className}
FILE PATH: ${poPath}

DESCRIPTION: ${poDetails.description}

METHODS REQUIRED:
${poDetails.methods.map(m => `- ${m}`).join("\n")}

ASSERTION POINTS REQUIRED:
${poDetails.mandatoryAssertionPoints.map(m => `- ${m}`).join("\n")}

DOM SNAPSHOT (UI METADATA):
\`\`\`json
${uiContextStr}
\`\`\`

INSTRUCTIONS:
1. Create a complete, functional Playwright Page Object written in TypeScript.
2. Use \`readonly page: Page;\` in the constructor.
3. Map the requested methods to logical Playwright actions.
4. IMPORTANT: Use the provided DOM Snapshot to create REALISTIC locators (e.g., \`this.page.getByRole('button', { name: 'Edit' })\` or \`this.page.locator('[data-hook="edit-btn"]')\`).
5. Include proper JSDoc comments.
6. Return the full file content inside // AI_PO_START and // AI_PO_END markers.
`;

    try {
        const aiResponse = await callGemini(prompt);
        const regex = /\/\/\s*AI_PO_START([\s\S]*?)\/\/\s*AI_PO_END/i;
        let code = "";
        const match = aiResponse.match(regex);
        
        if (match && match[1]) {
             code = match[1].replace(/^```(?:typescript|ts)?\s*/i, '').replace(/```\s*$/i, '').trim();
        } else {
             // Fallback
             const fallbackMatch = aiResponse.match(/```(?:typescript|ts)?\n([\s\S]*?)```/i);
             if (fallbackMatch && fallbackMatch[1]) {
                 code = fallbackMatch[1].trim();
             }
        }
        
        if (code) {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, code, "utf8");
            console.log(`\n✅ Successfully scaffolded and saved ${poPath}`);
            
            // Add to state logs
            state.logs.push({
                agent: 'architect',
                timestamp: new Date().toISOString(),
                message: `Scaffolded Page Object: ${poPath} using DOM metadata`
            });
        } else {
            console.error(`\n❌ Failed to extract code block for ${poPath}`);
        }
    } catch (e) {
        console.error(`\n❌ AI scaffolding failed for ${poPath}: ${e.message}`);
    }
}

async function processArchitectPlan() {
    const uiMetadata = loadUiMetadata(pageId);
    let uiContextStr = "No UI metadata found for scaffolding locators.";
    if (uiMetadata) {
        const focusedElements = (uiMetadata.elements || [])
            .filter(el => ["button", "input", "select", "li", "a"].includes(el.tagName) || el.attributes?.role)
            .map(el => ({
                text: el.text,
                role: el.attributes?.role || el.tagName,
                aria: el.attributes?.["aria-label"] || el.attributes?.["aria-labelledby"],
                testId: el.dataHook || el.attributes?.['data-testid'],
                xpath: el.xpath
            }))
            .slice(0, 50); // limit
        uiContextStr = JSON.stringify({ page: uiMetadata.name, elements: focusedElements }, null, 2);
    }

    for (const poPath of Object.keys(plan)) {
        const poDetails = plan[poPath];
        const absPath = path.resolve(repoRoot, poPath);
        
        if (fs.existsSync(absPath)) {
            // 1. Detect Missing Methods
            const fileContent = fs.readFileSync(absPath, 'utf8');
            const missingMethods = [];
            for (const methodStr of poDetails.methods) {
                const methodName = methodStr.split('(')[0].trim();
                if (!fileContent.includes(methodName)) {
                    missingMethods.push(methodStr);
                }
            }
            
            if (missingMethods.length > 0) {
                // 2. Implement the "Method Injector"
                await injectMethodsToExistingPO(absPath, poPath, missingMethods, poDetails, uiContextStr);
            } else {
                console.log(`ℹ️ Page Object ${poPath} exists and all required methods are present.`);
            }
        } else {
            // 3. Scaffold completely new PO
            missingPageObjects.push(poPath); // keep track
            await scaffoldNewPO(absPath, poPath, poDetails, uiContextStr);
        }
    }
}

// Execute the new scaffolding logic if there's a plan
async function run() {
    // 4. Strict Check: Ensure Librarian has mapped POs
    if (!state.librarian?.completed) {
         console.warn("⚠️ Librarian has not completed mapping. Proceeding with caution.");
    }

    if (Object.keys(plan).length > 0) {
        await processArchitectPlan();
    }

    state.architect = state.architect || {};
    state.architect.plan = plan;
    state.architect.missingPageObjects = missingPageObjects;
    state.architect.completed = true;
    state.architect.completedAt = new Date().toISOString();
    state.currentAgent = 'architect';

    state.logs.push({
        agent: 'architect',
        timestamp: new Date().toISOString(),
        message: `Architect processed ${Object.keys(plan).length} Page Objects in plan.`
    });

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log("\n✅ Architect plan updated in task_state.json.");
    console.log("\n**********************************************");
    console.log("Architect finished.");
    console.log("**********************************************");
}

run().catch(console.error);