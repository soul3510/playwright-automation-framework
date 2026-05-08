Subject: Check Directors/Shareholders endpoints return current directors
User: no user
Steps:
1. Navigate to https://www.creditsafe.com/business-index/en-gb/company/gnn-holding-bv-nl01855760
2. Identify API call that returns Directors/Shareholders data (Current Directors and Top Shareholders sections)
3. Verify response contains: list of directors with name, role, appointmentDate, status; list of top shareholders with name, shareholdingPercentage
4. Assert that at least one director entry is present and appointmentDate is a valid date

Expected:
Directors/Shareholders endpoint returns a non-empty list with required fields and valid dates
Reason: Directors and shareholders are critical for risk assessment; ensure endpoint returns up-to-date roster with roles and appointment dates.

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