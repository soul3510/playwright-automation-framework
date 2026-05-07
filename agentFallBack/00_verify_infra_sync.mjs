// agent/00_verify_infra_sync.mjs
import fs from 'node:fs';
import path from 'node:path';

const agentDir = process.cwd();
const files = {
    knowledge: path.join(agentDir, 'repo_knowledge.json'),
    shortcuts: path.join(agentDir, 'po_shortcuts.json'),
    conventions: path.join(agentDir, 'repo_conventions.json')
};

function verify() {
    console.log("🔍 Starting Infra Sanity Check...");

    for (const [name, p] of Object.entries(files)) {
        if (!fs.existsSync(p)) {
            console.error(`❌ MISSING: ${name} at ${p}. Run 1_librarian.mjs first.`);
            return;
        }
    }

    const kn = JSON.parse(fs.readFileSync(files.knowledge));
    const sh = JSON.parse(fs.readFileSync(files.shortcuts));

    // Check 1: Import Consistency
    console.log(`✅ Framework Import: ${kn.conventions?.testFrameworkImport || 'NOT SET'}`);

    // Check 2: Shortcut Mapping
    const shortcutKeys = Object.keys(sh);
    console.log(`✅ Shortcuts Loaded: ${shortcutKeys.length} items`);

    // Check 3: User Roles
    if (!kn.users?.rolesUnion?.length) {
        console.error("❌ ERROR: No user roles detected in knowledge base.");
    } else {
        console.log(`✅ User Roles Sync: ${kn.users.rolesUnion.length} roles ready.`);
    }

    console.log("🚀 INFRA SYNCED. Ready for E2E Generation.");
}

verify();