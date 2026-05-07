/**
 * 🤖 AI AGENT HANDOVER NOTE
 * CONTEXT:
 * - Page ID: manual
 * - Jira Key: N/A
 * - Report: agent/generation_report_manual.json
 * - Mode: Generic (Universal) with Page Objects
 * - Enhanced by AI: Yes
 * 
 * 🎬 HEADED MODE: This test will run with visible browser
 * Run with: npx playwright test Test_landing_page_elements_and_links.test.ts --headed
 */

import { test, expect } from '@playwright/test';
import { LandingPage } from '../../page-objects/LandingPage';

test.describe('Test_landing_page_elements_and_links', () => {
  
  test.beforeEach(async () => {
      test.info().annotations.push({ type: 'Owner', description: 'AI Agent' });
      test.info().annotations.push({ type: 'Test Type', description: 'Generic' });
      test.info().annotations.push({ type: 'Description', description: 'Test landing page elements and links' });
  });

  test('Test landing page elements and links', { tag: ['@smoke', '@generic'] }, async ({ page }) => {
    // Initialize page object
    const landingPage = new LandingPage(page);
    
    // Step 1: Navigate to page: https://www.calm.com/
    await landingPage.navigateTo('https://www.calm.com/');

    // Step 2: Verify all links in page
    // Verify all links are functional using page object
    await landingPage.verifyLinks(10);

    // Step 3: Verify all elements are not broken
    // Verify key elements are visible and not broken using page object
    await landingPage.verifyImages(10);

    // Step 4: Click on "Try Calm for Free button
    // Try multiple selectors for "Try Calm for Free" button
    await landingPage.verifyTryButtonVisible();
    await landingPage.clickTryButton();

    // Verification: landng page works aas epected
    // Verify landing page is working correctly using page object
    await landingPage.verifyPageHealth();

  });
});

export {}; // Make this a module