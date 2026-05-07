// agentFallBack/start_agent.mjs
import readline from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rl = readline.createInterface({input, output});

async function runCommand(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {stdio: 'inherit', shell: true});
        child.on('close', (code) => {
            resolve(code);
        });
    });
}

/**
 * Play completion sound - different sound for success vs failure
 * @param {boolean} success - true for success, false for failure
 */
function playCompletionSound(success = true) {
    try {
        if (process.platform === 'win32') {
            // Use different system sounds for success vs failure
            const soundName = success ? 'Hand' : 'Beep';
            spawn('powershell.exe', [
                '-c',
                `[System.Media.SystemSounds]::${soundName}.Play()`
            ], { stdio: 'ignore', detached: true }).unref();
        } else {
            // Unix/Mac - use multiple terminal bells for completion
            process.stdout.write('\x07\x07\x07');
        }
    } catch (e) {
        process.stdout.write('\x07\x07');
    }
}

// Helper: Collect multi-line input until user types "DONE" or hits Enter on an empty line
async function getMultiLineInput(promptText, allowEmptyDone = true) {
    console.log(`\n${promptText}`);
    const finishMsg = allowEmptyDone 
        ? "(Paste/Type text, then press Enter twice or type 'DONE' to finish):"
        : "(Paste/Type text, then type 'DONE' on a new line to finish):";
    console.log(finishMsg);
    
    let lines = [];
    while (true) {
        const line = await rl.question("> ");
        const trimmed = line.trim().toUpperCase();
        // If allowEmptyDone is true, an empty line (Enter twice) terminates
        if (trimmed === 'DONE' || (allowEmptyDone && line === '')) {
            break;
        }
        lines.push(line);
    }
    return lines.join("\n");
}

async function main() {
    // 1. Robust Directory Setup
    const agentDir = process.cwd();
    const repoRoot = path.resolve(agentDir, "..");
    const generatedDir = path.join(agentDir, "generated");
    
    // Define the manual scenario path here
    const manualScenarioPath = path.join(repoRoot, "tests/generated-from-agentFallBack/scenario.txt");

    if (!fs.existsSync(generatedDir)) {
        fs.mkdirSync(generatedDir, { recursive: true });
    }

    console.log("\n🤖 WELCOME TO PLAYWRIGHT AUTOMATION AGENT");
    console.log("------------------------------------------");

    // 2. Selection Menu
    console.log("From where should I generate the test?");
    console.log("1) Confluence Page(s)");
    console.log("2) Jira Ticket(s)");
    console.log("3) Single Scenario (Text Input: scenario.txt)");
    console.log("4) Fix Existing Test (Regenerate with same logic)");

    const choice = await rl.question("\nSelect option (1-4): ");

    let pipelineStatus = 0;

    // 3. Handling Choices
    if (choice === '1') {
        const ids = await rl.question("Enter Confluence Page ID(s) separated by comma: ");
        pipelineStatus = await runCommand('node', ['run_one_page_multi_task.mjs', '--pageIds', ids, '--mode', 'smart']);
    } else if (choice === '2') {
        const keys = await rl.question("Enter Jira Ticket Key(s) (e.g., DN-123,DN-456): ");
        pipelineStatus = await runCommand('node', ['run_one_page_multi_task.mjs', '--jiraKeys', keys, '--mode', 'smart']);
    } else if (choice === '3') {
        console.log("\n📝 MANUAL SCENARIO LOADER");

        // 1. Check if the scenario file exists
        if (!fs.existsSync(manualScenarioPath)) {
            console.error(`\n❌ Error: Scenario file not found at: ${manualScenarioPath}`);
            console.log("Please create the file with the following format:");
            console.log("Subject: <Your Subject>\nUser: <Role>\nSteps:\n<Your Steps>\nExpected:\n<Expected Result>");
            rl.close();
            return;
        }

        console.log(`📂 Reading scenario from: ${manualScenarioPath}`);
        const fileContent = fs.readFileSync(manualScenarioPath, "utf8");

        // 2. Simple Parser to show the user what we found (Review Block)
        console.log("\n------------------------------------------");
        console.log("🔍 REVIEW LOADED SCENARIO");
        console.log("------------------------------------------");
        console.log(fileContent);
        console.log("------------------------------------------");

        const confirm = await rl.question("\nProceed with this scenario? (y/n): ");

        if (confirm.toLowerCase() === 'y') {
            console.log("\n🚀 Injecting into the brain and starting generation...");

            // 3. Save to the internal temp file used by the pipeline
            const tempPath = path.join(generatedDir, "manual_input_temp.txt");
            fs.writeFileSync(tempPath, fileContent);

            // 4. Run Pipeline Sequence
            console.log("Running Ingestion...");
            let status = await runCommand('node', ['inject_manual_scenario.mjs', '--file', tempPath]);
            if (status !== 0) { pipelineStatus = 1; rl.close(); return; }

            console.log("Running Generation (Generic Mode)...");
            status = await runCommand('node', ['2_test_generator_generic.mjs', '--pageId', 'manual']);
            if (status !== 0) { pipelineStatus = 1; rl.close(); return; } // This will now catch the SyntaxError

            // Check if clarifications are needed before continuing
            const { hasPendingClarifications, resolveClarifications } = await import('./clarification_manager.mjs');
            if (hasPendingClarifications()) {
                console.log("\n⏸️  Generation paused for clarifications...");
                await resolveClarifications();
            }

            console.log("Running Refinement & Healing (Generic Mode)...");
            pipelineStatus = await runCommand('node', ['3_qa_engineer_generic.mjs', '--pageId', 'manual']);

            if (pipelineStatus === 0) {
                console.log("\n✨ E2E Generation & Verification Complete!");
            }
        } else {
            console.log("❌ Operation cancelled.");
            rl.close();
            return;
        }
    } else if (choice === '4') {
        console.log("\n🔧 FIX EXISTING TEST MODE");
        console.log("This will regenerate an existing test with the same logic using verification & self-healing.\n");

        // 1. Ask for test name and find the file
        const testName = await rl.question("Enter the test file name to fix (e.g., verify_login.test.ts): ");
        
        // Search for the test file in the tests directory
        const testsDir = path.join(repoRoot, "tests");
        const searchDirs = [
            path.join(testsDir, "generated-from-agentFallBack"),
            testsDir
        ];
        
        let existingTestPath = "";
        for (const searchDir of searchDirs) {
            const potentialPath = path.join(searchDir, testName);
            if (fs.existsSync(potentialPath)) {
                existingTestPath = potentialPath;
                break;
            }
        }
        
        if (!existingTestPath) {
            console.error(`\n❌ Error: Test file '${testName}' not found in tests directory.`);
            console.log("Searched in:");
            searchDirs.forEach(d => console.log(`  - ${d}`));
            rl.close();
            return;
        }
        
        console.log(`✅ Found test file at: ${existingTestPath}`);

        // 2. Ask for source of truth (confluence/jira/manual/existing-test)
        console.log("\nWhat is the source of truth for this test?");
        console.log("a) Confluence Page ID");
        console.log("b) Jira Ticket Key");
        console.log("c) Manual Scenario (Text Input)");
        console.log("d) Only the existing test I gave you (no external source)");
        
        const sourceChoice = await rl.question("\nSelect source (a/b/c/d): ");
        
        let sourceId = "";
        let sourceType = "";
        
        if (sourceChoice.toLowerCase() === 'a') {
            sourceId = await rl.question("Enter Confluence Page ID: ");
            sourceType = "confluence";
        } else if (sourceChoice.toLowerCase() === 'b') {
            sourceId = await rl.question("Enter Jira Ticket Key (e.g., DN-123): ");
            sourceType = "jira";
        } else if (sourceChoice.toLowerCase() === 'c') {
            // Auto-read scenario from scenario.txt file
            if (!fs.existsSync(manualScenarioPath)) {
                console.error(`\n❌ Error: Scenario file not found at: ${manualScenarioPath}`);
                console.log("Please create the file with the following format:");
                console.log("Subject: <Your Subject>\nUser: <Role>\nSteps:\n<Your Steps>\nExpected:\n<Expected Result>");
                rl.close();
                return;
            }

            console.log(`\n📂 Reading scenario from: ${manualScenarioPath}`);
            const manualScenario = fs.readFileSync(manualScenarioPath, "utf8");

            if (!manualScenario.trim()) {
                console.error("\n❌ Error: Scenario file is empty.");
                rl.close();
                return;
            }

            console.log("\n------------------------------------------");
            console.log("🔍 REVIEW LOADED SCENARIO");
            console.log("------------------------------------------");
            console.log(manualScenario);
            console.log("------------------------------------------");

            // Save manual scenario to temp file
            const tempPath = path.join(generatedDir, "fix_test_manual_input_temp.txt");
            fs.writeFileSync(tempPath, manualScenario, "utf8");

            // Run ingestion for manual scenario
            console.log("\n📥 Running Ingestion for manual scenario...");
            const ingestStatus = await runCommand('node', ['inject_manual_scenario.mjs', '--file', tempPath]);
            if (ingestStatus !== 0) {
                console.error("❌ Manual scenario ingestion failed.");
                pipelineStatus = 1;
                rl.close();
                return;
            }

            sourceId = "manual";
            sourceType = "manual";
        } else if (sourceChoice.toLowerCase() === 'd') {
            // Use the existing test itself as source of truth
            sourceId = testName.replace(/\.test\.ts$/, "").replace(/[^a-zA-Z0-9]/g, "_");
            sourceType = "existing_test_only";
            console.log(`\nℹ️ Using existing test as source of truth (ID: ${sourceId})`);
        } else {
            console.log("❌ Invalid source choice. Exiting.");
            rl.close();
            return;
        }

        if (!sourceId) {
            console.error("❌ Error: Source ID cannot be empty.");
            rl.close();
            return;
        }

        // 3. Copy existing test to generated output directory
        const outDir = path.join(repoRoot, "tests/generated-from-agentFallBack");
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const testFileName = path.basename(existingTestPath);
        const targetFilePath = path.join(outDir, testFileName);
        
        // Copy the existing test file
        fs.copyFileSync(existingTestPath, targetFilePath);
        console.log(`\n📄 Copied existing test to: ${targetFilePath}`);

        // 4. Create metadata file for the fix flow
        const metadataPath = path.join(generatedDir, "last_generated_test.json");
        const metadata = {
            absPath: path.resolve(targetFilePath),
            fileName: testFileName,
            pageId: sourceId,
            sourceType: sourceType,
            originalPath: existingTestPath,
            mode: "fix_existing"
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
        console.log(`📎 Created metadata: ${metadataPath}`);

        // 5. Run the verification & healing loop directly (skip generation)
        console.log("\n🧪 Starting Verification & Self-Healing Loop for existing test...");
        pipelineStatus = await runCommand('node', ['4_healer.mjs', '--pageId', sourceId]);

        if (pipelineStatus === 0) {
            console.log("\n✨ Existing test fixed and verified successfully!");
        }

    } else {
        console.log("❌ Invalid choice. Exiting.");
        rl.close();
        return;
    }

    // 6. Finalization & Cleanup/Archive
    if (pipelineStatus !== 0) {
        // Log a system blocker
        const statePath = path.join(agentDir, 'task_state.json');
        let state = {};
        if (fs.existsSync(statePath)) {
            try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch(e) {}
        }
        state.bugReport = state.bugReport || { detectedBugs: [] };
        // Check if there are already bugs logged (like from healer)
        // If not, it means the pipeline crashed earlier
        const hasRealBugs = state.bugReport.detectedBugs.some(b => b.type !== 'SYSTEM_BLOCKER');
        if (!hasRealBugs) {
            state.bugReport.detectedBugs.push({
                type: "SYSTEM_BLOCKER",
                severity: "Critical",
                title: "Automation Pipeline Failure",
                description: "The agent pipeline crashed or exited prematurely (e.g. validation failed, syntax error).",
                stepsToReproduce: ["1. Run run-agent.bat", "2. Wait for pipeline failure"],
                scenario: choice === '3' ? 'manual' : 'unknown'
            });
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
        }
    }

    console.log("\n📊 Generating Final Bug Summary...");
    await runCommand('node', ['7_reporter.mjs']);

    if (pipelineStatus === 0) {
        console.log("\n✅ Pipeline Succeeded. Cleaning up 'generated/' folder...");
        playCompletionSound(true); // Success sound
        await runCommand('node', ['cleanup_generated.mjs']);
    } else {
        console.log("\n⚠️ Pipeline Failed. Archiving metadata to 'logs/failed_runs/'...");
        playCompletionSound(false); // Failure sound
        
        // Try to find the descriptive test name to pass to the archiver
        let descriptiveName = "";
        try {
            const outDir = path.join(path.resolve(process.cwd(), ".."), "tests/generated-from-agentFallBack");
            if (fs.existsSync(outDir)) {
                const files = fs.readdirSync(outDir);
                const pageId = choice === '3' ? 'manual' : 'confluence_'; // Simplified lookup
                const targetFile = files.find(f => f.includes(pageId) && f.endsWith(".test.ts"));
                if (targetFile) {
                    descriptiveName = targetFile.replace(".test.ts", "");
                }
            }
        } catch (e) {}

        const cleanupArgs = ['cleanup_generated.mjs', '--archive'];
        if (descriptiveName) {
            cleanupArgs.push('--name', descriptiveName);
        }
        await runCommand('node', cleanupArgs);
    }

    rl.close();
}

main();

// Post-process: Generate Success Summary
const metadataPath = path.join(process.cwd(), "agentFallBack/generated/last_generated_test.json");
const reportPath = path.join(process.cwd(), `agentFallBack/generated/generation_report_manual.json`);

if (fs.existsSync(metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;

    console.log("\n" + "=".repeat(50));
    console.log("🏁 PIPELINE COMPLETE - SUCCESS SUMMARY");
    console.log("=".repeat(50));
    console.log(`📄 Test File: ${metadata.fileName}`);
    console.log(`📍 Path: ${metadata.absPath}`);
    console.log(`🆔 Page ID: ${metadata.pageId}`);

    if (report) {
        console.log(`🧪 Scenarios Implemented: ${report.includedRows}`);
        console.log(`📝 Title: ${report.pageTitle}`);
    }

    console.log("\n🚀 To run this test manually, use:");
    console.log(`npx playwright test ${metadata.fileName} --headed`);
    console.log("=".repeat(50) + "\n");
}