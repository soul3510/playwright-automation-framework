Subject: Verify language toggle button accessibility attributes
User: no user
Steps:
1. Navigate to page: https://automation-demo.beatwish.live/
2. Inspect the '🌐 English' button element with `id='languageToggle'`.

Expected:
The '🌐 English' button has an `aria-label` attribute set to 'Change language'.
The button is focusable via keyboard navigation (e.g., using Tab key).
Reason: The site is primarily in Hebrew but offers an English toggle. Ensuring the language toggle is accessible (e.g., for screen readers) is important for international users or users with disabilities, demonstrating inclusive design.

Additional:
Category: ACCESSIBILITY
Source page: https://automation-demo.beatwish.live/
Discovered page signals:
- Heading: דמו תשתית LLM ו־Agents לאוטומציית QA.
- Heading: הוראות כניסה
- Heading: קצת עליי
- Heading: מה אני ממליץ לראות בזמן הדמו
- Element: button #languageToggle "🌐 English"
- Element: a "מה חשוב לראות"
- Element: a "כניסה לדמו המאובטח"
- Element: a "in לפרופיל הלינקדאין שלי"