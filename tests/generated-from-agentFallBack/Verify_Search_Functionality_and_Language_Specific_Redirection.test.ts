/**
 * 🤖 AI AGENT HANDOVER NOTE
 * CONTEXT:
 * - Page ID: manual
 * - Jira Key: N/A
 * - Report: agent/generation_report_manual.json
 * - Mode: Generic (Universal) with Page Objects
 * 
 * 🎬 HEADED MODE: This test will run with visible browser
 * Run with: npx playwright test Verify_Search_Functionality_and_Language_Specific_Redirection.test.ts --headed
 */

import { test, expect } from '@playwright/test';
// Removed: import { LandingPage } from '../../page-objects/LandingPage'; // Not used in generic mode as per guidelines
import { handlePageInterruptions } from '../../utils/pageInterruptions';

const inputDataProviders = [
  {
    "caseName": "case_1",
    "search": "war in iran",
    "language": "Hebrew"
  },
  {
    "caseName": "case_2",
    "search": "war in iran valid",
    "language": "Hebrew valid"
  },
  {
    "caseName": "case_3",
    "search": "war in iran 123",
    "language": "Hebrew 123"
  },
  {
    "caseName": "case_4",
    "search": "war in iran edge case",
    "language": "Hebrew edge case"
  },
  {
    "caseName": "case_5",
    "search": "war in iran long value for validation",
    "language": "Hebrew long value for validation"
  }
];

/**
 * Helper function to map input language string to Wikipedia UI text and language code.
 * This is crucial for dynamically selecting the correct language link and verifying the URL.
 * The `searchPagePath` accounts for variations in search result page URLs across languages.
 */
const getLanguageDetails = (inputLang: string) => {
  // Extract the base language name (e.g., "Hebrew" from "Hebrew valid")
  const baseLanguage = inputLang.split(' ')[0]; 

  switch (baseLanguage.toLowerCase()) {
    case 'hebrew':
      // For Hebrew, the UI text in the dropdown is 'עברית' and the langCode is 'he'.
      // The searchPagePath is for the search results page.
      return { uiText: 'עברית', langCode: 'he', searchPagePath: '(Spezial:Suche|מיוחד:חיפוש|Special:Search)' };
    case 'deutsch':
      return { uiText: 'Deutsch', langCode: 'de', searchPagePath: '(Spezial:Suche|מיוחד:חיפוש|Special:Search)' };
    case 'english':
      return { uiText: 'English', langCode: 'en', searchPagePath: '(Spezial:Suche|מיוחד:חיפוש|Special:Search)' };
    // Add more languages as needed. The searchPagePath is often similar across languages.
    default:
      // Fallback for unmapped languages, assuming English Wikipedia behavior
      console.warn(`Warning: Language "${inputLang}" not explicitly mapped. Defaulting to English.`);
      return { uiText: 'English', langCode: 'en', searchPagePath: '(Spezial:Suche|מיוחד:חיפוש|Special:Search)' };
  }
};


test.describe('Verify_Search_Functionality_and_Language_Specific_Redirection', () => {
  
  test.beforeEach(async () => {
      test.info().annotations.push({ type: 'Owner', description: 'AI Agent' });
      test.info().annotations.push({ type: 'Test Type', description: 'Generic' });
      test.info().annotations.push({ type: 'Description', description: 'Verify Search Functionality and Language-Specific Redirection' });
  });

  // Configure tests to run in parallel for efficiency, especially with multiple data providers
  test.describe.configure({ mode: 'parallel' }); 

  // Iterate over each data provider entry to run the test with different inputs
  for (const inputData of inputDataProviders) {
    test(`Verify Search for "${inputData.search}" in "${inputData.language}"`, { tag: ['@smoke', '@generic'] }, async ({ page }) => {
      
      const { uiText: languageUiText, langCode, searchPagePath } = getLanguageDetails(inputData.language);

      // =========================================
      // STEP 1: NAVIGATE TO PAGE: HTTPS://WWW.WIKIPEDIA.ORG/
      // =========================================
      console.log('\n🚀 STEP 1: Navigate to page: https://www.wikipedia.org/');

      console.log('📍 Navigating to URL: https://www.wikipedia.org/');
      await page.goto('https://www.wikipedia.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
      await handlePageInterruptions(page);
      console.log('✅ Navigation completed successfully');
      console.log('✅ Step 1 completed');

      // =========================================
      // STEP 2 (REVISED): SELECT LANGUAGE FROM THE DROPDOWN ON THE MAIN PAGE.
      // The original Step 2 was attempting to click a direct link, but the snapshot shows
      // 'עברית' as an option within a combobox (dropdown) for language selection.
      // This step is now revised to interact with that dropdown, which will trigger
      // navigation to the language-specific Wikipedia portal.
      // =========================================
      console.log(`\n🚀 STEP 2: Select language "${languageUiText}" from the dropdown.`);

      await handlePageInterruptions(page); // Handle any interruptions before interacting with language dropdown

      console.log(`🖱️ Preparing to select language: "${languageUiText}".`);
      // The language dropdown is typically an <select> element or a combobox.
      // Based on the snapshot and common Wikipedia structure, it has an ID 'searchLanguage'.
      const languageDropdown = page.locator('#searchLanguage');
      await expect(languageDropdown).toBeVisible({ timeout: 10000 });
      
      // Select the option by its visible text. This action will trigger navigation.
      await languageDropdown.selectOption({ label: languageUiText });
      
      // Wait for navigation to the language-specific Wikipedia domain
      await page.waitForURL(new RegExp(`^https://${langCode}\\.wikipedia\\.org/`), { timeout: 15000 });
      await expect(page).toHaveURL(new RegExp(`^https://${langCode}\\.wikipedia\\.org/`));
      await handlePageInterruptions(page); // Handle interruptions on the newly navigated page
      console.log(`✅ Navigated to ${langCode}.wikipedia.org successfully.`);
      console.log('✅ Step 2 completed');

      // =========================================
      // STEP 3 (REVISED): TYPE SEARCH TERM INTO THE SEARCH INPUT FIELD.
      // This step now occurs on the language-specific Wikipedia page after redirection.
      // =========================================
      console.log(`\n🚀 STEP 3: Type "${inputData.search}" into the search input field.`);

      await handlePageInterruptions(page); // Handle any interruptions before filling the search field

      console.log('⌨️ Preparing to fill field: the search input field.');
      // Using a robust selector for the search input field, considering different roles and IDs/names
      const searchInput = page.getByRole('searchbox', { name: /search|بحث|חיפוש|Suche|Search Wikipedia/i })
                              .or(page.locator('input[type="search"], input[name="search"], input[name="searchInput"], #searchInput'))
                              .first();
      await expect(searchInput).toBeVisible({ timeout: 10000 });
      await searchInput.fill(inputData.search);
      console.log(`✅ Field filled: "${inputData.search}" into the search input field.`);
      console.log('✅ Step 3 completed');

      // =========================================
      // STEP 4: CLICK THE 'SEARCH' BUTTON.
      // =========================================
      console.log('\n🚀 STEP 4: Click the \'Search\' button.');

      await handlePageInterruptions(page); // Handle any interruptions before clicking the search button

      console.log('🖱️ Preparing to click element: Search button.');
      // Using a robust selector for the search button, considering different languages and roles
      const searchButton = page.getByRole('button', { name: /search|بحث|חיפוש|Suche|Search/i }).first();
      
      // Attempt to click the button, or press Enter as a fallback for robustness
      if (await searchButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await searchButton.click();
      } else {
        console.log('ℹ️ Search button not found or not visible, pressing Enter key as fallback.');
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('domcontentloaded'); // Wait for the search results page to load
      await handlePageInterruptions(page); // Handle interruptions on the search results page
      console.log('✅ Search submitted successfully');
      console.log('✅ Step 4 completed');

      // =========================================
      // VERIFICATION:
      // =========================================
      console.log('\n🔍 VERIFICATION: Checking search results and URL.');

      // Verification: The browser navigates to the language-specific search results URL.
      // The regex accounts for variations in the search path (e.g., Spezial:Suche, מיוחד:חיפוש)
      const expectedUrlRegex = new RegExp(`^https://${langCode}\\.wikipedia\\.org/wiki/${searchPagePath}\\?search=${encodeURIComponent(inputData.search)}`, 'i');
      await expect(page).toHaveURL(expectedUrlRegex, { timeout: 15000 });
      console.log(`✅ Verified URL for ${langCode}.wikipedia.org and search term: ${page.url()}`);

      // Verification: The search results page in the selected language is displayed,
      // showing articles related to the search term.
      await expect(page.locator('body')).toBeVisible();
      
      // Check for the original search term in the page body.
      // Using `replace(/\s/g, '\\s?')` to make the regex flexible for varying spaces.
      await expect(page.locator('body')).toContainText(new RegExp(inputData.search.replace(/\s/g, '\\s?'), 'i'));
      console.log(`✅ Verified page content contains original search term: "${inputData.search}".`);

      // Verify the page title contains the search term.
      const finalTitle = await page.title();
      expect(finalTitle.length).toBeGreaterThan(0);
      expect(finalTitle).toContain(inputData.search); 
      console.log(`✅ Verified page title contains search term: "${finalTitle}".`);
      console.log('✅ All verifications passed.');
    });
  }
});

export {}; // Make this a module