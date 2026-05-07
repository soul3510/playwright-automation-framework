SUBJECT: Verify Crossix admin cannot create a brand with a name that already exists for the same active client
User: Crossix admin

Steps that exists:
  1. Finds an Existing Brand and Client: It queries the database to dynamically find a brand that is already linked to an active client.
   2. UI Validation:
      - It navigates to the Brand creation modal.
      - It selects the owner client and inputs the exact same brand name.
      - It checks that a red error message is displayed containing "Brand already exists for [Client]".
      - It validates that the Create button is disabled (greyed out and unclickable).
   3. Database Validation: It queries the database again at the end of the test to assert that the count of this brand for this client remains exactly 1 (no change in the database).
   4. API Validation (Swagger Equivalent): Using the test's page.request context, it issues a POST request directly to /api/v1/brands?clientId={id} with the duplicate payload and asserts that the API correctly rejects it (a non-200 status code) and contains the "already exists" validation
      message in the response body.


Expected Result:
-Brand Name input box should turn red, with red error message below it: "Brand already exists for [Client]"
-Create button should become greyed out and unclickable
-No change is made in the database
-No change in the UI

Verify this is rejected via swagger as well
Additional data:
confluence page id: 5570297857 - Scenario #4
the name of the test file should start with "t4_"