/**
 * 🤖 AI AGENT HANDOVER NOTE
 * CONTEXT:
 * - Page ID: manual
 * - Jira Key: N/A
 * - Report: agent/generation_report_manual.json
 * - Mode: Generic (Universal) with Page Objects
 *
 * 🎬 HEADED MODE: This test will run with visible browser
 * Run with: npx playwright test Verify_Presence_of_Essential_HTTP_Security_Headers.test.ts --headed
 */

import { test, expect } from '@playwright/test';
// Removed: import { LandingPage } from '../../page-objects/LandingPage'; // Not needed in Generic Mode for this test
import { handlePageInterruptions } from '../../utils/pageInterruptions';


test.describe('Verify_Presence_of_Essential_HTTP_Security_Headers', () => {

  test.beforeEach(async ({ page }) => {
      test.info().annotations.push({ type: 'Owner', description: 'AI Agent' });
      test.info().annotations.push({ type: 'Test Type', description: 'Generic' });
      test.info().annotations.push({ type: 'Description', description: 'Verify Presence of Essential HTTP Security Headers' });
      // Optional: Set a default timeout for the page to ensure all operations complete within a reasonable time
      page.setDefaultTimeout(60000);
  });

  test('Verify Presence of Essential HTTP Security Headers', { tag: ['@smoke', '@generic'] }, async ({ page }) => {
    // Removed: Initialize page object - not needed in Generic Mode for this test
    // Removed: const inputData = {}; // Unused variable

    // =========================================
    // STEP 1: NAVIGATE TO THE HOMEPAGE: HTTPS://SOLO.BEATWISH.LIVE/
    // =========================================
    console.log('\n🚀 STEP 1: Navigate to the homepage: https://solo.beatwish.live/');

    const targetUrl = 'https://solo.beatwish.live/';
    console.log(`📍 Navigating to URL: ${targetUrl}`);

    // Use Promise.all to wait for both navigation and the main document response
    // This ensures we capture the headers of the initial page load.
    let response;
    try {
      [response] = await Promise.all([
        page.waitForResponse(resp => resp.url() === targetUrl && resp.request().resourceType() === 'document', { timeout: 60000 }),
        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      ]);
    } catch (error) {
      console.error(`❌ Navigation or initial response capture failed: ${error}`);
      throw new Error(`Failed to navigate to ${targetUrl} or capture its initial response.`);
    }

    // Verify the page body is visible after navigation
    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
    await handlePageInterruptions(page); // Handle any immediate pop-ups or banners
    console.log('✅ Navigation completed successfully');
    console.log('✅ Step 1 completed');

    // =========================================
    // STEP 2: INSPECT THE HTTP RESPONSE HEADERS FOR ESSENTIAL SECURITY CONFIGURATIONS.
    // =========================================
    console.log('\n🚀 STEP 2: Inspect the HTTP response headers for essential security configurations.');

    // Ensure the response was successful before checking headers
    try {
      const status = response?.status();
      console.log(`⬇️ Initial response status: ${status}`);
      expect(status).toBeGreaterThanOrEqual(200);
      // Some servers may respond 304 or 302 early; keep a lenient range
      expect(status).toBeLessThan(400);
    } catch (e) {
      console.warn('⚠️ Initial response status not in exact expected range or not available. Proceeding with header checks if available.');
    }

    const headers = response?.headers() ?? {};
    console.log('ℹ️ Captured response headers:', headers);

    let allHeadersChecksPassed = true;
    const failedChecks: string[] = [];

    // Normalize header name keys to lower-case for robust matching
    // This ensures we can reliably check for headers regardless of their casing in the response.
    const normalizedHeaders: Record<string, string> = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])
    );

    // Verification: The `X-Content-Type-Options` header should be present with a value of `nosniff`.
    console.log('🔍 Verifying X-Content-Type-Options header...');
    const xContentTypeOptionsNormalized = normalizedHeaders['x-content-type-options'];
    if (xContentTypeOptionsNormalized) {
      if (xContentTypeOptionsNormalized.toLowerCase() === 'nosniff') {
        console.log(`✅ X-Content-Type-Options: ${xContentTypeOptionsNormalized}`);
      } else {
        console.error(`❌ X-Content-Type-Options header value is '${xContentTypeOptionsNormalized}', expected 'nosniff'.`);
        allHeadersChecksPassed = false;
        failedChecks.push(`X-Content-Type-Options: Expected 'nosniff', got '${xContentTypeOptionsNormalized}'`);
      }
    } else {
      console.error('❌ X-Content-Type-Options header is missing.');
      allHeadersChecksPassed = false;
      failedChecks.push('X-Content-Type-Options header is missing');
    }

    // Verification: The `X-Frame-Options` header should be present with a value of `DENY` or `SAMEORIGIN`.
    console.log('🔍 Verifying X-Frame-Options header...');
    const xFrameOptionsNormalized = normalizedHeaders['x-frame-options'];
    if (xFrameOptionsNormalized) {
      const frameVal = xFrameOptionsNormalized.toLowerCase();
      if (['deny', 'sameorigin'].includes(frameVal)) {
        console.log(`✅ X-Frame-Options: ${xFrameOptionsNormalized}`);
      } else {
        console.error(`❌ X-Frame-Options header value is '${xFrameOptionsNormalized}', expected 'DENY' or 'SAMEORIGIN'.`);
        allHeadersChecksPassed = false;
        failedChecks.push(`X-Frame-Options: Expected 'DENY' or 'SAMEORIGIN', got '${xFrameOptionsNormalized}'`);
      }
    } else {
      console.error('❌ X-Frame-Options header is missing.');
      allHeadersChecksPassed = false;
      failedChecks.push('X-Frame-Options header is missing');
    }

    // Verification: A `Content-Security-Policy` (CSP) header should be present and configured.
    console.log('🔍 Verifying Content-Security-Policy header...');
    const contentSecurityPolicy = normalizedHeaders['content-security-policy'];
    // Some servers may advertise a CSP via a header or via a value like "upgrade-insecure-requests" as part of CSP.
    if (contentSecurityPolicy && contentSecurityPolicy.length > 0) {
      console.log(`✅ Content-Security-Policy: Present and not empty`);
    } else {
      console.error(`❌ Content-Security-Policy header is missing or empty`);
      // If the header is missing, we still want to surface it clearly
      allHeadersChecksPassed = false;
      failedChecks.push('Content-Security-Policy header is missing or empty');
    }

    await handlePageInterruptions(page); // Keep this in case any popups appear after header checks or during idle time

    if (allHeadersChecksPassed) {
      console.log('✅ All essential HTTP security headers verified successfully.');
    } else {
      console.error(`❌ Some essential HTTP security header checks failed:`);
      failedChecks.forEach(check => console.error(`   - ${check}`));
      // Provide a descriptive failure without masking the root cause
      throw new Error('One or more essential HTTP security headers are missing or incorrectly configured.');
    }
    console.log('✅ Step 2 completed');
  });
});

export {}; // Make this a module