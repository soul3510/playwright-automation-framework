// agent/6_refactorer.mjs
// Agent: Page Object Refactorer
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

const repoKnowledgePath = path.join(agentDir, "repo_knowledge.json");
const repoKnowledge = fs.existsSync(repoKnowledgePath)
    ? JSON.parse(fs.readFileSync(repoKnowledgePath, "utf8"))
    : {};

async function refactorTest(testFile) {
    console.log(`\n🔧 Refactoring to Page Objects: ${path.basename(testFile)}`);
    const currentCode = fs.readFileSync(testFile, "utf8");

    const prompt = `
ROLE: Senior SDET / Code Architect
GOAL: Refactor the provided Playwright test to use existing Page Objects instead of raw selectors.

FILE: ${path.basename(testFile)}

CURRENT CODE:
\`\`\`typescript
${currentCode}
\`\`\`

REPO KNOWLEDGE (EXISTING PAGE OBJECTS):
${JSON.stringify(repoKnowledge.login || {}, null, 2)}
${JSON.stringify(repoKnowledge.conventions || {}, null, 2)}

INSTRUCTIONS:
1. Analyze the "CURRENT CODE".
2. Identify raw Playwright calls (e.g., \`page.locator\`, \`page.fill\`, \`page.click\`) that perform actions covered by the "REPO KNOWLEDGE".
   - Specifically look for Login actions that can be replaced by \`LoginPage\` methods.
   - Look for common navigation or setup steps.
3. Rewrite the test to instantiate and use the Page Objects.
   - Example: Replace \`await page.fill('#username', user)\` with \`await loginPage.login(user, pass)\`.
4. Ensure the test logic remains EXACTLY the same. Do not change assertions or flow, only the implementation details.
5. Keep existing imports and add new imports for the Page Objects if needed (e.g., \`import { LoginPage } from '../../page-objects/login/LoginPage';\`).
6. **Utils Folder**: You MUST use the utils/ folder for testing helpers. Find the right methods in this folder's scripts or add new ones there if they do not exist.
7. Return ONLY the full refactored code in a \`\`\`typescript\`\`\` block.
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
            const match = fullOutput.match(/```(?:typescript|ts|js)?([\s\S]*?)```/);
            if (match) {
                const refactoredCode = match[1].trim();
                // Basic sanity check: did we actually change anything?
                if (refactoredCode.length > 0 && refactoredCode !== currentCode.trim()) {
                    fs.writeFileSync(testFile, refactoredCode, "utf8");
                    console.log(`✅ Refactored code saved to ${path.basename(testFile)}`);
                    resolve(true);
                } else {
                    console.log("ℹ️ No refactoring needed or AI returned identical code.");
                    resolve(false);
                }
            } else {
                console.error("❌ AI did not return valid code for refactoring.");
                resolve(false);
            }
        });
    });
}

async function main() {
    console.log("\n**********************************************");
    console.log("Page Object Refactorer is starting to work...");
    console.log("**********************************************\n");
    
    const outDir = path.join(repoRoot, "tests/generated-from-agentFallBack");
    
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
        const files = fs.readdirSync(outDir);
        actualTargetFile = files.find(f => f.includes(effectivePageId) && f.endsWith(".test.ts"));
        if (!actualTargetFile) {
            console.error(`❌ Could not find generated test file for page ${effectivePageId}`);
            process.exit(1); // Exit with error code so the pipeline fails correctly
        }
        targetFilePath = path.join(outDir, actualTargetFile);
    }

    const refactorResult = await refactorTest(targetFilePath);
    
    // Update task_state.json
    const statePath = path.join(agentDir, 'task_state.json');
    let state = {};
    if (fs.existsSync(statePath)) {
        try {
            state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        } catch(e) {}
    }
    state.currentAgent = 'refactorer';
    state.refactorer = {
        targetFilePath: targetFilePath,
        targetFileName: actualTargetFile,
        pageId: effectivePageId,
        refactored: refactorResult,
        completed: true,
        completedAt: new Date().toISOString()
    };
    state.status = 'COMPLETED';
    state.logs = state.logs || [];
    state.logs.push({
        agent: 'refactorer',
        timestamp: new Date().toISOString(),
        message: `Refactored to Page Objects: ${actualTargetFile} (${refactorResult ? 'changes applied' : 'no changes needed'})`
    });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    console.log("Updated task_state.json");
    
    console.log("\n**********************************************");
    console.log("Page Object Refactorer finished.");
    console.log("All agents completed successfully!");
    console.log("**********************************************");
}

main().catch(err => {
    console.error("❌ Refactoring failed:", err);
    process.exit(1);
});
