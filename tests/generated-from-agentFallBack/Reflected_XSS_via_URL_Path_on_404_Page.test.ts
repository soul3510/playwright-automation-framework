/**
 * 🤖 AI AGENT HANDOVER NOTE
 * CONTEXT:
 * - Page ID: manual
 * - Jira Key: N/A
 * - Report: agent/generation_report_manual.json
 * - Mode: Generic (Universal) with Page Objects
 *
 * 🎬 HEADED MODE: This test will run with visible browser
 * Run with: npx playwright test Reflected_XSS_via_URL_Path_on_404_Page.test.ts --headed
 */

import { test, expect } from '@playwright/test';
// Removed: import { LandingPage } from '../../page-objects/LandingPage'; // Not needed in Generic Mode
import { handlePageInterruptions } from '../../utils/pageInterruptions';


test.describe('Reflected_XSS_via_URL_Path_on_404_Page', () => {

  // Define the malicious payload and the full URL for clarity and reusability
  const xssPayload = "<script>alert('XSS')</script>";
  // Encode the payload for URL path injection
  const encodedXssPayload = encodeURIComponent(xssPayload); // Results in %3Cscript%3Ealert('XSS')%3C/script%3E
  const baseUrl = 'https://solo.beatwish.live/updates/';
  const craftedUrl = `${baseUrl}${encodedXssPayload}`;

  // Common text patterns to identify a 404 Not Found page
  // FIX: Updated to include exact text from the MCP snapshot for robustness
  const expected404TextPattern = /This Page Does Not Exist|Sorry, the page you are looking for could not be found|404|page not found|error|not found/i;

  test.beforeEach(async ({ page }) => { // Added 'page' to beforeEach to enable dialog listener setup
      test.info().annotations.push({ type: 'Owner', description: 'AI Agent' });
      test.info().annotations.push({ type: 'Test Type', description: 'Generic' });
      test.info().annotations.push({ type: 'Description', description: 'Reflected XSS via URL Path on 404 Page' });
      test.info().annotations.push({ type: 'Severity', description: 'High' }); // XSS is a high severity vulnerability

      // Set up a dialog listener to catch any alert boxes.
      // If an alert is triggered, it indicates successful XSS execution, and the test should fail.
      page.on('dialog', async dialog => {
          console.error(`❌ XSS Alert Detected! Type: ${dialog.type}, Message: ${dialog.message}`);
          await dialog.dismiss(); // Dismiss the dialog to prevent the test from hanging
          test.fail(`XSS payload executed: An alert dialog with message "${dialog.message}" was triggered.`);
      });
      console.log('✅ Dialog listener set up to detect XSS alerts before navigation.');
  });

  test('Reflected XSS via URL Path on 404 Page', { tag: ['@smoke', '@generic', '@security'] }, async ({ page }) => {
    // Removed: const landingPage = new LandingPage(page); // Not needed in Generic Mode
    // Removed: const inputData = {}; // Not used in this test

    // =========================================
    // STEP 1: NAVIGATE TO A CRAFTED URL
    // =========================================
    console.log(`\n🚀 STEP 1: Navigate to a crafted URL: ${craftedUrl}`);

    console.log(`📍 Navigating to URL: ${craftedUrl}`);
    // Navigate to the URL with the encoded XSS payload in the path
    await page.goto(craftedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Assert that the page loaded successfully and is visible
    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
    await handlePageInterruptions(page); // Handle any initial pop-ups (e.g., cookie banners)

    // Verify that the page is indeed a 404 page by looking for common text indicators
    // FIX: The previous locator `page.getByText(expected404TextPattern, { exact: false })`
    // caused a strict mode violation because it matched both the <h1> and <p> elements.
    // We will now specifically target the <h1> element for robustness.
    const four04PageHeading = page.getByRole('heading', { name: 'This Page Does Not Exist' });
    console.log('ℹ️ Waiting for the 404 page heading "This Page Does Not Exist" to be visible.');
    await four04PageHeading.waitFor({ state: 'visible', timeout: 10000 }); // Smart wait for the element to be visible
    await expect(four04PageHeading)
      .toBeVisible({ timeout: 10000 }); // Re-assert visibility
    console.log('✅ Navigation completed successfully and 404 page heading detected.');
    console.log('✅ Step 1 completed');

    // =========================================
    // STEP 2: OBSERVE THE BROWSER'S BEHAVIOR AND PAGE SOURCE FOR INJECTED SCRIPT
    // =========================================
    console.log('\n🚀 STEP 2: Observe the browser\'s behavior (e.g., check for an alert box) and the page source for the injected script.');

    await handlePageInterruptions(page); // Handle any pop-ups that might appear after initial load

    // Verification 1: No alert box should have appeared.
    // This is implicitly handled by the `page.on('dialog')` listener in `beforeEach`.
    // If an alert appears, the test will fail immediately.
    console.log('ℹ️ Alert box check is handled by the global dialog listener in beforeEach. If an alert appears, the test will fail immediately.');

    // Verification 2: The injected string should be properly escaped or encoded in the HTML response.
    // We need to check the page's content to ensure the script tag is not rendered as executable HTML.
    // Wait for network to be idle to ensure all dynamic content is loaded before inspecting the DOM.
    await page.waitForLoadState('networkidle');

    const pageContent = await page.content(); // Get the full HTML content of the page

    // Primary XSS Assertion: The raw, unescaped XSS payload should NOT be present in the page's HTML.
    // If it is, the browser would parse it as an executable script, indicating a vulnerability.
    expect(pageContent, `Expected raw XSS payload "${xssPayload}" NOT to be found in page content, indicating XSS vulnerability.`)
      .not.toContain(xssPayload);
    console.log(`✅ Verification: Raw XSS payload "${xssPayload}" was NOT found in the page content, confirming no direct script injection.`);

    // Secondary XSS Assertion: The previous assertion expected the *escaped* XSS payload to be present
    // in the page content. However, the application's 404 page does not reflect the URL path in its HTML body.
    // If the payload is not reflected at all, expecting its escaped version to be present is incorrect
    // and causes the test to fail even when there is no XSS vulnerability.
    // The absence of the raw payload and the lack of an alert are sufficient to confirm no XSS.
    // Therefore, this assertion is removed.
    // const escapedXssPayloadInHtml = xssPayload
    //     .replace(/</g, '&lt;') // Escape '<' to '&lt;'
    //     .replace(/>/g, '&gt;') // Escape '>' to '&gt;'
    //     .replace(/"/g, '&quot;') // Escape '"' to '&quot;'
    //     .replace(/'/g, '&#39;'); // Escape ''' to '&#39;'

    // expect(pageContent, `Expected escaped XSS payload "${escapedXssPayloadInHtml}" to be found in page content, confirming safe reflection.`)
    //   .toContain(escapedXssPayloadInHtml);
    console.log('ℹ️ Secondary XSS assertion for safe reflection in page content skipped as the payload is not reflected by the application.');


    // Final URL Verification: The current URL should still be the crafted URL,
    // confirming that no unexpected redirection to a "safe" page occurred.
    const currentUrl = page.url();
    expect(currentUrl, `Expected current URL to be "${craftedUrl}" but found "${currentUrl}", indicating an unexpected redirection.`)
      .toBe(craftedUrl);
    console.log(`✅ Verification: Current URL "${currentUrl}" matches the crafted URL, confirming no unexpected redirection.`);

    console.log('✅ Step 2 completed: XSS vulnerability checks passed successfully.');
  });
});

export {}; // Make this a module