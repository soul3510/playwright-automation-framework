SUBJECT: Verify Assign Access Group to user
User: admin

Steps:
1. Open https://qa-beta.veevacrossix.com/Manage/AccessGroups/4
2. Click on random "More Details" (data-hook="navigate-to-access-group-details")
3. Click on "Assigned Users" button
4. click on "Manage Users" link (a href)
5. Verify that a new tab was opened that contains "Manage/Users/4" in it's link
6. in the new opened tab click on random "More Details" (data-hook="navigate-to-user-details")
7. in the new opened tab Click on edit button (data-hook="edit-button")
8. in the new opened tab Click on "Access" button (data-hook="user-details-panes-sidebar-item")
9. in the new opened tab choose random empty checkbox input (type="checkbox") and click on it.
10. in the new opened tab click on "Save" (data-hook="Save-button")
11. verify that the API: "https://qa-beta.veevacrossix.com/api/v1/businessGroupAccess/user/campaign/tree?userId={user id}" got 200
12. Verify that the new added check box name is exists in the response after saving.
13. Roll back the change by unchecking the checkbox from step 9.

