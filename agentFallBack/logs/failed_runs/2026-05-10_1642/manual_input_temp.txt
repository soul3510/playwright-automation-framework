Subject: Verify Presence of Essential HTTP Security Headers
User: no user
Steps:
1. Navigate to the homepage: https://solo.beatwish.live/
2. Inspect the HTTP response headers using browser developer tools (Network tab) or a proxy tool.

Expected:
The `X-Content-Type-Options` header should be present with a value of `nosniff`.
The `X-Frame-Options` header should be present with a value of `DENY` or `SAMEORIGIN` to prevent clickjacking.
A `Content-Security-Policy` (CSP) header should be present and configured to restrict script sources and other content, minimizing XSS risks.
Reason: Critical security headers like X-Content-Type-Options, X-Frame-Options, and Content-Security-Policy help mitigate common web vulnerabilities such as MIME-sniffing, clickjacking, and cross-site scripting, enhancing the overall security posture of the website.

Additional:
Category: SECURITY
Source page: https://solo.beatwish.live/
Discovered page signals:
- Heading: השכרת ציוד הגברה ותאורה לאירועים
- Heading: זוג רמקולים מוגברים
- Heading: עמדת דיג'יי
- Heading: Pioneer DDJ-400
- Heading: מיקסר Bluetooth
- Heading: מיקרופונים אלחוטיים
- Heading: סטנד תאורה ואפקטים
- Heading: מכונת עשן
- Element: a "דלגו לתוכן הראשי"
- Element: a "ציוד, הגברה, תאורה ודי ג׳יי לאירועים"
- Element: a "השכרת ציוד לארועים"
- Element: a "DJ - SOLO"
- Element: a "דברו איתי"
- Element: a "שלחו הודעה בוואטסאפ"
- Element: a "למחירון הציוד"
- Element: a "איך להרים את המסיבה ולשמור על אנרגיה גבוהה"
- Element: a "איך לבחור חבילת הגברה שמתאימה לגודל האירוע"
- Element: a "תכנון מוזיקלי נכון מתחיל בלוח זמנים מסודר"
- Element: a "לכל העדכונים"
- Element: a