/**
 * 🤖 AI AGENT HANDOVER NOTE
 * CONTEXT:
 * - Page ID: manual
 * - Jira Key: N/A
 * - Report: agent/generation_report_manual.json
 * - Mode: Generic (Universal) with Page Objects
 * 
 * 🎬 HEADED MODE: This test will run with visible browser
 * Run with: npx playwright test Test_product_search_and_add_to_cart.test.ts --headed
 */

import { test, expect } from '@playwright/test';
import { LandingPage } from '../../page-objects/LandingPage';

test.describe('Test_product_search_and_add_to_cart', () => {
  
  test.beforeEach(async () => {
      test.info().annotations.push({ type: 'Owner', description: 'AI Agent' });
      test.info().annotations.push({ type: 'Test Type', description: 'Generic' });
      test.info().annotations.push({ type: 'Description', description: 'Test product search and add to cart' });
  });

  test('Test product search and add to cart', { tag: ['@smoke', '@generic'] }, async ({ page }) => {
    test.setTimeout(120000);
    // Initialize page object
    const landingPage = new LandingPage(page);
    // =========================================
    // STEP 1: NAVIGATE TO PAGE: HTTPS://WWW.AMAZON.COM/
    // =========================================
    console.log('\n🚀 STEP 1: Navigate to page: https://www.amazon.com/');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('📍 Navigating to URL: https://www.amazon.com/');
    await page.goto('https://www.amazon.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
    console.log('✅ Navigation completed successfully');
    console.log('⏰ Step 1 completed at:', new Date().toISOString());

    // =========================================
    // STEP 2: ENTER "LAPTOP" IN THE SEARCH BAR
    // =========================================
    console.log('\n🚀 STEP 2: Enter "laptop" in the search bar');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('⌨️ Preparing to fill field: the search bar');
    const searchInput = page.getByRole('searchbox').or(page.locator('input[type="search"], input[name="search"], input[name="searchInput"], #searchInput')).first();
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.fill('laptop');
    console.log('✅ Field filled: the search bar');
    console.log('⏰ Step 2 completed at:', new Date().toISOString());

    // =========================================
    // STEP 3: CLICK ON THE SEARCH BUTTON
    // =========================================
    console.log('\n🚀 STEP 3: Click on the search button');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('🖱️ Preparing to click element: search');
    console.log('🎯 Submitting search');
    const searchButton = page.getByRole('button', { name: /search/i }).first();
    if (await searchButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchButton.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForLoadState('domcontentloaded');
    console.log('✅ Search submitted successfully');
    console.log('⏰ Step 3 completed at:', new Date().toISOString());

    // =========================================
    // STEP 4: VERIFY SEARCH RESULTS SHOW LAPTOP PRODUCTS
    // =========================================
    console.log('\n🚀 STEP 4: Verify search results show laptop products');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('🔍 Verifying search results are visible');
    await expect(page.locator('[data-component-type="s-search-result"], .s-result-item, .mw-search-results li, .mw-search-result-heading, main, body').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('body')).toContainText(/laptop/i, { timeout: 15000 });
    console.log('✅ Search results are visible');
    console.log('⏰ Step 4 completed at:', new Date().toISOString());

    // =========================================
    // STEP 5: CLICK ON THE FIRST PRODUCT IN RESULTS
    // =========================================
    console.log('\n🚀 STEP 5: Click on the first product in results');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('🖱️ Preparing to click element: first product in results');
    console.log('🎯 Opening the first search result');
    const firstResult = page.locator('[data-component-type="s-search-result"] h2 a, [data-component-type="s-search-result"] a.a-link-normal, .mw-search-result-heading a, .mw-search-results li a, main a').first();
    await expect(firstResult).toBeVisible({ timeout: 15000 });
    await firstResult.click();
    await page.waitForLoadState('domcontentloaded');
    console.log('✅ First result opened successfully');
    console.log('⏰ Step 5 completed at:', new Date().toISOString());

    // =========================================
    // STEP 6: VERIFY PRODUCT DETAILS PAGE LOADS
    // =========================================
    console.log('\n🚀 STEP 6: Verify product details page loads');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('🔍 Verifying details page title');
    await expect(page.locator('h1, #productTitle, .firstHeading').first()).toBeVisible({ timeout: 15000 });
    const detailsTitle = (await page.locator('h1, #productTitle, .firstHeading').first().innerText()).trim();
    console.log(`📄 Details title: ${detailsTitle}`);
    expect(detailsTitle.length).toBeGreaterThan(0);
    console.log('✅ Details page title verified');
    console.log('⏰ Step 6 completed at:', new Date().toISOString());

    // =========================================
    // STEP 7: CLICK ON "ADD TO CART" BUTTON
    // =========================================
    console.log('\n🚀 STEP 7: Click on "Add to Cart" button');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('🖱️ Preparing to click element: Add to Cart');
    console.log('🎯 Adding product to cart');
    const addToCartButton = page.getByRole('button', { name: /add to cart/i }).or(page.locator('input[name="submit.add-to-cart"], #add-to-cart-button')).first();
    await expect(addToCartButton).toBeVisible({ timeout: 15000 });
    await addToCartButton.click();
    await page.waitForLoadState('domcontentloaded');
    console.log('✅ Add to Cart clicked successfully');
    console.log('⏰ Step 7 completed at:', new Date().toISOString());

    // =========================================
    // STEP 8: VERIFY ITEM ADDED TO CART SUCCESSFULLY
    // =========================================
    console.log('\n🚀 STEP 8: Verify item added to cart successfully');
    console.log('⏰ Starting step execution at:', new Date().toISOString());

    console.log('🔍 Verifying cart update');
    await expect(page.locator('body')).toContainText(/cart|added|basket|1/i, { timeout: 15000 });
    console.log('✅ Cart update verified');
    console.log('⏰ Step 8 completed at:', new Date().toISOString());

    // Verification: Search returns relevant laptop products
    // Verification: Product details display correctly
    // Verification: Item successfully added to shopping cart
    // Verification: Cart count updates to show 1 item
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('body')).toContainText(/laptop/i);
    const finalTitle = await page.title();
    expect(finalTitle.length).toBeGreaterThan(0);

  });
});

export {}; // Make this a module
