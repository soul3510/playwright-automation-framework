Subject: Verify accessibility of the web check-in landing page for users with disabilities
User: no user
Steps:
1. Navigate to page: https://www.arkia.co.il/he/web-checkin-login?updateType=0
2. Activate the 'דילוג לתוכן המרכזי' (Skip to main content) link using keyboard navigation (e.g., Tab key then Enter)
3. Use an automated accessibility testing tool (e.g., Axe-core, Lighthouse Accessibility audit) to scan the page
4. Manually verify keyboard navigation through all interactive elements (e.g., navigation links, buttons, cookie banner close button)
5. Manually verify that the page's primary language is correctly identified for screen readers.

Expected:
The 'דילוג לתוכן המרכזי' link should successfully move the keyboard focus to the main content area of the page.
The page should pass all automated accessibility checks with no critical or serious violations (e.g., WCAG 2.1 AA standards).
All interactive elements should be reachable and operable via keyboard, with clear visual focus indicators.
Screen readers should correctly announce the page title ('צ'ק אין Online בארקיע לטיסות אילת בלבד') and the main heading ('צ'ק-אין לטיסה').
The HTML `lang` attribute should be correctly set to 'he' for Hebrew.
Reason: Ensuring the web check-in page is accessible allows all passengers, including those with visual impairments or motor disabilities, to independently initiate their check-in process, which is a critical step before a flight. This aligns with legal requirements and provides an inclusive user experience.

Additional:
Category: ACCESSIBILITY
Discovered page signals:
- Heading: צ'ק-אין לטיסה
- Element: a "דילוג לתוכן המרכזי"
- Element: div #header-main [role="presentation"] "טיסות וחופשות היעדים שלנו מידע לנוסעים מדיניות ביטולים צ'ק אין Check In Online"
- Element: nav [role="navigation"] "טיסות וחופשות היעדים שלנו מידע לנוסעים מדיניות ביטולים צ'ק אין Check In Online"
- Element: a #logo
- Element: div #navbarSupportedContent [role="menubar"] "טיסות וחופשות היעדים שלנו מידע לנוסעים מדיניות ביטולים צ'ק אין Check In Online"
- Element: li [role="listitem"] "טיסות וחופשות"
- Element: div [role="button"] "טיסות וחופשות"
- Element: li [role="listitem"] "היעדים שלנו"
- Element: div [role="button"] "היעדים שלנו"
- Element: li [role="listitem"] "מידע לנוסעים"
- Element: div [role="button"] "מידע לנוסעים"
- Element: li [role="listitem"] "מדיניות ביטולים"