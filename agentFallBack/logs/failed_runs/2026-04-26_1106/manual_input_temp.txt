SUBJECT: Verify Crossix admin cannot create client (advertiser) with an existing, active client's Client Name
Users: Crossix admin

Steps that exists:
1. Click on the settings gear
2. Choose "Applications"
3. Open left side menu and Select "Clients" from the view dropdown
4. Click on the plus button to add a new client
5. Input a new Client Name that matches an existing, active Client Name (publisher type)
6. Click Add

Expected Result:
Client Name input box should turn red, with red error message below it: "Client already exists"
No change is made in the database
No change in the UI
Verify this is rejected via swagger as well

Additional data:
Test file name will begin with "t3_".
Test should be placed inside tests/a3-settings/instance-creation/application-management/client/DNT-1112
Get inspiration from the tests inside tests/a3-settings/instance-creation/application-management/client/DNT-1112

