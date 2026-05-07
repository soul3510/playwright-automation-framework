// agent/3_qa_engineer_generic.mjs
// Agent: QA Engineer - Generic Version
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";

const agentDir = process.cwd();
const repoRoot = path.resolve(agentDir, "..");
const generatedDir = path.join(agentDir, "generated");

// Load generic configuration
const genericConfigPath = path.join(agentDir, "generic-config.json");
let genericConfig = {};
if (fs.existsSync(genericConfigPath)) {
    genericConfig = JSON.parse(fs.readFileSync(genericConfigPath, "utf8"));
}

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

const promptPath = path.join(generatedDir, `prompt_for_llm_${effectivePageId}.txt`);

// Generic mode: Skip page object validation if configured
function isGenericMode() {
    return genericConfig.genericMode === true || process.env.GENERIC_MODE === "true";
}

// Load Page Object map only if not in generic mode
let poMap = [];
if (!isGenericMode()) {
    const pageObjectsPath = path.join(repoRoot, "page-objects");
    function scanPageObjects(dir, fileList = [], baseDir = null) {
        if (!fs.existsSync(dir)) return fileList;
        const currentBase = baseDir || dir;
        const files = fs.readdirSync(dir);
        files.forEach((file) => {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
                scanPageObjects(filePath, fileList, currentBase);
            } else if (file.endsWith(".ts")) {
                const content = fs.readFileSync(filePath, "utf8");
                const className = (content.match(/class\s+(\w+)/) || [])[1];
                if (className) {
                    const relativePath = path.relative(path.join(repoRoot, "page-objects"), filePath);
                    const importPath = relativePath.replace(/\.ts$/, "").replace(/\\/g, "/");
                    const methods = [];
                    const methodRegex = /(?:\/\*\*\s*([\s\S]*?)\s*\*\/)?\s*async\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^\{]+))?/g;
                    let match;
                    while ((match = methodRegex.exec(content)) !== null) {
                        const [, jsdoc, methodName, params, returnType] = match;
                        methods.push({
                            name: methodName,
                            params: params ? params.trim() : "",
                            returnType: returnType ? returnType.trim() : "void",
                            jsdoc: jsdoc ? jsdoc.replace(/\s*\*\s?/g, " ").trim() : ""
                        });
                    }
                    fileList.push({
                        className,
                        importPath,
                        filePath: path.relative(repoRoot, filePath),
                        methods
                    });
                }
            }
        });
        return fileList;
    }
    poMap = scanPageObjects(pageObjectsPath);
    console.log(`📚 Loaded ${poMap.length} Page Objects for validation`);
}

async function callGemini(prompt) {
    return new Promise((resolve, reject) => {
        const hasApiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY);
        if (!hasApiKey) {
            console.log("ℹ️ No Gemini API key found. Skipping AI enhancement and keeping generated code.");
            resolve("");
            return;
        }

        let child;
        try {
            child = spawn(process.execPath, [path.join(agentDir, "gemini-cli.js")], {
                shell: true,
                env: {
                    ...process.env,
                    GOOGLE_CLOUD_PROJECT: "codeassist-preview"
                }
            });
        } catch (err) {
            console.warn(`⚠️ Gemini enhancement unavailable: ${err.message}`);
            resolve("");
            return;
        }
        
        let fullOutput = "";
        child.stdin.write(prompt);
        child.stdin.end();

        child.stdout.on("data", (data) => {
            fullOutput += data.toString();
            process.stdout.write(".");
        });

        child.on("close", (code) => {
            resolve(fullOutput);
        });

        child.on("error", (err) => {
            console.warn(`⚠️ Gemini enhancement unavailable: ${err.message}`);
            resolve("");
        });
    });
}

// Generic validation: Only validate if not in generic mode or if fallback is disabled
function validatePageObjectUsage(code, poMap) {
    if (isGenericMode() && genericConfig.fallbackToRawLocators) {
        console.log("🔄 Generic Mode: Skipping Page Object validation, allowing raw locators");
        return { violations: [], hasViolations: false };
    }

    console.log("🔍 Pre-flight PO Validation: Checking for raw locators that should use PO methods...");
    
    const violations = [];
    const lines = code.split('\n');
    
    // Patterns that indicate raw locator usage
    const rawLocatorPatterns = [
        { regex: /page\.locator\(['"]([^'"]+)['"]\)\.click/, name: 'click', action: 'click' },
        { regex: /page\.locator\(['"]([^'"]+)['"]\)\.fill/, name: 'fill', action: 'fill' },
        { regex: /page\.getByText\(['"]([^'"]+)['"]\).*\.click/, name: 'getByText+click', action: 'click' },
        { regex: /page\.getByRole\(['"]([^'"]+)['"]\).*\.click/, name: 'getByRole+click', action: 'click' },
        { regex: /page\.getByLabel\(['"]([^'"]+)['"]\).*\.click/, name: 'getByLabel+click', action: 'click' },
    ];
    
    // Build a map of available PO methods for quick lookup
    const availableMethods = new Map();
    for (const po of poMap) {
        for (const method of po.methods || []) {
            const methodName = method.name.toLowerCase();
            if (!availableMethods.has(methodName)) {
                availableMethods.set(methodName, []);
            }
            availableMethods.get(methodName).push({
                className: po.className,
                method: method,
                importPath: po.importPath
            });
        }
    }
    
    // Check each line for violations
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const lineNum = i + 1;
        
        for (const pattern of rawLocatorPatterns) {
            const match = line.match(pattern.regex);
            if (match) {
                const selectorOrText = match[1];
                
                // Check if a PO method likely exists for this action
                const possibleMethods = [];
                for (const [methodName, poList] of availableMethods) {
                    if (pattern.action === 'click' && 
                        (methodName.includes('click') || methodName.includes('select') || methodName.includes('open'))) {
                        possibleMethods.push(...poList);
                    } else if (pattern.action === 'fill' && 
                             (methodName.includes('fill') || methodName.includes('set') || methodName.includes('enter'))) {
                        possibleMethods.push(...poList);
                    }
                }
                
                if (possibleMethods.length === 0) {
                    violations.push({
                        line: lineNum,
                        content: line,
                        pattern: pattern.name,
                        selector: selectorOrText,
                        suggestion: "No matching PO method found"
                    });
                }
            }
        }
    }
    
    return { violations, hasViolations: violations.length > 0 };
}

function normalizeForComparison(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractPrimaryTestIdentity(code, fallbackFileName = "") {
    const describeMatch = code.match(/test\.describe\(\s*['"`]([^'"`]+)['"`]/);
    const testMatch = code.match(/\btest\(\s*['"`]([^'"`]+)['"`]/);
    const annotationMatch = code.match(/type:\s*['"`]Description['"`]\s*,\s*description:\s*['"`]([^'"`]+)['"`]/);
    return [
        describeMatch?.[1],
        testMatch?.[1],
        annotationMatch?.[1],
        fallbackFileName.replace(/\.test\.ts$/i, "")
    ].filter(Boolean);
}

function isLikelyStaleAiRewrite(originalCode, enhancedCode, targetFileName) {
    const originalIds = extractPrimaryTestIdentity(originalCode, targetFileName)
        .map(normalizeForComparison)
        .filter(Boolean);
    const enhancedNormalized = normalizeForComparison(enhancedCode);
    const hasOriginalIdentity = originalIds.some(id => id.length >= 8 && enhancedNormalized.includes(id));
    const hasKnownMockScenario = /Test_sign_in_button|unbounce\.com|best-landing-page-examples|sign_in/i.test(enhancedCode);

    return !hasOriginalIdentity || (hasKnownMockScenario && !/Test_sign_in_button/i.test(originalCode));
}

// Generic clarification manager
class GenericClarificationManager {
    constructor() {
        this.clarifications = [];
    }

    addClarification(type, question, hint = "") {
        this.clarifications.push({
            type,
            question,
            hint,
            answer: null
        });
    }

    hasPending() {
        return this.clarifications.filter(c => c.answer === null).length > 0;
    }

    async resolveClarifications() {
        if (!this.hasPending()) return;

        console.log("\n" + "=".repeat(60));
        console.log("🤖 AGENT NEEDS MORE INFORMATION TO CONTINUE");
        console.log("=".repeat(60));
        console.log("🔔 Sound notification played - check the terminal!\n");

        const readline = await import('readline/promises');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        for (const clarification of this.clarifications.filter(c => c.answer === null)) {
            console.log(`❓ ${clarification.type}: ${clarification.question}`);
            if (clarification.hint) {
                console.log(`   💡 Hint: ${clarification.hint}`);
            }
            console.log(`   (Press Enter to skip if you're unsure)`);
            
            const answer = await rl.question("> ");
            clarification.answer = answer.trim() || null;
            console.log("");
        }

        rl.close();
    }

    getClarificationsForPrompt() {
        return this.clarifications.filter(c => c.answer !== null && c.answer !== "");
    }
}

async function main() {
    console.log("**********************************************");
    console.log("QA Engineer (Generic Mode) is now starting to work...");
    console.log("**********************************************");

    // Load the most recently generated test file
    const metadataPath = path.join(generatedDir, "last_generated_test.json");
    let targetFile = "";
    
    if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        targetFile = metadata.absPath;
    } else {
        // Fallback: find the most recent .test.ts file
        const outDir = path.join(repoRoot, "tests/generated-from-agentFallBack");
        if (fs.existsSync(outDir)) {
            const files = fs.readdirSync(outDir).filter(f => f.endsWith(".test.ts"));
            if (files.length > 0) {
                targetFile = path.join(outDir, files[files.length - 1]);
            }
        }
    }
    
    if (!fs.existsSync(targetFile)) {
        console.error(`❌ Target test file not found: ${targetFile}`);
        process.exit(1);
    }

    let code = fs.readFileSync(targetFile, "utf8");
    const originalCode = code;
    console.log(`📄 Loaded test file: ${targetFile}`);
    console.log(`📏 File size: ${code.length} characters`);

    // Generic validation
    const validation = validatePageObjectUsage(code, poMap);
    const clarificationManager = new GenericClarificationManager();

    if (validation.hasViolations) {
        console.log(`\n❓ Clarification requested: Raw Locator Usage`);
        console.log(`   Found ${validation.violations.length} instances of raw locators that could use Page Objects.`);
        console.log(`   In generic mode, these are acceptable but could be improved.`);
        
        if (!isGenericMode()) {
            clarificationManager.addClarification(
                "Raw Locator Usage",
                `Found ${validation.violations.length} raw locators. Should these be converted to Page Objects or kept as-is?`,
                "Options: 'convert' (to PO), 'keep' (as raw locators), or 'mixed'"
            );
        }
    }

    // Generic pattern analysis
    const genericPatterns = analyzeGenericPatterns(code);
    if (genericPatterns.needsClarification) {
        clarificationManager.addClarification(
            "Generic Pattern Detection",
            "What type of application are we testing? This helps generate better selectors.",
            "Options: 'web-app', 'mobile-web', 'desktop-web', 'spa', 'mpa', or 'other'"
        );
    }

    // Resolve clarifications if needed
    if (clarificationManager.hasPending()) {
        await clarificationManager.resolveClarifications();
    }

    // Generate enhanced prompt with generic knowledge
    let enhancedPrompt = fs.readFileSync(promptPath, "utf8");
    
    if (isGenericMode()) {
        enhancedPrompt += `

GENERIC MODE INSTRUCTIONS:
- You are working in generic mode - no specific Page Objects required
- Use standard Playwright locators and best practices
- Prefer semantic selectors: getByRole, getByLabel, getByText
- Use universal selector patterns when needed
- Focus on clear, maintainable test code

UNIVERSAL SELECTOR PATTERNS:
${JSON.stringify(genericConfig.universalSelectors || {}, null, 2)}

COMMON TEST PATTERNS:
${JSON.stringify(genericConfig.testPatterns || {}, null, 2)}

GENERIC USER ROLES:
${JSON.stringify(genericConfig.genericUserRoles || [], null, 2)}
`;
    }

    // Add clarifications to prompt
    const clarifications = clarificationManager.getClarificationsForPrompt();
    if (clarifications.length > 0) {
        enhancedPrompt += "\n\nCLARIFICATIONS PROVIDED:\n";
        clarifications.forEach(c => {
            enhancedPrompt += `- ${c.type}: ${c.answer}\n`;
        });
    }

    console.log("\n🤖 Running Generic AI Enhancement...");
    let fullAiResponse = await callGemini(enhancedPrompt);
    
    // Save response for debugging
    fs.writeFileSync(path.join(generatedDir, "debug_generic_ai_response.txt"), fullAiResponse, "utf8");
    
    // Extract and apply the enhanced code
    const markerRegex = /```(?:typescript|ts)?\s*\n([\s\S]*?)```/g;
    const blocks = [...fullAiResponse.matchAll(markerRegex)];
    
    if (blocks.length > 0) {
        const enhancedCode = blocks[0][1].trim();
        if (isLikelyStaleAiRewrite(originalCode, enhancedCode, path.basename(targetFile))) {
            console.log("⚠️ AI enhancement did not match the current scenario. Keeping the generated scenario-specific test.");
        } else {
            fs.writeFileSync(targetFile, enhancedCode, "utf8");
            console.log(`✨ Enhanced test file saved: ${targetFile}`);
        }
    } else {
        console.log("⚠️ No enhanced code found in AI response");
    }

    console.log("**********************************************");
    console.log("QA Engineer (Generic Mode) finished.");
    console.log("**********************************************");
}

// Generic pattern analysis
function analyzeGenericPatterns(code) {
    const patterns = {
        hasLogin: /login|password|username/i.test(code),
        hasNavigation: /navigate|click.*link|goto/i.test(code),
        hasForms: /fill|input|form|submit/i.test(code),
        hasTables: /table|row|column|cell/i.test(code),
        needsClarification: false
    };

    // If no clear patterns detected, ask for clarification
    const patternCount = Object.values(patterns).filter(Boolean).length;
    if (patternCount === 0) {
        patterns.needsClarification = true;
    }

    return patterns;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
