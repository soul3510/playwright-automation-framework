// agentFallBack/inject_manual_scenario.mjs
import fs from "node:fs";
import path from "node:path";

let scenarioText = "";
const id = "manual";
const generatedDir = path.join(process.cwd(), "generated");

if (process.argv.includes('--file')) {
    const filePath = process.argv[process.argv.indexOf('--file') + 1];
    scenarioText = fs.readFileSync(path.resolve(filePath), "utf8");
} else {
    scenarioText = process.argv.slice(2).join(" ");
}

// --- ADVANCED PARSING LOGIC ---
const lines = scenarioText.split('\n');
let subject = "Manual Scenario";
let userRole = "admin";
let steps = "";
let expected = "";
let additional = "";

let currentSection = "";

for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect section headers
    if (/^Subject:/i.test(trimmed)) {
        subject = trimmed.replace(/^Subject:/i, "").trim();
        continue;
    }
    if (/^User:/i.test(trimmed)) {
        userRole = trimmed.replace(/^User:/i, "").trim();
        continue;
    }
    if (/^Steps:/i.test(trimmed)) {
        currentSection = "STEPS";
        continue;
    }
    if (/^Expected:/i.test(trimmed)) {
        currentSection = "EXPECTED";
        continue;
    }
    if (/^Additional:/i.test(trimmed)) {
        currentSection = "ADDITIONAL";
        continue;
    }

    // Append lines to the active section
    if (currentSection === "STEPS") steps += line + "\n";
    else if (currentSection === "EXPECTED") expected += line + "\n";
    else if (currentSection === "ADDITIONAL") additional += line + "\n";
}

// Create a very short identifier for the filename
const shortIdentifier = subject.split(' ').slice(0, 5).join('_');
const shortSubject = subject.length > 80 ? subject.substring(0, 80) + "..." : subject;

const scenarioObj = {
    pageId: id,
    extractedAt: new Date().toISOString(),
    scenarios: [{
        source: { from: "manual_input" },
        row: {
            Epic: null, // Let the full Subject be used for filename generation
            Scenario: steps.trim() || shortSubject,
            Subject: subject,
            Expected: expected.trim(),
            Details: scenarioText + "\n\nADDITIONAL DATA:\n" + additional.trim(),
            Additional: additional.trim()
        },
        tags: ["manual"]
    }],
    counts: { scenarios: 1 }
};

// Save structured data for downstream scripts
fs.writeFileSync(path.join(generatedDir, `page_${id}.md`), scenarioText);
fs.writeFileSync(path.join(generatedDir, `scenarios_${id}.json`), JSON.stringify(scenarioObj, null, 2));

// Update test data with the detected role
const testData = { HAPPY_PATH_USER_ROLE: userRole };
fs.writeFileSync(path.join(generatedDir, `test_data_${id}.json`), JSON.stringify(testData, null, 2));

console.log(`✅ Ingested scenario: ${shortSubject}`);
console.log(`👤 Targeted Role: ${userRole}`);