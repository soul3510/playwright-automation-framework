Subject: Verify main content presentation and navigation to secured demo
User: no user
Steps:
1. Navigate to page: https://automation-demo.beatwish.live/
2. Verify the main heading 'דמו תשתית LLM ו־Agents לאוטומציית QA.' is visible.
3. Verify the 'הוראות כניסה' (Login instructions) section is present and readable.
4. Click on the 'כניסה לדמו המאובטח' (Entry to the secured demo) navigation link.

Expected:
The main heading and login instructions section are clearly visible and readable.
The browser successfully navigates to 'https://qa-agent.work/'.
Reason: It's crucial for primary users (recruiters, hiring managers) to quickly understand the site's purpose and find the entry point to the actual demo. This validates the core user journey and ensures key information is accessible.

Additional:
Category: UI_E2E
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