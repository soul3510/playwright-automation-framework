// agent/3_qa_engineer.mjs
// Agent: QA Engineer
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

const promptPath = path.join(generatedDir, `prompt_for_llm_${effectivePageId}.txt`);

// Load Page Object map for pre-flight validation
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
const poMap = scanPageObjects(pageObjectsPath);
console.log(`📚 Loaded ${poMap.length} Page Objects for validation`);

async function callGemini(prompt) {
    return new Promise((resolve, reject) => {
        const child = spawn("gemini", [], { 
            shell: true,
            env: {
                ...process.env,
                GOOGLE_CLOUD_PROJECT: "codeassist-preview"
            }
        });
        
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

        child.on("error", (err) => reject(err));
    });
}

// Pre-flight PO Validation: Detects raw locators that should use Page Object methods
function validatePageObjectUsage(code, poMap) {
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
            // Map common action patterns to method names
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
                // Look for methods with similar names (select*, click*, open*, navigate*)
                const possibleMethods = [];
                for (const [methodName, poList] of availableMethods) {
                    // Check if this action pattern matches
                    if (pattern.action === 'click' && 
                        (methodName.includes('select') || methodName.includes('click') || 
                         methodName.includes('open') || methodName.includes('navigate'))) {
                        possibleMethods.push(...poList.slice(0, 2));
                    }
                }
                
                if (possibleMethods.length > 0) {
                    violations.push({
                        line: lineNum,
                        code: line.substring(0, 80),
                        selector: selectorOrText,
                        suggestedPOs: possibleMethods.map(p => `${p.className}.${p.method.name}()`).slice(0, 3)
                    });
                }
            }
        }
    }
    
    if (violations.length > 0) {
        console.log(`\n🚫 PO VALIDATION FAILED: Found ${violations.length} raw locator(s) that should use Page Object methods:\n`);
        violations.forEach((v, idx) => {
            console.log(`  ${idx + 1}. Line ${v.line}: ${v.code}...`);
            console.log(`     Selector/Text: "${v.selector}"`);
            console.log(`     💡 Consider using: ${v.suggestedPOs.join(' or ')}\n`);
        });
        return {
            valid: false,
            violations: violations,
            message: violations.map(v => `Line ${v.line}: Raw locator "${v.selector}" - use ${v.suggestedPOs[0]}`).join('; ')
        };
    }
    
    console.log("✅ PO Validation passed: No obvious raw locator violations found");
    return { valid: true, violations: [] };
}

function validateRollbackPresence(code) {
    console.log("🔍 Validating Smart Rollback presence...");
    
    // Identify Intent - Check if there are destructive actions in the code (or comments)
    // To avoid false positives on simple words, we look for them in context or step logs
    const creationKeywords = /STEP:.*?\b(create|add|assign|insert|edit)\b/i;
    const hasDestructiveAction = creationKeywords.test(code) || /\.(add|create|assign|insert|edit)[A-Z]/i.test(code);
    
    if (!hasDestructiveAction) {
        console.log("✅ Rollback Validation: No destructive actions detected. Rollback not required.");
        return { valid: true, required: false };
    }
    
    // Check for finally block
    const hasFinally = /\bfinally\s*\{/i.test(code);
    if (!hasFinally) {
        const warning = "⚠️ ROLLBACK MISSING: Creation detected without a 'finally' block for cleanup.";
        console.log(`\n🚫 ROLLBACK VALIDATION FAILED: ${warning}`);
        return { valid: false, required: true, warning };
    }
    
    // Extract finally block content by getting everything from the 'finally' keyword onwards
    const finallyIndex = code.toLowerCase().lastIndexOf("finally");
    const finallyContent = finallyIndex !== -1 ? code.substring(finallyIndex) : "";
    
    // Check for cleanup logic in finally block. Allow variables passed to query()
    const hasCleanup = (/query\s*\(/i.test(finallyContent) && /(DELETE|UPDATE)\b/i.test(finallyContent)) || 
                       /\.(deactivate|remove|delete|cleanup)\w*\(/i.test(finallyContent);
                       
    if (!hasCleanup) {
        const warning = "⚠️ ROLLBACK MISSING: 'finally' block found, but no database query (DELETE/UPDATE) or Page Object cleanup method detected inside it.";
        console.log(`\n🚫 ROLLBACK VALIDATION FAILED: ${warning}`);
        return { valid: false, required: true, warning };
    }
    
    console.log("✅ Rollback Validation passed: Cleanup logic found in 'finally' block.");
    return { valid: true, required: true };
}

function validateImplementation(code) {
    if (!code) return false;

    console.log("🔍 Validating extracted code...");
    
    // Remove common AI chatter and explanations
    let cleanCode = code
        .replace(/Here['']s\s+the\s+(implementation|code|test)[:]?[^\n]*\n?/gi, '')
        .replace(/I['']ve\s+(created|written|updated)[^\n]*\n?/gi, '')
        .replace(/The\s+(above|following)\s+code[^\n]*\n?/gi, '')
        .replace(/This\s+(test|implementation)[^\n]*\n?/gi, '')
        .trim();

    // Look for markers using a case-insensitive, whitespace-agnostic search
    const startMarker = "// AI_IMPLEMENTATION_START";
    const endMarker = "// AI_IMPLEMENTATION_END";

    let block = cleanCode;
    const markerRegex = /(?:\/\/\s*)?AI_IMPLEMENTATION_START(?:\s*\*\/)?\s*([\s\S]*?)\s*(?:\/\/\s*)?AI_IMPLEMENTATION_END/i;
    const match = cleanCode.match(markerRegex);

    if (match) {
        block = match[1].replace(/^```(?:typescript|ts|js)?\s*/i, '').replace(/```\s*$/i, '').trim();
        console.log("📌 Extracted code using AI_IMPLEMENTATION markers (resilient regex)");
    } else {
        console.log("⚠️ Markers not found. Using entire extracted code block.");
        block = cleanCode;
    }

    // Remove all comments and whitespace to verify actual logic content
    const codeOnly = block
        .replace(/\/\/.*/g, '') // remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // remove multi-line comments
        .replace(/\s/g, "");

    // Require a minimum of 10 characters of actual code
    if (codeOnly.length < 10) {
        console.log("\n⚠️ Validation Failed: Implementation block is effectively empty or contains only comments.");
        console.log("🔍 Original code length:", code.length);
        console.log("🔍 Cleaned code length:", codeOnly.length);
        console.log("🔍 Sample:", block.substring(0, 200));
        return false;
    }

    // More flexible validation for different code patterns
    const hasValidContent = 
        codeOnly.length >= 10 && (
            // Traditional Playwright actions
            /\.(click|fill|goto|expect|waitFor|locator|getBy|select|type|press|hover)\(/.test(block) ||
            // Page Object method calls
            /\w+Page\.\w+\(/.test(block) ||
            // Test functions or assertions
            /test\s*\(/.test(block) ||
            /expect\(/.test(block) ||
            // Any method calls that look like Playwright
            /\w+\.\w+\(/.test(block) ||
            // Import statements (indicates this is code)
            /^import\s+/.test(block) ||
            // Async/await patterns
            /await\s+\w+/.test(block)
        );

    if (!hasValidContent) {
        console.log("\n⚠️ Validation Failed: No recognizable Playwright/test patterns detected.");
        console.log("🔍 Cleaned code length:", codeOnly.length);
        console.log("🔍 Sample:", block.substring(0, 200));
        return false;
    }

    console.log("✅ Validation passed: Found valid Playwright/test code");
    return true;
}

// New function for Type-Safe Validation
async function validateTypeScript(filePath) {
    console.log(`\n🔍 Type-Safe Validation: Running tsc on ${path.basename(filePath)}...`);
    return new Promise((resolve) => {
        const child = spawn("npx", ["tsc", "--noEmit", "--skipLibCheck", filePath], {
            cwd: repoRoot,
            shell: true
        });
        let output = "";
        child.stdout.on("data", data => output += data.toString());
        child.stderr.on("data", data => output += data.toString());
        child.on("close", code => {
            if (code === 0) {
                console.log("✅ TypeScript compilation passed.");
                resolve({ valid: true, output });
            } else {
                console.log("❌ TypeScript compilation failed:");
                console.log(output.split('\\n').slice(0, 10).join('\\n'));
                resolve({ valid: false, output });
            }
        });
    });
}

async function refine() {
    console.log("\n**********************************************");
    console.log("QA Engineer is starting to work...");
    console.log("**********************************************\n");
    
    if (!fs.existsSync(promptPath)) {
        console.error(`❌ Prompt file not found: ${promptPath}`);
        return;
    }
    const promptText = fs.readFileSync(promptPath, "utf8");

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

    console.log(`\n🤖 Implementing Data-Driven Test Logic for ${actualTargetFile}...`);

    let fullAiResponse = await callGemini(promptText);
    
    // SAVE RAW RESPONSE FOR DEBUGGING
    fs.writeFileSync(path.join(generatedDir, "debug_raw_ai_response.txt"), fullAiResponse, "utf8");

    // --- POM Handling: Extract and apply file updates ---
    // Look for blocks starting with /* FILE: path/to/file.ts */
    const fileBlocks = fullAiResponse.split(/\/\*\s*FILE:\s*([^*]+)\s*\*\//g);
    
    // The split result: [preamble, filePath1, content1, filePath2, content2, ...]
    if (fileBlocks.length > 1) {
        console.log("\n📦 POM Enforcement: AI returned updates for multiple files.");
        for (let i = 1; i < fileBlocks.length; i += 2) {
            const relPath = fileBlocks[i].trim();
            let content = fileBlocks[i + 1].trim();
            
            // Clean up markdown code fences if present in the captured content
            content = content.replace(/^```(?:typescript|ts|js)?\n/i, "").replace(/\n```$/i, "");

            const absPath = path.resolve(repoRoot, relPath);
            console.log(`📝 Updating/Creating: ${relPath}`);
            
            // Create parent directories if they don't exist (Priority 3: CREATE)
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, "utf8");
        }
    }

    // Extract the main test code with more flexible logic
    let finalCode = "";
    
    // Strategy 1: Resilient marker search across the whole response
    const markerRegex = /(?:\/\/\s*)?AI_IMPLEMENTATION_START(?:\s*\*\/)?\s*([\s\S]*?)\s*(?:\/\/\s*)?AI_IMPLEMENTATION_END/i;
    const markerMatch = fullAiResponse.match(markerRegex);
    
    if (markerMatch) {
        finalCode = markerMatch[1].replace(/^```(?:typescript|ts|js)?\s*/i, '').replace(/```\s*$/i, '').trim();
        console.log("📌 Found code with AI_IMPLEMENTATION_START marker (resilient regex)");
    } else {
        // Strategy 2: Look for code blocks that look like test code
        const codeBlocks = [...fullAiResponse.matchAll(/```(?:typescript|ts|js)?\s*\n([\s\S]*?)```/g)];
        
        if (codeBlocks.length > 0) {
            const testBlock = codeBlocks.find(b => {
                const content = b[1];
                return content.includes("test(") || 
                       content.includes("test.describe") || 
                       content.includes("it(") ||
                       (content.includes("page.") && content.includes("await")) ||
                       content.includes("Page");
            });
            
            if (testBlock) {
                finalCode = testBlock[1].trim();
                console.log("🔍 Found test-like code block without markers");
            } else {
                // Strategy 3: Use the last code block as fallback
                finalCode = codeBlocks[codeBlocks.length - 1][1].trim();
                console.log("🔄 Using last code block as fallback");
            }
        } else {
            // Strategy 4: No code blocks found - try to extract raw code
            console.log("⚠️ No code blocks found. Attempting raw code extraction...");
            
            // Look for import statements as starting points
            const importMatch = fullAiResponse.match(/import\s+[\s\S]*?(?=\n\n|\n[a-zA-Z]|$)/);
            if (importMatch) {
                finalCode = importMatch[0].trim();
                console.log("📦 Extracted code starting from imports");
            } else {
                // Look for any test-related code patterns
                const testPatterns = [
                    /test\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\}/g,
                    /test\.[^(]+\([^)]*\)[\s\S]*?(?=\n\n|test\.|$)/g,
                    /await\s+page\.[^;\n]+/g
                ];
                
                for (const pattern of testPatterns) {
                    const matches = fullAiResponse.match(pattern);
                    if (matches && matches.length > 0) {
                        finalCode = matches.join('\n').trim();
                        console.log(`🎯 Extracted code using pattern: ${pattern}`);
                        break;
                    }
                }
            }
        }
    }

    let implValid = validateImplementation(finalCode);
    let rollbackValidation = validateRollbackPresence(finalCode);

    if (!implValid || !rollbackValidation.valid) {
        console.log("\n⚠️ Warning: Validation failed. Retrying with explicit instructions...");
        
        let retryPrompt = promptText;
        if (!implValid) {
            retryPrompt += "\n\nIMPORTANT: Your previous response left the AI_IMPLEMENTATION_START block empty. You MUST translate the manual steps (Step 1, Step 2, etc.) into Playwright code using the Page Object methods provided in the prompt.";
        }
        if (!rollbackValidation.valid) {
            retryPrompt += `\n\nIMPORTANT: Your previous response failed rollback validation. ${rollbackValidation.warning}\nYou MUST wrap your main logic in a try block and include a finally block with cleanup logic (e.g., DELETE query via utils/db/dbUtil or a Page Object deactivate/remove method).`;
        }
        
        const retryResponse = await callGemini(retryPrompt);
        
        const retryMatch = retryResponse.match(markerRegex);
        if (retryMatch) {
            finalCode = retryMatch[1].replace(/^```(?:typescript|ts|js)?\s*/i, '').replace(/```\s*$/i, '').trim();
        } else {
            const retryBlocks = [...retryResponse.matchAll(/```(?:typescript|ts|js)?\s*\n([\s\S]*?)```/g)];
            if (retryBlocks.length > 0) {
                const testBlock = retryBlocks.find(b => b[1].includes("// AI_IMPLEMENTATION_START") || b[1].includes("test("));
                finalCode = testBlock ? testBlock[1].trim() : retryBlocks[retryBlocks.length - 1][1].trim();
            }
        }

        implValid = validateImplementation(finalCode);
        rollbackValidation = validateRollbackPresence(finalCode);

        if (!implValid || !rollbackValidation.valid) {
            console.error("\n❌ Error: AI failed to provide a valid implementation block or valid rollback logic after retry.");
            process.exit(1);
        }
    }

    console.log("\n💎 Code captured. Cleaning up...");

    // PRE-FLIGHT PO VALIDATION: Block raw locators when PO methods exist
    const poValidation = validatePageObjectUsage(finalCode, poMap);
    if (!poValidation.valid) {
        console.log("\n⚠️ Pre-flight PO Validation Failed. Retrying with explicit corrections...\n");
        const poRetryPrompt = promptText + 
            "\n\n🚫 CRITICAL ERROR IN YOUR PREVIOUS RESPONSE:\n" +
            "You used raw Playwright locators (page.locator, page.getByText, etc.) where Page Object methods already exist.\n\n" +
            "VIOLATIONS FOUND:\n" + poValidation.violations.map((v, i) => 
                `${i + 1}. Line with "${v.selector.substring(0, 40)}..." should use: ${v.suggestedPOs[0]}\n`
            ).join('') +
            "\n🔧 REQUIRED FIXES:\n" +
            "1. Search the PAGE OBJECT MAP for existing methods matching your actions\n" +
            "2. Replace ALL raw locators with PO method calls\n" +
            "3. Example: Instead of await page.locator('.icon-settings').click()\n" +
            "   Use: const topRightMenu = new TopRightMenu(page); await topRightMenu.selectSettings('Applications');\n" +
            "\n📝 REMEMBER: Page Objects exist to encapsulate selectors. NEVER write page.locator() when a PO method exists.";
        
        const retryResponse = await callGemini(poRetryPrompt);
        
        // Re-extract code from retry
        const retryBlocks = [...retryResponse.matchAll(/```(?:typescript|ts|js)?\s*\n([\s\S]*?)```/g)];
        if (retryBlocks.length > 0) {
            const testBlock = retryBlocks.find(b => b[1].includes("// AI_IMPLEMENTATION_START") || b[1].includes("test("));
            finalCode = testBlock ? testBlock[1].trim() : retryBlocks[retryBlocks.length - 1][1].trim();
        }
        
        // Re-validate PO usage
        const retryValidation = validatePageObjectUsage(finalCode, poMap);
        if (!retryValidation.valid) {
            console.log("\n⚠️ PO Validation failed after retry. Proceeding but marking as WARNING.\n");
            // Add warning marker to code for human review
            finalCode = `// ⚠️ WARNING: PO VALIDATION FAILED - Contains raw locators that should use Page Object methods\n// Violations: ${retryValidation.message.substring(0, 200)}...\n// TODO: Refactor to use PO methods from: ${retryValidation.violations.map(v => v.suggestedPOs[0]).slice(0, 2).join(', ')}\n\n${finalCode}`;
        } else {
            console.log("✅ PO Validation passed on retry");
        }
    }

    if (finalCode) {
        // Visual Regression Check Injection
        if (!finalCode.includes("toHaveScreenshot")) {
            console.log("📸 Injecting Visual Regression Check (toHaveScreenshot)...");
            const visualCheckCode = `\n    await console.log('STEP: Visual Regression Check against baseline');\n    await expect(page).toHaveScreenshot('ui-baseline-${effectivePageId}.png', { fullPage: true, maxDiffPixelRatio: 0.1 });`;
            finalCode += visualCheckCode;
        }

        // Bug Indicator Injection
        if (!finalCode.includes("page.on('response'")) {
            console.log("📸 Injecting API & Console Bug Indicators...");
            const bugCheckCode = `\n    page.on('response', response => { if(response.status() >= 400) console.error(\`API_BUG_INDICATOR: \${response.status()} \${response.url()}\`); });\n    page.on('pageerror', error => console.error(\`CONSOLE_BUG_INDICATOR: \${error.message}\`));`;
            // Insert it after `test('...', async ({ page }) => {`
            finalCode = finalCode.replace(/(test.*=>\s*\{)/, `$1${bugCheckCode}`);
        }

        const fixedCode = checkAndFixAwait(finalCode);
        if (fixedCode !== finalCode) {
            console.log("🩹 Auto-fixed missing 'await' calls.");
        }
        
        let fileContent = fs.readFileSync(targetFilePath, "utf8");
        
        if (fixedCode.includes("test(")) {
            // AI returned the full test file
            fixedCode = injectAnnotations(fixedCode, promptText, effectivePageId);
            fs.writeFileSync(targetFilePath, fixedCode, "utf8");
            console.log(`✅ SUCCESS: ${path.basename(targetFilePath)} entirely updated by AI.`);
        } else {
            // AI returned only the implementation snippet
            const startMarker = "// AI_IMPLEMENTATION_START";
            const endMarker = "// AI_IMPLEMENTATION_END";
            
            // Clean up finalCode to remove markers if it includes them
            let snippetToInject = fixedCode
                .replace(startMarker, '')
                .replace(endMarker, '')
                .trim();
                
            // Inject into fileContent
            const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);
            if (regex.test(fileContent)) {
                fileContent = fileContent.replace(regex, `${startMarker}\n    ${snippetToInject}\n    ${endMarker}`);
                fileContent = injectAnnotations(fileContent, promptText, effectivePageId);
                fs.writeFileSync(targetFilePath, fileContent, "utf8");
                console.log(`✅ SUCCESS: injected implementation into ${path.basename(targetFilePath)}.`);
            } else {
                 console.error("❌ Error: Target file does not contain AI_IMPLEMENTATION markers to inject code into.");
                 process.exit(1);
            }
        }

        // --- TYPE-SAFE VALIDATION ---
        const tsValidation = await validateTypeScript(targetFilePath);
        if (!tsValidation.valid) {
            const isMissingMethod = tsValidation.output.includes("does not exist on type") || tsValidation.output.includes("Property");
            if (isMissingMethod) {
                console.log("🛠️ TS Error: Missing Page Object method detected. Triggering Architect to scaffold...");
                await runScript("5_architect.mjs", ["--pageId", effectivePageId]);
            } else {
                console.log("🛠️ TS Error: Syntax/Type mismatch detected. Triggering Refactorer to heal...");
                await runScript("6_refactorer.mjs", ["--pageId", effectivePageId]);
            }
        }
        
    } else {
        console.error("❌ Error: AI did not return valid code.");
        process.exit(1);
    }

    // --- Update task_state.json before handing off to Healer ---
    const statePath = path.join(agentDir, 'task_state.json');
    let state = {};
    if (fs.existsSync(statePath)) {
        try {
            state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        } catch(e) {}
    }
    state.currentAgent = 'qaEngineer';
    state.qaEngineer = {
        targetFilePath: targetFilePath,
        targetFileName: actualTargetFile,
        pageId: effectivePageId,
        promptUsed: promptPath,
        refinementStatus: 'COMPLETED',
        poValidationStatus: poValidation.valid ? 'PASSED' : 'FAILED_AFTER_RETRY',
        poValidationViolations: poValidation.valid ? [] : poValidation.violations.slice(0, 5),
        rollbackRequired: rollbackValidation.required,
        rollbackValidationStatus: rollbackValidation.valid ? 'PASSED' : 'FAILED',
        completed: true,
        completedAt: new Date().toISOString()
    };
    state.status = 'REFINED';
    state.logs = state.logs || [];
    state.logs.push({
        agent: 'qaEngineer',
        timestamp: new Date().toISOString(),
        message: `Refined test implementation: ${actualTargetFile}. Rollback required: ${rollbackValidation.required}`
    });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    console.log("Updated task_state.json");

    // --- STEP 23: Verify and Heal ---
    console.log("\n**********************************************");
    console.log("QA Engineer finished.");
    console.log("Healer/Tester is now starting to work...");
    console.log("**********************************************");
    console.log("\n🧪 Starting Verification & Self-Healing Loop...");
    const verifyStatus = await runScript("4_healer.mjs", ["--pageId", effectivePageId]);

    if (verifyStatus !== 0) {
        console.error("\n❌ Verification/Healing loop failed. Preserving files for debugging.");
        process.exit(verifyStatus);
    }

    // --- STEP 6: Refactor to Page Objects ---
    console.log("\nSweep: Refactoring to Page Objects...");
    await runScript("6_refactorer.mjs", ["--pageId", effectivePageId]);
}

function injectAnnotations(content, promptText, pageId) {
    const jiraMatch = promptText.match(/JiraKey:\s*([^\n]+)/);
    const jiraKey = (jiraMatch ? jiraMatch[1].trim() : "").replace('N/A', '');
    const titleMatch = promptText.match(/Title:\s*([^\n]+)/);
    const pageTitle = titleMatch ? titleMatch[1].trim() : "";

    let newContent = content;

    // Check if test.beforeEach exists, if not, add it right after test.describe
    if (!newContent.includes('test.beforeEach')) {
        newContent = newContent.replace(/test\.describe\([^)]+\)\s*=>\s*\{/, 
            `$&\n  test.beforeEach(async () => {\n  });`
        );
    }

    const annotationsToAdd = [];
    if (!newContent.includes("type: 'Owner'")) {
        annotationsToAdd.push(`test.info().annotations.push({ type: 'Owner', description: 'Eyal Sooliman' });`);
    }
    if (jiraKey && !newContent.includes("type: 'Story'")) {
        annotationsToAdd.push(`test.info().annotations.push({ type: 'Story', description: '${jiraKey}' });`);
    }
    if (jiraKey && !newContent.includes("type: 'Issue'")) {
        annotationsToAdd.push(`test.info().annotations.push({ type: 'Issue', description: 'https://crossixsolutions.atlassian.net/browse/${jiraKey}' });`);
    }
    if (!newContent.includes("type: 'ConfluencePage'")) {
        annotationsToAdd.push(`test.info().annotations.push({ type: 'ConfluencePage', description: '${pageId}' });`);
    }
    if (!newContent.includes("type: 'Description'")) {
        annotationsToAdd.push(`test.info().annotations.push({ type: 'Description', description: '${pageTitle.replace(/'/g, "\\'")}' });`);
    }

    if (annotationsToAdd.length > 0) {
        newContent = newContent.replace(/(test\.beforeEach\s*\([^)]*\)\s*=>\s*\{)/, `$1\n      ${annotationsToAdd.join('\n      ')}`);
        console.log(`📝 Injected ${annotationsToAdd.length} missing Allure annotations into the test.`);
    }

    return newContent;
}

function checkAndFixAwait(code) {
    let lines = code.split('\n');
    let modified = false;
    const newLines = [];
    let rawLocatorWarnings = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimmed = line.trim();

        // Skip comments, empty lines, or already-awaited lines
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('await ')) {
            newLines.push(line);
            continue;
        }

        // Detect raw Playwright locators (warning candidate)
        const isRawLocator = /page\.(locator|getByRole|getByText|getByTestId)\(/.test(trimmed);
        const isPageObjectCall = /[a-zA-Z]+Page\.[a-zA-Z]+\(/.test(trimmed) || /loginPage\.[a-zA-Z]+\(/.test(trimmed);

        if (isRawLocator && !isPageObjectCall) {
            rawLocatorWarnings.push(`Line ${i + 1}: ${trimmed.substring(0, 60)}...`);
        }

        // Detect major Playwright/PO actions
        const isAction = /(page\.(click|fill|goto|waitFor|locator|getBy)|expect\(|loginPage\.|[a-zA-Z]+Page\.)/.test(trimmed);

        if (isAction) {
            modified = true;

            // Auto-inject a STEP log if the previous line isn't already a STEP log
            const prevLine = newLines.length > 0 ? newLines[newLines.length - 1].trim() : "";
            if (!prevLine.includes("STEP:")) {
                const stepDescription = trimmed.split('(')[0].replace('await ', '');
                newLines.push(`    await console.log('Executing ${stepDescription}');`);
            }

            // Ensure the line starts with await
            newLines.push(line.replace(trimmed, `await ${trimmed}`));
        } else {
            newLines.push(line);
        }
    }

    // Log warnings about raw locators
    if (rawLocatorWarnings.length > 0) {
        console.log("\n⚠️  WARNING: Detected raw Playwright locators (page.locator, page.getBy*, etc.):");
        console.log("    Consider using Page Object methods from the PAGE OBJECT MAP instead.");
        rawLocatorWarnings.forEach(w => console.log(`    ${w}`));
    }

    return newLines.join('\n');
}

function runScript(scriptName, args) {
    return new Promise((resolve, reject) => {
        const child = spawn("node", [path.join(agentDir, scriptName), ...args], {
            stdio: "inherit",
            shell: true
        });
        child.on("close", (code) => {
            resolve(code);
        });
    });
}

refine().catch(err => {
    console.error("❌ Refinement failed:", err);
    process.exit(1);
});