// agent/2_test_generator_generic.mjs
// Agent: Test Generator - Generic Version
import fs from "node:fs";
import path from "node:path";

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
    console.error("Missing pageId. Provide --pageId or set CONFLUENCE_PAGE_ID.");
    process.exit(1);
}

// Generic mode detection
function isGenericMode() {
    return genericConfig.genericMode === true || process.env.GENERIC_MODE === "true";
}

// Inputs produced by earlier steps
const mdPath = path.join(generatedDir, `page_${effectivePageId}.md`);
const jiraPath = path.join(generatedDir, `jira_${effectivePageId}.txt`);
const relatedContextPath = path.join(generatedDir, `related_context_${effectivePageId}.md`);
const briefPath = path.join(generatedDir, `brief_${effectivePageId}.json`);
const scenariosPath = path.join(generatedDir, `scenarios_${effectivePageId}.json`);
const testDataPath = path.join(generatedDir, `test_data_${effectivePageId}.json`);
const requiredDataSpecPath = path.join(generatedDir, `required_data_${effectivePageId}.json`);
const repoKnowledgePath = path.join(agentDir, `repo_knowledge.json`);

// ----------------------------
// Helpers
// ----------------------------
function normalizeText(x) {
    return String(x ?? "").replace(/\s+/g, " ").trim();
}

function isLikelyMetadataRow(row) {
    const text = normalizeText(Object.values(row || {}).join(" ")).toLowerCase();
    return (
        /document owner|owner \(pm\)|updates made|document created|date\b|last updated|author|version|approver|reviewed|stakeholder/.test(
            text
        ) || text.length < 10
    );
}

function sanitizeTestName(name) {
    return name
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .replace(/\s+/g, "_")
        .replace(/^[^a-zA-Z]/, "")
        .substring(0, 80);
}

function extractSubject(scenario) {
    const subjectMatch = scenario.match(/Subject:\s*(.+?)(?:\n|$)/i);
    return subjectMatch ? subjectMatch[1].trim() : "Unknown Test";
}

function extractUser(scenario) {
    const userMatch = scenario.match(/User:\s*(.+?)(?:\n|$)/i);
    return userMatch ? userMatch[1].trim() : "Standard User";
}

function extractSteps(scenario) {
    const stepsMatch = scenario.match(/Steps:\s*\n((?:\d+\..+?(?:\n|$))+)/i);
    if (!stepsMatch) return [];
    
    const steps = stepsMatch[1]
        .split(/\n(?=\d+\.)/)
        .map(step => step.replace(/^\d+\.\s*/, "").trim())
        .filter(step => step.length > 0);
    
    console.log(`🔍 DEBUG: Extracted ${steps.length} steps from scenario`);
    steps.forEach((step, index) => {
        console.log(`   Step ${index + 1}: ${step}`);
    });
    
    return steps;
}

function extractExpected(scenario) {
    const expectedMatch = scenario.match(/Expected:\s*\n(.+?)(?:\n\n|$)/is);
    return expectedMatch ? expectedMatch[1].trim() : "Test should complete successfully";
}

// Generic selector generator
function generateGenericSelector(element, action, context) {
    const universalSelectors = genericConfig.universalSelectors || {};
    
    // Map common actions to selector patterns
    if (element.toLowerCase().includes('username') || element.toLowerCase().includes('user')) {
        const selectors = universalSelectors.login?.username || ['input[name="username"]', '#username'];
        return selectors[0];
    }
    
    if (element.toLowerCase().includes('password')) {
        const selectors = universalSelectors.login?.password || ['input[type="password"]', '#password'];
        return selectors[0];
    }
    
    if (element.toLowerCase().includes('submit') || element.toLowerCase().includes('login')) {
        const selectors = universalSelectors.login?.submit || ['button[type="submit"]', '.login-button'];
        return selectors[0];
    }
    
    if (element.toLowerCase().includes('button') || action.toLowerCase().includes('click')) {
        const selectors = universalSelectors.common?.button || ['button', '.btn'];
        return `button:has-text('${element}')`;
    }
    
    if (element.toLowerCase().includes('input') || action.toLowerCase().includes('fill')) {
        const selectors = universalSelectors.common?.input || ['input'];
        return `input:has-text('${element}')`;
    }
    
    // Fallback to text-based selector
    return `text=${element}`;
}

// Enhanced generic test code generator with actual implementations
function generateGenericTestCode(scenario, metadata) {
    const subject = extractSubject(scenario);
    const user = extractUser(scenario);
    const steps = extractSteps(scenario);
    const expected = extractExpected(scenario);
    
    const testClassName = sanitizeTestName(subject);
    const testName = subject;
    
    let code = `/**
 * 🤖 AI AGENT HANDOVER NOTE
 * CONTEXT:
 * - Page ID: ${metadata.pageId}
 * - Jira Key: ${metadata.jiraKey || 'N/A'}
 * - Report: agent/generation_report_${metadata.pageId}.json
 * - Mode: Generic (Universal) with Page Objects
 * 
 * 🎬 HEADED MODE: This test will run with visible browser
 * Run with: npx playwright test ${testClassName}.test.ts --headed
 */

import { test, expect } from '@playwright/test';
import { LandingPage } from '../../page-objects/LandingPage';

test.describe('${testClassName}', () => {
  
  test.beforeEach(async () => {
      test.info().annotations.push({ type: 'Owner', description: 'AI Agent' });
      test.info().annotations.push({ type: 'Test Type', description: 'Generic' });
      test.info().annotations.push({ type: 'Description', description: '${subject}' });
  });

  test('${testName}', { tag: ['@smoke', '@generic'] }, async ({ page }) => {
    // Initialize page object
    const landingPage = new LandingPage(page);
`;

    // Generate enhanced test steps with actual implementations and comprehensive logging
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepNumber = i + 1;
        
        // Add step header with logging
        code += `    // =========================================\n`;
        code += `    // STEP ${stepNumber}: ${step.toUpperCase()}\n`;
        code += `    // =========================================\n`;
        code += `    console.log('\\n🚀 STEP ${stepNumber}: ${step}');\n`;
        code += `    console.log('⏰ Starting step execution at:', new Date().toISOString());\n\n`;
        
        if (step.toLowerCase().includes('navigate') || step.toLowerCase().includes('go to')) {
            const urlMatch = step.match(/https?:\/\/[^\s]+/);
            if (urlMatch) {
                code += `    console.log('📍 Navigating to URL: ${urlMatch[0]}');\n`;
                code += `    await landingPage.navigateTo('${urlMatch[0]}');\n`;
                code += `    console.log('✅ Navigation completed successfully');\n`;
            } else {
                code += `    console.log('📍 Navigating to base URL: /');\n`;
                code += `    await landingPage.navigateTo('/'); // TODO: Update with actual URL\n`;
                code += `    console.log('✅ Navigation to base URL completed');\n`;
            }
        } else if (step.toLowerCase().includes('verify all links') || step.toLowerCase().includes('verify links')) {
            code += `    console.log('🔍 Starting link verification process...');\n`;
            code += `    console.log('📊 Will verify up to 10 links on the page');\n`;
            code += `    // Verify all links are functional using page object\n`;
            code += `    await landingPage.verifyLinks(10);\n`;
            code += `    console.log('✅ Link verification completed');\n`;
        } else if (step.toLowerCase().includes('verify all elements') || step.toLowerCase().includes('verify elements')) {
            code += `    console.log('🖼️ Starting element verification process...');\n`;
            code += `    console.log('📊 Will verify up to 10 images on the page');\n`;
            code += `    // Verify key elements are visible and not broken using page object\n`;
            code += `    await landingPage.verifyImages(10);\n`;
            code += `    console.log('✅ Element verification completed');\n`;
        } else if (step.toLowerCase().includes('click') || step.toLowerCase().includes('press')) {
            const elementMatch = step.match(/(?:click|press)\s+["']?(.+?)["']?$/i);
            if (elementMatch) {
                const element = elementMatch[1];
                code += `    console.log('🖱️ Preparing to click element: ${element}');\n`;
                
                // Enhanced selector generation for common button patterns
                if (element.toLowerCase().includes('try calm for free')) {
                    code += `    console.log('🎯 Targeting "Try Calm for Free" button');\n`;
                    code += `    // Try multiple selectors for "Try Calm for Free" button\n`;
                    code += `    await landingPage.verifyTryButtonVisible();\n`;
                    code += `    console.log('✅ Button visibility verified');\n`;
                    code += `    await landingPage.clickTryButton();\n`;
                    code += `    console.log('✅ Button clicked successfully');\n`;
                } else if (element.toLowerCase().includes('login in') || element.toLowerCase().includes('login')) {
                    code += `    console.log('🎯 Targeting login button');\n`;
                    code += `    // Click login button using page object\n`;
                    code += `    await landingPage.clickLoginButton();\n`;
                    code += `    console.log('✅ Login button clicked');\n`;
                } else {
                    code += `    console.log('⚠️ Generic click action for: ${element}');\n`;
                    code += `    // Generic click action - add custom method as needed\n`;
                    code += `    const element = page.locator('text=${element}').first();\n`;
                    code += `    await expect(element).toBeVisible({ timeout: 10000 });\n`;
                    code += `    await element.click();\n`;
                    code += `    console.log(\`✅ Clicked element: \${element}\`);\n`;
                }
            } else {
                code += `    console.log('⚠️ Step ${stepNumber}: Click action - element not recognized in step: ${step}');\n`;
                code += `    // TODO: Implement click action - element not recognized\n`;
            }
        } else if (step.toLowerCase().includes('verify') && (step.toLowerCase().includes('tab') || step.toLowerCase().includes('new tab'))) {
            code += `    console.log('🔍 Verifying new tab opened...');\n`;
            code += `    // Handle new tab verification\n`;
            code += `    const pages = page.context().pages();\n`;
            code += `    console.log(\`📊 Found \${pages.length} pages/tabs\`);\n`;
            code += `    expect(pages.length).toBeGreaterThan(1);\n`;
            code += `    console.log('✅ New tab verified');\n`;
        } else if (step.toLowerCase().includes('verify') && step.toLowerCase().includes('sign in')) {
            code += `    console.log('🔍 Verifying Sign In button...');\n`;
            code += `    // Verify Sign In button appears\n`;
            code += `    await landingPage.verifySignInButtonVisible();\n`;
            code += `    console.log('✅ Sign In button verification completed');\n`;
        } else if (step.toLowerCase().includes('enter') || step.toLowerCase().includes('fill') || step.toLowerCase().includes('type')) {
            const fieldMatch = step.match(/(?:enter|fill|type)\s+(?:.+?)\s+(?:in|into)\s+(.+?)(?:\s+(?:field|input))?$/i);
            if (fieldMatch) {
                const field = fieldMatch[1];
                code += `    console.log('⌨️ Preparing to fill field: ${field}');\n`;
                const selector = generateGenericSelector(field, 'fill', step);
                code += `    await expect(page.locator('${selector}')).toBeVisible();\n`;
                code += `    await page.fill('${selector}', 'test-data'); // TODO: Update with actual test data\n`;
                code += `    console.log(\`✅ Field filled: \${field}\`);\n`;
            } else {
                code += `    console.log('⚠️ Step ${stepNumber}: Fill action - field not recognized in step: ${step}');\n`;
                code += `    // TODO: Implement fill action - field not recognized\n`;
            }
        } else {
            code += `    console.log('⚠️ Step ${stepNumber}: Pattern not recognized - ${step}');\n`;
            code += `    // TODO: Implement this step - pattern not recognized\n`;
            code += `    console.log('ℹ️ This step needs manual implementation');\n`;
        }
        
        code += `    console.log('⏰ Step ${stepNumber} completed at:', new Date().toISOString());\n`;
        code += '\n';
    }
    
    // Enhanced verification steps
    code += `    // Verification: ${expected}\n`;
    
    if (expected.toLowerCase().includes('landing page works') || expected.toLowerCase().includes('page works')) {
        code += `    // Verify landing page is working correctly using page object\n`;
        code += `    await landingPage.verifyPageHealth();\n`;
    } else if (expected.toLowerCase().includes('login') && expected.toLowerCase().includes('success')) {
        code += `    await expect(page).toHaveURL(/dashboard|home|welcome/);\n`;
        code += `    const successElement = await page.locator('text=welcome, dashboard, logout').first();\n`;
        code += `    await expect(successElement).toBeVisible();\n`;
    } else if (expected.toLowerCase().includes('redirect')) {
        code += `    await page.waitForLoadState('networkidle');\n`;
        code += `    const currentUrl = page.url();\n`;
        code += `    expect(currentUrl).not.toBe('https://www.calm.com/'); // Should have redirected\n`;
    } else {
        code += `    // Custom verification for: ${expected}\n`;
        code += `    console.log('Custom verification needed - implement based on expected behavior');\n`;
    }
    
    code += `
  });
});

export {}; // Make this a module
`;
    
    return code;
}

async function main() {
    console.log("**********************************************");
    console.log("Test Generator (Generic Mode) starting...");
    console.log("**********************************************");

    // Auto-create missing project structure
    console.log("🔧 Checking project structure...");
    try {
        const { createPageObjectFolder, createUtilsFolder, createLandingPagePO, updatePageObjectsIndex } = await import('./auto_page_object_creator.mjs');
        
        const poCreated = createPageObjectFolder();
        const utilsCreated = createUtilsFolder();
        
        if (poCreated || utilsCreated) {
            createLandingPagePO();
            updatePageObjectsIndex();
            console.log("✅ Project structure auto-created");
        } else {
            console.log("ℹ️ Project structure already exists");
        }
    } catch (error) {
        console.log("⚠️ Could not auto-create project structure:", error.message);
    }

    // Read manual scenario directly from the source file
    const manualScenarioPath = path.join(repoRoot, "tests/generated-from-agentFallBack/scenario.txt");
    if (!fs.existsSync(manualScenarioPath)) {
        console.error("❌ Manual scenario not found");
        process.exit(1);
    }

    const scenario = fs.readFileSync(manualScenarioPath, "utf8");
    console.log(`📄 Read scenario: ${scenario.substring(0, 100)}...`);

    // Generate generic test code
    const metadata = {
        pageId: effectivePageId,
        jiraKey: null,
        mode: 'generic'
    };

    const testCode = generateGenericTestCode(scenario, metadata);
    
    // Save test file
    const outDir = path.join(repoRoot, "tests/generated-from-agentFallBack");
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const subject = extractSubject(scenario);
    const fileName = sanitizeTestName(subject) + ".test.ts";
    const testPath = path.join(outDir, fileName);

    fs.writeFileSync(testPath, testCode, "utf8");
    console.log(`✨ Generated generic test: ${testPath}`);

    // Save metadata
    const metadataPath = path.join(generatedDir, "last_generated_test.json");
    fs.writeFileSync(metadataPath, JSON.stringify({
        absPath: path.resolve(testPath),
        fileName: fileName,
        pageId: effectivePageId,
        sourceType: "manual",
        mode: "generic"
    }, null, 2), "utf8");

    // Generate prompt for next agent
    const promptPath = path.join(generatedDir, `prompt_for_llm_${effectivePageId}.txt`);
    const prompt = `You are a QA Engineer reviewing the following Playwright test.

CONTEXT:
- This is a GENERIC MODE test - no specific Page Objects required
- Use standard Playwright best practices
- Focus on robust selectors and clear test logic

TEST FILE: ${fileName}
PATH: ${testPath}

CODE:
${testCode}

TASKS:
1. Review the test for clarity and correctness
2. Improve selectors to be more robust
3. Add proper waits and assertions
4. Ensure test follows Playwright best practices
5. Add any missing error handling
6. Return the complete, improved test code

GENERIC MODE GUIDELINES:
- Prefer semantic selectors: getByRole, getByLabel, getByText
- Use data-testid attributes when available
- Add proper waits for dynamic content
- Include meaningful assertions
- Structure tests for readability and maintenance

UNIVERSAL SELECTORS TO USE:
${JSON.stringify(genericConfig.universalSelectors || {}, null, 2)}

Return only the complete TypeScript test code wrapped in triple backticks.
`;

    fs.writeFileSync(promptPath, prompt, "utf8");
    console.log(`📝 Generated prompt for next agent: ${promptPath}`);

    console.log("**********************************************");
    console.log("Test Generator (Generic Mode) finished.");
    console.log("**********************************************");
}

main().catch(console.error);
