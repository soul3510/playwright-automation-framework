SUBJECT: Verify Crossix admin can edit client name and URL for clients (publisher)
Users: Crossix admin

Steps that exists:
1. Click on the settings gear
2. Choose "Applications"
3. Open left side menu and Select "Clients" from the view dropdown
4. Click on Actions > Edit for one of the publisher rows
5. Change the client name to be another unique client name and change the UR

Expected Result:
-Client object is maintained in the database with the same data, aside from successful naming change
-New client name is visible in the UI upon creation
-Old client name is no longer visible in the UI
-URL has changed

Additional data:
Test file name will begin with "t6_".
Get inspiration from the tests inside tests/a3-settings/instance-creation/application-management/client/DNT-1112

