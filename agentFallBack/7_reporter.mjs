// agent/7_reporter.mjs
// Agent: Final Bug & Status Reporter
import fs from "node:fs";
import path from "node:path";

const agentDir = process.cwd();
const statePath = path.join(agentDir, 'task_state.json');

if (!fs.existsSync(statePath)) {
    console.error("❌ task_state.json not found.");
    process.exit(1);
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

console.log("\n🏁 Agent Execution Complete");

const healingAttempts = state.healer?.healingAttempts || 0;
const lessonsLearnedCount = state.healer?.lessonsLearned?.length || 0;
console.log(`🛠 Tests Healed: ${lessonsLearnedCount} (Locators updated in ${healingAttempts} attempts)`);

const detectedBugs = state.bugReport?.detectedBugs || [];
console.log(`🐛 Real Bugs Found: ${detectedBugs.length}\n`);

if (detectedBugs.length > 0) {
    detectedBugs.forEach((bug, index) => {
        console.log(`--- Bug #${index + 1}: ${bug.title || 'Untitled Issue'} ---`);
        console.log(`Type: ${bug.type}`);
        console.log(`Severity: ${bug.severity || 'Unknown'}`);
        console.log(`Description: ${bug.description}`);
        
        if (bug.stepsToReproduce && Array.isArray(bug.stepsToReproduce)) {
            console.log(`Steps to Reproduce:`);
            bug.stepsToReproduce.forEach(step => console.log(`  ${step}`));
        } else if (bug.stepsToReproduce) {
            console.log(`Steps to Reproduce: ${bug.stepsToReproduce}`);
        }

        if (bug.pageLink) console.log(`Page Link: ${bug.pageLink}`);
        if (bug.scenario) console.log(`Affected Scenario: ${bug.scenario}`);
        if (bug.evidence) console.log(`Evidence: ${bug.evidence}`);
        console.log("------------------\n");
    });
}

console.log("Logs: See task_state.json logs for details.");
