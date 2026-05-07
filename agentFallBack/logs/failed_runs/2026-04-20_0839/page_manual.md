SUBJECT: Verify Crossix admin can create a brand with a name that exists for a different client for an active, advertiser-type client
User: Crossix admin

Steps that exists:
1. Open https://qa-beta.veevacrossix.com
2. Click on the setting gear and select Applications
3. Open left side menu and Select Brands
4. Click on the plus button  (img[alt='Add Item']) - a modal will open: document.querySelector(".Dialog_wizardDialogTitle__BZoTG"). Verify title: "Add Application
" (.Dialog_wizardDialogTitle__BZoTG)
5. Select an active advertiser-type client from the "Select Client" dropdown (span[id='clientName-accessibility-id'] span[class='k-input-value-text'])
6. Enter a brand name that already exists for a different, advertiser-type client (span[id='brandName-accessibility-id'] span[class='k-input-value-text'])
7. Click on "Create" button.
8. Roll back and delete the created brand from DB.


Expected Result:
-Brand is added to the database under the selected client
-Brand is visible in the UI upon creation for both the new record and the already existing record, each with distinct client

Additional data:
confluence page id: 5570297857 - Scenario #3
the name of the test file should start with "t3_"