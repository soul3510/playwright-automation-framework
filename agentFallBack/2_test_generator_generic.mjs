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
const userInputDataPath = path.join(generatedDir, `user_input_data_${effectivePageId}.json`);

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
    const subjectMatch = scenario.match(/Subject:\s*(.+?)(?:\r?\n|$)/i);
    return subjectMatch ? subjectMatch[1].trim() : "Unknown Test";
}

function extractUser(scenario) {
    const userMatch = scenario.match(/User:\s*(.+?)(?:\r?\n|$)/i);
    return userMatch ? userMatch[1].trim() : "Standard User";
}

function extractSteps(scenario) {
    const stepsMatch = scenario.match(/Steps:\s*\r?\n((?:\d+\..+?(?:\r?\n|$))+)/i);
    if (!stepsMatch) return [];
    
    const steps = stepsMatch[1]
        .split(/\r?\n(?=\d+\.)/)
        .map(step => step.replace(/^\d+\.\s*/, "").trim())
        .filter(step => step.length > 0);
    
    console.log(`🔍 DEBUG: Extracted ${steps.length} steps from scenario`);
    steps.forEach((step, index) => {
        console.log(`   Step ${index + 1}: ${step}`);
    });
    
    return steps;
}

function extractExpected(scenario) {
    const expectedMatch = scenario.match(/Expected:\s*\r?\n(.+?)(?:\r?\n\r?\n|$)/is);
    return expectedMatch ? expectedMatch[1].trim() : "Test should complete successfully";
}

function escapeForSingleQuotedTs(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function extractQuotedValue(text) {
    const match = String(text || "").match(/["']([^"']+)["']/);
    return match ? match[1].trim() : "";
}

function extractUrl(text) {
    const match = String(text || "").match(/https?:\/\/[^\s)]+/);
    return match ? match[0].replace(/[.,;]+$/, "") : "";
}

function cleanClickableText(value) {
    return String(value || "")
        .replace(/^on\s+/i, "")
        .replace(/\s+button$/i, "")
        .replace(/^the\s+/i, "")
        .trim()
        .replace(/^["']|["']$/g, "");
}

function regexLiteralFromTerms(value, fallback = "result") {
    const terms = String(value || fallback)
        .split(/\s+/)
        .map(term => term.replace(/[^a-zA-Z0-9]/g, ""))
        .filter(term => term.length >= 3)
        .slice(0, 4);
    return (terms.length ? terms : [fallback]).join("|");
}

function commentBlock(prefix, value) {
    return String(value || "")
        .split(/\r?\n/)
        .map((line, index) => `    // ${index === 0 ? prefix : ""}${line}`)
        .join("\n");
}

function loadUserInputData() {
    if (!fs.existsSync(userInputDataPath)) {
        return { enabled: false, createDataProviders: false, fields: {} };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(userInputDataPath, "utf8"));
        return {
            enabled: parsed.enabled === true,
            createDataProviders: parsed.createDataProviders === true,
            fields: parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {}
        };
    } catch {
        return { enabled: false, createDataProviders: false, fields: {} };
    }
}

function sanitizeDataKey(value, fallback = "primaryInput") {
    const key = String(value || fallback)
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || fallback;
    return /^[a-zA-Z_$]/.test(key) ? key : `input_${key}`;
}

function firstUserInputValue(inputData, fallback, preferredKey = "") {
    if (!inputData?.enabled) return fallback;
    const fields = inputData.fields || {};
    const exactKey = userInputAccessor(inputData, preferredKey);
    if (exactKey) {
        const directEntry = Object.entries(fields).find(([key]) => sanitizeDataKey(key).toLowerCase() === exactKey.toLowerCase());
        const directValue = String(directEntry?.[1] || "").trim();
        if (directValue) return directValue;
    }
    const normalizedPreferred = sanitizeDataKey(preferredKey).toLowerCase();
    const fuzzyEntry = Object.entries(fields).find(([key]) => {
        const normalizedKey = sanitizeDataKey(key).toLowerCase();
        return normalizedPreferred && (normalizedKey.includes(normalizedPreferred) || normalizedPreferred.includes(normalizedKey));
    });
    const fuzzyValue = String(fuzzyEntry?.[1] || "").trim();
    if (fuzzyValue) return fuzzyValue;
    const values = Object.values(fields).map(value => String(value || "").trim()).filter(Boolean);
    return values[0] || fallback;
}

function providerValuesFromBase(value) {
    const base = String(value || "test value").trim() || "test value";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(base)) {
        const [local, domain] = base.split("@");
        return [
            base,
            `${local}+valid@${domain}`,
            `${local}+long-value@${domain}`,
            `${local}+symbols-123@${domain}`,
            `${local}+edge.case@${domain}`
        ];
    }
    if (/^https?:\/\//i.test(base)) {
        return [
            base,
            `${base.replace(/\/$/, "")}?case=valid`,
            `${base.replace(/\/$/, "")}?case=edge`,
            "https://example.com/test-data",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ];
    }
    if (/^\d+$/.test(base)) {
        const n = Number(base);
        return [String(n), String(n + 1), String(Math.max(0, n - 1)), String(n * 10 || 10), "999999"];
    }
    return [
        base,
        `${base} valid`,
        `${base} 123`,
        `${base} edge case`,
        `${base} long value for validation`
    ];
}

function buildInputDataProviderCode(inputData) {
    if (!inputData?.enabled || !inputData.createDataProviders) return "";
    const fields = Object.entries(inputData.fields || {})
        .map(([key, value]) => [sanitizeDataKey(key), String(value || "").trim()])
        .filter(([, value]) => value);

    if (!fields.length) return "";

    const cases = Array.from({ length: 5 }, (_, index) => {
        const record = { caseName: `case_${index + 1}` };
        for (const [key, value] of fields) {
            record[key] = providerValuesFromBase(value)[index];
        }
        return record;
    });

    return `\nconst inputDataProviders = ${JSON.stringify(cases, null, 2)};\n`;
}

function userInputAccessor(inputData, preferredKey = "primaryInput") {
    if (!inputData?.enabled) return null;
    const keys = Object.keys(inputData.fields || {}).map(key => sanitizeDataKey(key));
    if (!keys.length) return null;
    const exact = keys.find(key => key.toLowerCase() === sanitizeDataKey(preferredKey).toLowerCase());
    return exact || keys[0];
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
    const primaryQuery = extractQuotedValue(scenario);
    const expectedTermsRegex = regexLiteralFromTerms(primaryQuery || expected || subject);
    const inputData = metadata.inputData || { enabled: false, createDataProviders: false, fields: {} };
    const inputProviderCode = buildInputDataProviderCode(inputData);
    const providerEnabled = Boolean(inputProviderCode);
    
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
import { handlePageInterruptions } from '../../utils/pageInterruptions';
${inputProviderCode}

test.describe('${testClassName}', () => {
  
  test.beforeEach(async () => {
      test.info().annotations.push({ type: 'Owner', description: 'AI Agent' });
      test.info().annotations.push({ type: 'Test Type', description: 'Generic' });
      test.info().annotations.push({ type: 'Description', description: '${subject}' });
  });

  test('${testName}', { tag: ['@smoke', '@generic'] }, async ({ page }) => {
    // Initialize page object
    const landingPage = new LandingPage(page);
    ${providerEnabled ? "const inputData = inputDataProviders[0];" : "const inputData = {};"}
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
        code += `\n`;
        
        if (stepNumber > 1) {
            code += `    await handlePageInterruptions(page);\n\n`;
        }

        if (step.toLowerCase().includes('navigate') || step.toLowerCase().includes('go to')) {
            const url = extractUrl(step);
            if (url) {
                code += `    console.log('📍 Navigating to URL: ${escapeForSingleQuotedTs(url)}');\n`;
                code += `    await page.goto('${escapeForSingleQuotedTs(url)}', { waitUntil: 'domcontentloaded', timeout: 60000 });\n`;
                code += `    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });\n`;
                code += `    await handlePageInterruptions(page);\n`;
                code += `    console.log('✅ Navigation completed successfully');\n`;
            } else {
                code += `    console.log('📍 Navigating to base URL: /');\n`;
                code += `    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 }); // TODO: Update with actual URL\n`;
                code += `    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });\n`;
                code += `    await handlePageInterruptions(page);\n`;
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
                const element = cleanClickableText(elementMatch[1]);
                code += `    console.log('🖱️ Preparing to click element: ${escapeForSingleQuotedTs(element)}');\n`;
                
                // Enhanced selector generation for common button patterns
                if (step.toLowerCase().includes('press enter')) {
                    code += `    console.log('⌨️ Pressing Enter');\n`;
                    code += `    await page.keyboard.press('Enter');\n`;
                    code += `    await page.waitForLoadState('domcontentloaded');\n`;
                    code += `    console.log('✅ Enter key submitted successfully');\n`;
                } else if (element.toLowerCase().includes('first search result') || element.toLowerCase().includes('first result') || element.toLowerCase().includes('first product')) {
                    code += `    console.log('🎯 Opening the first search result');\n`;
                    code += `    const firstResult = page.locator('[data-component-type="s-search-result"] h2 a, [data-component-type="s-search-result"] a.a-link-normal, .mw-search-result-heading a, .mw-search-results li a, main a').first();\n`;
                    code += `    await expect(firstResult).toBeVisible({ timeout: 15000 });\n`;
                    code += `    await firstResult.click();\n`;
                    code += `    await page.waitForLoadState('domcontentloaded');\n`;
                    code += `    console.log('✅ First result opened successfully');\n`;
                } else if (element.toLowerCase().includes('add to cart')) {
                    code += `    console.log('🎯 Adding product to cart');\n`;
                    code += `    const addToCartButton = page.getByRole('button', { name: /add to cart/i }).or(page.locator('input[name="submit.add-to-cart"], #add-to-cart-button')).first();\n`;
                    code += `    await expect(addToCartButton).toBeVisible({ timeout: 15000 });\n`;
                    code += `    await addToCartButton.click();\n`;
                    code += `    await page.waitForLoadState('domcontentloaded');\n`;
                    code += `    console.log('✅ Add to Cart clicked successfully');\n`;
                } else if (element.toLowerCase().includes('search button') || element.toLowerCase().includes('search')) {
                    code += `    console.log('🎯 Submitting search');\n`;
                    code += `    const searchButton = page.getByRole('button', { name: /search/i }).first();\n`;
                    code += `    if (await searchButton.isVisible({ timeout: 3000 }).catch(() => false)) {\n`;
                    code += `      await searchButton.click();\n`;
                    code += `    } else {\n`;
                    code += `      await page.keyboard.press('Enter');\n`;
                    code += `    }\n`;
                    code += `    await page.waitForLoadState('domcontentloaded');\n`;
                    code += `    console.log('✅ Search submitted successfully');\n`;
                } else if (element.toLowerCase().includes('try calm for free')) {
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
                    code += `    console.log('⚠️ Generic click action for: ${escapeForSingleQuotedTs(element)}');\n`;
                    code += `    // Generic click action - add custom method as needed\n`;
                    code += `    const element${stepNumber} = page.getByText('${escapeForSingleQuotedTs(element)}', { exact: false }).first();\n`;
                    code += `    await expect(element${stepNumber}).toBeVisible({ timeout: 10000 });\n`;
                    code += `    await element${stepNumber}.click();\n`;
                    code += `    console.log('✅ Clicked element: ${escapeForSingleQuotedTs(element)}');\n`;
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
            const fieldMatch = step.match(/(?:enter|fill|type)\s+(.+?)\s+(?:in|into)\s+(.+?)(?:\s+(?:field|input|box))?$/i);
            if (fieldMatch) {
                const rawValue = extractQuotedValue(fieldMatch[1]) || fieldMatch[1].trim();
                const field = fieldMatch[2].trim();
                const value = escapeForSingleQuotedTs(firstUserInputValue(inputData, rawValue, field));
                const dataKey = userInputAccessor(inputData, field);
                code += `    console.log('⌨️ Preparing to fill field: ${escapeForSingleQuotedTs(field)}');\n`;
                if (field.toLowerCase().includes('search')) {
                    code += `    const searchInput = page.getByRole('searchbox').or(page.locator('input[type="search"], input[name="search"], input[name="searchInput"], #searchInput')).first();\n`;
                    code += `    await expect(searchInput).toBeVisible({ timeout: 10000 });\n`;
                    if (providerEnabled && dataKey) {
                        code += `    const searchValue = String(inputData.${dataKey} ?? '${value}');\n`;
                        code += `    await searchInput.fill(searchValue);\n`;
                    } else {
                        code += `    await searchInput.fill('${value}');\n`;
                    }
                } else {
                    const fieldTermsRegex = regexLiteralFromTerms(field, "input");
                    code += `    const fieldLocator${stepNumber} = page.getByLabel(/${fieldTermsRegex}/i).or(page.getByPlaceholder(/${fieldTermsRegex}/i)).or(page.locator('input:visible, textarea:visible')).first();\n`;
                    code += `    await expect(fieldLocator${stepNumber}).toBeVisible({ timeout: 10000 });\n`;
                    if (providerEnabled && dataKey) {
                        code += `    const fieldValue${stepNumber} = String(inputData.${dataKey} ?? '${value}');\n`;
                        code += `    await fieldLocator${stepNumber}.fill(fieldValue${stepNumber});\n`;
                    } else {
                        code += `    await fieldLocator${stepNumber}.fill('${value}');\n`;
                    }
                }
                code += `    console.log('✅ Field filled: ${escapeForSingleQuotedTs(field)}');\n`;
            } else if (step.toLowerCase().includes('primary visible form') || step.toLowerCase().includes('visible form')) {
                const safeValue = firstUserInputValue(inputData, primaryQuery || "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "primaryInput");
                const dataKey = userInputAccessor(inputData, "primaryInput");
                code += `    console.log('⌨️ Filling the primary visible form with validation-safe data');\n`;
                code += `    const primaryInput = page.locator('input:visible, textarea:visible').first();\n`;
                code += `    await expect(primaryInput).toBeVisible({ timeout: 10000 });\n`;
                if (providerEnabled && dataKey) {
                    code += `    for (const dataCase of inputDataProviders) {\n`;
                    code += `      const primaryValue = String(dataCase.${dataKey} ?? '${escapeForSingleQuotedTs(safeValue)}');\n`;
                    code += `      console.log(\`Testing data provider case: \${dataCase.caseName} with value: \${primaryValue}\`);\n`;
                    code += `      await primaryInput.fill(primaryValue);\n`;
                    code += `      await expect(primaryInput).toHaveValue(primaryValue);\n`;
                    code += `    }\n`;
                } else {
                    code += `    await primaryInput.fill('${escapeForSingleQuotedTs(safeValue)}');\n`;
                }
                code += `    console.log('✅ Primary visible form filled');\n`;
            } else {
                code += `    console.log('⚠️ Step ${stepNumber}: Fill action - field not recognized in step: ${step}');\n`;
                code += `    // TODO: Implement fill action - field not recognized\n`;
            }
        } else if (step.toLowerCase().includes('verify') && (step.toLowerCase().includes('page loads') || step.toLowerCase().includes('main content'))) {
            code += `    console.log('🔍 Verifying page loaded and main content is visible');\n`;
            code += `    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });\n`;
            code += `    await expect(page.locator('main, h1, body').first()).toBeVisible({ timeout: 15000 });\n`;
            code += `    const title = await page.title();\n`;
            code += `    expect(title.length).toBeGreaterThan(0);\n`;
            code += `    console.log('✅ Page load and main content verified');\n`;
        } else if (step.toLowerCase().includes('verify') && step.toLowerCase().includes('search result')) {
            code += `    console.log('🔍 Verifying search results are visible');\n`;
            code += `    await expect(page.locator('[data-component-type="s-search-result"], .s-result-item, .mw-search-results li, .mw-search-result-heading, main, body').first()).toBeVisible({ timeout: 15000 });\n`;
            code += `    await expect(page.locator('body')).toContainText(/${expectedTermsRegex}/i, { timeout: 15000 });\n`;
            code += `    console.log('✅ Search results are visible');\n`;
        } else if (step.toLowerCase().includes('verify') && (step.toLowerCase().includes('article') || step.toLowerCase().includes('title') || step.toLowerCase().includes('product details'))) {
            code += `    console.log('🔍 Verifying details page title');\n`;
            code += `    await expect(page.locator('h1, #productTitle, .firstHeading').first()).toBeVisible({ timeout: 15000 });\n`;
            code += `    const detailsTitle = (await page.locator('h1, #productTitle, .firstHeading').first().innerText()).trim();\n`;
            code += `    console.log(\`📄 Details title: \${detailsTitle}\`);\n`;
            code += `    expect(detailsTitle.length).toBeGreaterThan(0);\n`;
            code += `    console.log('✅ Details page title verified');\n`;
        } else if (step.toLowerCase().includes('verify') && (step.toLowerCase().includes('cart') || step.toLowerCase().includes('added'))) {
            code += `    console.log('🔍 Verifying cart update');\n`;
            code += `    await expect(page.locator('body')).toContainText(/cart|added|basket|1/i, { timeout: 15000 });\n`;
            code += `    console.log('✅ Cart update verified');\n`;
        } else if (step.toLowerCase().includes('verify') && (step.toLowerCase().includes('validation') || step.toLowerCase().includes('feedback') || step.toLowerCase().includes('next-step'))) {
            code += `    console.log('🔍 Verifying validation or next-step feedback');\n`;
            code += `    const submitControl = page.getByRole('button', { name: /search|download|submit|continue|next/i }).or(page.locator('button:visible, input[type="submit"]:visible')).first();\n`;
            code += `    if (await submitControl.isVisible({ timeout: 5000 }).catch(() => false)) {\n`;
            code += `      await submitControl.click();\n`;
            code += `      await page.waitForLoadState('domcontentloaded').catch(() => {});\n`;
            code += `    }\n`;
            code += `    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });\n`;
            code += `    console.log('✅ Validation or next-step feedback check completed');\n`;
        } else {
            code += `    console.log('⚠️ Step ${stepNumber}: Pattern not recognized - ${step}');\n`;
            code += `    // TODO: Implement this step - pattern not recognized\n`;
            code += `    console.log('ℹ️ This step needs manual implementation');\n`;
        }
        
        code += `    console.log('✅ Step ${stepNumber} completed');\n`;
        code += '\n';
    }
    
    // Enhanced verification steps
    const expectedComment = expected.split(/\r?\n/).map(line => `    // Verification: ${line}`).join("\n");
    code += `${expectedComment}\n`;
    
    if (expected.toLowerCase().includes('landing page works') || expected.toLowerCase().includes('page works')) {
        code += `    // Verify landing page is working correctly using page object\n`;
        code += `    await landingPage.verifyPageHealth();\n`;
    } else if (expected.toLowerCase().includes('login') && expected.toLowerCase().includes('success')) {
        code += `    await expect(page).toHaveURL(/dashboard|home|welcome/);\n`;
        code += `    const successElement = await page.locator('text=welcome, dashboard, logout').first();\n`;
        code += `    await expect(successElement).toBeVisible();\n`;
    } else if (expected.toLowerCase().includes('search result') || expected.toLowerCase().includes('article') || expected.toLowerCase().includes('product') || expected.toLowerCase().includes('cart')) {
        const expectedQuery = primaryQuery || "";
        code += `    await expect(page.locator('body')).toBeVisible();\n`;
        if (expectedQuery) {
            code += `    await expect(page.locator('body')).toContainText(/${regexLiteralFromTerms(expectedQuery, subject)}/i);\n`;
        }
        code += `    const finalTitle = await page.title();\n`;
        code += `    expect(finalTitle.length).toBeGreaterThan(0);\n`;
    } else if (expected.toLowerCase().includes('redirect')) {
        code += `    await page.waitForLoadState('networkidle');\n`;
        code += `    const currentUrl = page.url();\n`;
        code += `    expect(currentUrl).not.toBe('https://www.calm.com/'); // Should have redirected\n`;
    } else {
        code += `${commentBlock("Custom verification for: ", expected)}\n`;
        code += `    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });\n`;
        code += `    console.log('Custom verification completed with generic page visibility check');\n`;
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

    // Read the scenario snapshot created by ingestion. This keeps generation tied
    // to the exact text the user reviewed and confirmed in start_agent.mjs.
    const manualScenarioPath = path.join(repoRoot, "tests/generated-from-agentFallBack/scenario.txt");
    const scenarioSourcePath = fs.existsSync(mdPath) ? mdPath : manualScenarioPath;
    if (!fs.existsSync(scenarioSourcePath)) {
        console.error("❌ Manual scenario not found");
        process.exit(1);
    }

    const scenario = fs.readFileSync(scenarioSourcePath, "utf8");
    console.log(`📄 Read scenario from ${scenarioSourcePath}: ${scenario.substring(0, 100)}...`);

    // Generate generic test code
    const metadata = {
        pageId: effectivePageId,
        jiraKey: null,
        mode: 'generic',
        inputData: loadUserInputData()
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
5. Preserve or add the page interruption handler after navigation and before major scenario actions
6. Add any missing error handling
7. Return the complete, improved test code

GENERIC MODE GUIDELINES:
- Prefer semantic selectors: getByRole, getByLabel, getByText
- Use data-testid attributes when available
- Add proper waits for dynamic content
- Include meaningful assertions
- Structure tests for readability and maintenance
- Keep \`handlePageInterruptions(page)\` for cookie banners, privacy prompts, announcement modals, newsletter popups, overlays, and interstitials
- If \`inputDataProviders\` exists in the test, preserve it and use those values when filling form/input fields
- Do not require \`main\` or \`[role="main"]\` for generic page-load verification unless the snapshot proves it exists. Prefer \`body\` plus visible content such as headings, nav, article, section, or body.

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

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
