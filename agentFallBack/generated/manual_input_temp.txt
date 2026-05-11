Subject: Verify successful search for an English article and redirection.
User: no user
Steps:
1. Navigate to page: https://www.wikipedia.org/
2. Type 'Artificial Intelligence' into the search input field with id 'searchInput'.
3. Ensure the language dropdown with id 'searchLanguage' is set to 'English' (or its default value).
4. Click the 'Search' button (element with type='submit').

Expected:
The browser navigates to 'https://en.wikipedia.org/wiki/Artificial_intelligence' (or a similar direct article page).
The page title contains 'Artificial intelligence - Wikipedia'.
The main heading of the article is 'Artificial intelligence'.
Reason: The search functionality is the core method for users to find information. Ensuring it works correctly, especially for common terms, is critical for user experience.

Additional:
Category: UI_E2E
Source page: https://www.wikipedia.org/
Discovered page signals:
- Heading: Wikipedia The Free Encyclopedia
- Heading: 1,000,000+ articles
- Heading: 100,000+ articles
- Heading: 10,000+ articles
- Heading: 1,000+ articles
- Heading: 100+ articles
- Element: a #js-link-box-en "English 7,177,000+ articles"
- Element: a #js-link-box-ja "日本語 1,500,000+ 記事"
- Element: a #js-link-box-de "Deutsch 3.118.000+ Artikel"
- Element: a #js-link-box-zh "中文 1,533,000+ 条目 / 條目"
- Element: a #js-link-box-ru "Русский 2 098 000+ статей"
- Element: a #js-link-box-fr "Français 2 755 000+ articles"
- Element: a #js-link-box-es "Español 2.110.000+ artículos"
- Element: a #js-link-box-it "Italiano 1.967.000+ voci"
- Element: a #js-link-box-pt "Português 1.170.000+ artigos"
- Element: a #js-link-box-pl "Polski 1 693 000+ haseł"
- Element: div [role="search"] "Search Wikipedia EN Afrikaans Shqip العربية Asturianu Azərbaycanca Български 閩南語 / Bân-lâm-gú বাংলা Беларуская Català Če"
- Element: input #searchInput [name="search"]