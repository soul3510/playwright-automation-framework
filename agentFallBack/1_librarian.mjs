// agent/1_librarian.mjs
// Run from: C:\Users\Public\playwright-e2e-automation\agentFallBack
// Purpose: build agent/repo_knowledge.json by scanning repo for:
// Agent: Librarian
// - user roles & fields from utils/testUsers/testUsers_beta.json
// - roles observed in tests via UserProvider.getUserByRole('...')
// - LoginPage methods (from page-objects/login/LoginPage.ts)
// - common login recipe usage patterns
// - Scan generated tests for successful selector patterns
// - Capability Map: JSDoc & method signatures
// - Dependency Mapping: Page Object to tests mapping
// - Success Pattern Mining (Golden Path): UI interactions

import fs from "node:fs";
import path from "node:path";

const agentDir = process.cwd();
const repoRoot = path.resolve(agentDir, "..");
const generatedTestsDir = path.join(repoRoot, "tests", "generated-from-agentFallBack");

// ---- helpers ----
function readText(p) {
    return fs.readFileSync(p, "utf8");
}

function exists(p) {
    try {
        fs.accessSync(p);
        return true;
    } catch {
        return false;
    }
}

function walk(dir, out = []) {
    if (!exists(dir)) return out;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        // Skip heavy folders
        if (e.isDirectory()) {
            const name = e.name.toLowerCase();
            if (name === "node_modules" || name === ".git" || name === "test-results" || name === "playwright-report") {
                continue;
            }
            walk(full, out);
        } else {
            out.push(full);
        }
    }
    return out;
}

function uniq(arr) {
    return [...new Set(arr)];
}

function rel(p) {
    return path.relative(repoRoot, p).replace(/\\/g, "/");
}

// ---- 1) Users: roles + fields ----
const usersJsonPath = path.join(repoRoot, "utils", "testUsers", "testUsers_beta.json");

function loadUsersKnowledge() {
    const knowledge = {
        source: exists(usersJsonPath) ? rel(usersJsonPath) : null,
        roles: [],
        invalidUserRole: null,
        fields: [],
        sample: null,
    };

    if (!exists(usersJsonPath)) return knowledge;

    try {
        const raw = JSON.parse(readText(usersJsonPath));
        let users = [];
        if (Array.isArray(raw)) users = raw;
        else if (Array.isArray(raw.users)) users = raw.users;
        else if (raw && typeof raw === "object") {
            const maybeUsers = Object.entries(raw)
                .filter(([k, v]) => v && typeof v === "object" && !Array.isArray(v))
                .map(([k, v]) => ({ role: v.role || k, ...v }));
            const withCreds = maybeUsers.filter(u => u.username || u.email || u.password).length;
            if (withCreds >= Math.max(1, Math.floor(maybeUsers.length * 0.5))) users = maybeUsers;
        }

        const roles = [];
        const fieldsSet = new Set();

        for (const u of users) {
            if (!u || typeof u !== "object") continue;
            if (u.role) roles.push(String(u.role));
            for (const k of Object.keys(u)) fieldsSet.add(k);
        }

        knowledge.roles = uniq(roles).sort();
        knowledge.fields = [...fieldsSet].sort();
        knowledge.sample = users[0] || null;

        const invalid = users.find(u => String(u.role || "").toLowerCase() === "invalid")
            || users.find(u => u && typeof u === "object" && "errorMessage" in u);
        knowledge.invalidUserRole = invalid?.role ? String(invalid.role) : null;
    } catch (e) {
        console.warn("Failed to parse users json:", e.message);
    }

    return knowledge;
}

// ---- 2) Scan tests for getUserByRole('...') ----
function scanRolesFromTests(allFiles) {
    const roles = [];
    const regex = /getUserByRole\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

    for (const f of allFiles) {
        if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
        const rf = rel(f);
        if (!(rf.startsWith("tests/") || rf.startsWith("utils/") || rf.startsWith("page-objects/"))) continue;

        const txt = readText(f);
        let m;
        while ((m = regex.exec(txt)) !== null) {
            roles.push(m[1]);
        }
    }

    return uniq(roles).sort();
}

// ---- 3) Extract LoginPage class + methods ----
const loginPagePath = path.join(repoRoot, "page-objects", "login", "LoginPage.ts");

function extractLoginPageKnowledge() {
    const out = {
        path: exists(loginPagePath) ? rel(loginPagePath) : null,
        className: "LoginPage",
        methods: [],
    };

    if (!exists(loginPagePath)) return out;

    const txt = readText(loginPagePath);
    const classMatch = txt.match(/export\s+class\s+(\w+)/) || txt.match(/class\s+(\w+)/);
    if (classMatch) out.className = classMatch[1];

    const methodRegex = /\n\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/g;
    const ignore = new Set(["constructor", "if", "for", "while", "switch", "catch", "function"]);
    const methods = [];

    let m;
    while ((m = methodRegex.exec(txt)) !== null) {
        const name = m[1];
        if (!ignore.has(name)) methods.push(name);
    }

    out.methods = uniq(methods).sort();
    return out;
}

// ---- 4) Learn “login recipe” by scanning existing tests ----
function inferLoginRecipe(allFiles) {
    const recipeCalls = [];
    const filesUsingLoginPage = [];

    for (const f of allFiles) {
        if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
        const rf = rel(f);
        if (!rf.startsWith("tests/")) continue;

        const txt = readText(f);
        if (!txt.includes("new LoginPage(")) continue;

        filesUsingLoginPage.push(rf);
        const varMatches = [...txt.matchAll(/const\s+(\w+)\s*=\s*new\s+LoginPage\s*\(/g)].map(m => m[1]);

        for (const v of varMatches) {
            const calls = [...txt.matchAll(new RegExp(`\\b${v}\\.([a-zA-Z0-9_]+)\\s*\\(`, "g"))].map(m => m[1]);
            if (calls.length) recipeCalls.push(calls);
        }
    }

    const likelySteps = ["resetSession", "navigateToLoginPage", "login", "expectLoginSuccess"];
    const score = (calls) => likelySteps.filter(s => calls.includes(s)).length;

    const best = recipeCalls
        .map(calls => ({ calls, score: score(calls) }))
        .sort((a, b) => b.score - a.score)[0];

    const preferred = best?.calls
        ? likelySteps.filter(s => best.calls.includes(s))
        : likelySteps;

    return {
        filesUsingLoginPage: uniq(filesUsingLoginPage).slice(0, 20),
        preferredPattern: preferred,
    };
}

// ---- 5) Conventions: tags + common imports ----
function inferConventions(allFiles) {
    const tagRegex = /tag\s*:\s*\[([^\]]+)\]/g;
    const tags = [];
    const usesAtPlaywrightTest = [];
    const usesMyFixtures = [];

    for (const f of allFiles) {
        if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
        const rf = rel(f);
        if (!rf.startsWith("tests/")) continue;

        const txt = readText(f);
        if (txt.includes("from '@playwright/test'")) usesAtPlaywrightTest.push(rf);
        if (txt.includes("from 'page-objects/myFixtures'")) usesMyFixtures.push(rf);

        let m;
        while ((m = tagRegex.exec(txt)) !== null) {
            const inner = m[1];
            const parts = inner.split(",").map(p => p.trim().replace(/^['"`]|['"`]$/g, "")).filter(Boolean);
            tags.push(...parts);
        }
    }

    return {
        testFrameworkImport: usesMyFixtures.length > usesAtPlaywrightTest.length ? "page-objects/myFixtures" : "@playwright/test",
        tagsObservedTop: uniq(tags).sort().slice(0, 50),
        sampleFiles: {
            usesPlaywrightTest: usesAtPlaywrightTest.slice(0, 10),
            usesMyFixtures: usesMyFixtures.slice(0, 10),
        },
    };
}

// ---- 6) Scan Generated Tests for Selectors ----
function scanGeneratedSelectors() {
    if (!exists(generatedTestsDir)) return { commonSelectors: [], commonLocators: [] };

    const files = fs.readdirSync(generatedTestsDir).filter(f => f.endsWith(".ts"));
    const selectors = [];
    const locators = [];

    for (const file of files) {
        const txt = readText(path.join(generatedTestsDir, file));

        // Extract page.locator('...') calls
        const locMatches = [...txt.matchAll(/page\.locator\(['"`]([^'"`]+)['"`]\)/g)];
        locators.push(...locMatches.map(m => m[1]));

        // Extract page.getByRole('...', { name: '...' }) calls
        const roleMatches = [...txt.matchAll(/page\.getByRole\(['"`]([^'"`]+)['"`],\s*\{[^}]*name:\s*['"`]([^'"`]+)['"`]/g)];
        selectors.push(...roleMatches.map(m => `${m[1]}[name="${m[2]}"]`));
    }

    // Count frequency
    const count = (arr) => {
        const m = new Map();
        for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(e => ({ selector: e[0], count: e[1] }));
    };

    return {
        commonSelectors: count(selectors),
        commonLocators: count(locators)
    };
}

// ---- 7) Impact Analysis (Page Object Usage) ----
function analyzePageObjectUsage(allFiles) {
    const usage = {};
    const pageObjects = allFiles.filter(f => f.includes('page-objects') && f.endsWith('.ts'));
    
    for (const po of pageObjects) {
        const poName = path.basename(po, '.ts');
        usage[poName] = { path: rel(po), count: 0, usedIn: [] };
    }

    const testFiles = allFiles.filter(f => f.includes('tests') && (f.endsWith('.ts') || f.endsWith('.tsx')));
    
    for (const f of testFiles) {
        const rf = rel(f);
        const txt = readText(f);
        
        for (const poName of Object.keys(usage)) {
            // Very basic heuristic: check if the PO name is imported or instantiated
            if (txt.includes(poName)) {
                usage[poName].count++;
                usage[poName].usedIn.push(rf);
            }
        }
    }
    
    // Sort and cleanup
    const result = {};
    for (const [name, data] of Object.entries(usage)) {
        if (data.count > 0 || name.includes('AccessGroup')) {
            result[name] = { count: data.count, usedIn: data.usedIn, path: data.path };
        }
    }
    return { result, poFiles: pageObjects.map(rel) };
}

// ---- 8) NEW: Capability Map (Parse JSDoc and methods from all POs) ----
function buildCapabilityMap(allFiles) {
    const capabilityMap = {};
    const pageObjects = allFiles.filter(f => f.includes('page-objects') && f.endsWith('.ts'));
    
    // Regex for: optional JSDoc, optional modifiers, method name, args
    const methodRegex = /(?:(\/\*\*[\s\S]*?\*\/)\s*)?(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g;
    const ignore = new Set(["constructor", "if", "for", "while", "switch", "catch", "function", "super"]);

    for (const po of pageObjects) {
        const poName = path.basename(po, '.ts');
        const txt = readText(po);
        const methods = [];
        
        let m;
        while ((m = methodRegex.exec(txt)) !== null) {
            const jsdoc = m[1] ? m[1].replace(/\n\s*\*\s?/g, " ").trim() : null; // simplify JSDoc
            const name = m[2];
            const args = m[3].replace(/\s+/g, ' ').trim();
            if (!ignore.has(name) && !methods.some(x => x.name === name)) {
                methods.push({ name, args, jsdoc });
            }
        }
        
        if (methods.length > 0) {
            capabilityMap[poName] = {
                path: rel(po),
                methods: methods
            };
        }
    }
    return capabilityMap;
}

// ---- 9) NEW: Success Pattern Mining (Golden Path) ----
function mineSuccessPatterns(allFiles) {
    const patterns = {
        tables: [],
        datePickers: [],
        dropdowns: []
    };
    
    const testFiles = allFiles.filter(f => f.includes('tests') && (f.endsWith('.ts') || f.endsWith('.tsx')));
    
    for (const f of testFiles) {
        const txt = readText(f);
        const lines = txt.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Look for table interactions
            if (line.match(/getByRole\(['"`]row['"`]/) || line.match(/getByRole\(['"`]table['"`]/) || line.match(/\.locator\(['"`]table['"`]/) || line.match(/\.locator\(['"`]tr['"`]/)) {
                const snippet = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).map(l => l.trim()).filter(Boolean).join('\n');
                if (snippet.length > 10 && !patterns.tables.includes(snippet)) {
                    patterns.tables.push(snippet);
                }
            }
            
            // Look for date picker interactions
            if (line.match(/getByRole\(['"`]button['"`].*name:.*(?:date|calendar|picker)/i) || line.match(/locator\(['"`].*calendar.*['"`]/i) || line.match(/locator\(['"`].*date.*['"`]/i)) {
                const snippet = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).map(l => l.trim()).filter(Boolean).join('\n');
                if (snippet.length > 10 && !patterns.datePickers.includes(snippet)) {
                    patterns.datePickers.push(snippet);
                }
            }
            
            // Look for dropdown/combobox
            if (line.match(/getByRole\(['"`]combobox['"`]/) || line.match(/getByRole\(['"`]listbox['"`]/)) {
                const snippet = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).map(l => l.trim()).filter(Boolean).join('\n');
                if (snippet.length > 10 && !patterns.dropdowns.includes(snippet)) {
                    patterns.dropdowns.push(snippet);
                }
            }
        }
    }
    
    // Deduplicate and limit to top 10 most illustrative snippets
    return {
        tables: patterns.tables.slice(0, 10),
        datePickers: patterns.datePickers.slice(0, 10),
        dropdowns: patterns.dropdowns.slice(0, 10)
    };
}

// ---- main ----
function main() {
    const allFiles = walk(repoRoot);

    const users = loadUsersKnowledge();
    const rolesObserved = scanRolesFromTests(allFiles);
    const loginPage = extractLoginPageKnowledge();
    const loginRecipe = inferLoginRecipe(allFiles);
    const conventions = inferConventions(allFiles);
    const generatedStats = scanGeneratedSelectors();
    const { result: poUsage, poFiles } = analyzePageObjectUsage(allFiles);
    const capabilityMap = buildCapabilityMap(allFiles);
    const goldenPatterns = mineSuccessPatterns(allFiles);

    // ---- Extract Lessons Learned from task_state.json ----
    const statePath = path.join(agentDir, 'task_state.json');
    let state = {};
    if (exists(statePath)) {
        try {
            state = JSON.parse(readText(statePath));
        } catch(e) {}
    }
    const lessonsLearned = state.healer?.lessonsLearned || [];

    const knowledge = {
        generatedAt: new Date().toISOString(),
        repoRoot: repoRoot.replace(/\\/g, "/"),
        users: {
            ...users,
            rolesObservedInTests: rolesObserved,
            rolesUnion: uniq([...(users.roles || []), ...rolesObserved]).sort(),
        },
        login: {
            pageObject: loginPage.className,
            path: loginPage.path,
            methods: loginPage.methods,
            preferredPattern: loginRecipe.preferredPattern,
            evidenceFiles: loginRecipe.filesUsingLoginPage,
        },
        conventions,
        generatedInsights: generatedStats,
        pageObjectUsage: poUsage,
        capabilityMap,
        goldenPatterns,
        lessonsLearned
    };

    const outPath = path.join(agentDir, "repo_knowledge.json");
    fs.writeFileSync(outPath, JSON.stringify(knowledge, null, 2), "utf8");

    // ---- Update po_shortcuts.json ----
    const poShortcutsPath = path.join(agentDir, "po_shortcuts.json");
    let shortcuts = {};
    if (exists(poShortcutsPath)) {
        try {
            shortcuts = JSON.parse(readText(poShortcutsPath));
        } catch(e) {}
    }
    shortcuts["Access Group"] = uniq([...(shortcuts["Access Group"] || []), "AccessGroupDetailsPage"]);
    fs.writeFileSync(poShortcutsPath, JSON.stringify(shortcuts, null, 2), "utf8");
    console.log("Updated:", poShortcutsPath);

    // ---- Update task_state.json ----
    state.currentAgent = 'librarian';
    state.librarian = {
        availablePageObjects: poFiles,
        userRoles: users.roles,
        conventions: conventions,
        pageObjectUsage: poUsage,
        repoKnowledgePath: outPath,
        completed: true,
        completedAt: new Date().toISOString()
    };
    state.logs = state.logs || [];
    state.logs.push({
        agent: 'librarian',
        timestamp: new Date().toISOString(),
        message: `Scanned ${poFiles.length} page objects, ${users.roles.length} user roles, ${Object.keys(poUsage).length} PO usage patterns, ${Object.keys(capabilityMap).length} capabilities mapped`
    });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    console.log("Updated task_state.json");

    console.log("\n**********************************************");
    console.log("Librarian finished.");
    console.log("**********************************************");
    console.log("\nSaved:", outPath);
    console.log("Users roles (from json):", users.roles.length);
    console.log("Roles observed in tests:", rolesObserved.length);
    console.log("LoginPage methods:", loginPage.methods.length);
    console.log("Preferred login pattern:", knowledge.login.preferredPattern.join(" → "));
    console.log("Convention import:", conventions.testFrameworkImport);
    console.log("Common Generated Locators:", generatedStats.commonLocators.length);
    console.log("Mapped Capabilities for POs:", Object.keys(capabilityMap).length);
    console.log(`Golden Patterns Minned: ${goldenPatterns.tables.length} tables, ${goldenPatterns.datePickers.length} dates, ${goldenPatterns.dropdowns.length} dropdowns`);
}

main();
