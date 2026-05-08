Subject: Verify location and map-related data endpoints align with Headquarters Location section
User: no user
Steps:
1. On the profile page, identify API calls providing location data (addresses and coordinates for HQ)
2. Validate response includes headquartersAddress, city, country, latitude, longitude
3. Cross-check latitude/longitude values produce a plausible map point (e.g., within Netherlands for Leusden address) using a lightweight geo validation

Expected:
Location data contains a valid address and plausible coordinates; lat/long renderable by maps component
Reason: Headquarters location is shown textually and may be tied to map coordinates; ensure location data is consistent across map/service endpoints.

Additional:
Category: BE_API
Discovered page signals:
- Interruption handled before scan: safe button: Reject All
- Heading: Gnn Holding B.V. Credit Report
- Heading: Details
- Heading: Headquarters Location
- Heading: Industry Benchmark
- Heading: Financial Data
- Heading: Adverse payment profiles
- Heading: Directors/Shareholders Summary
- Heading: Current Directors
- Element: a
- Element: input
- Element: button
- Element: a "Free Trial"
- Element: a "Home >"
- Element: a "Netherlands >"
- Element: a "Science >"
- Element: a
- Element: a "Access full report"
- Element: a #secondary-cta "View Example Report"
- Element: a
- Element: a "hidden.hidden.hidden.hidden.hidden"