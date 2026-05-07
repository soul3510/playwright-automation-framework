import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './BasePage';

export class LandingPage extends BasePage {
    // Selectors
    private readonly tryButtonSelector: Locator;
    private readonly loginButtonSelector: Locator;
    private readonly signInButtonSelector: Locator;
    private readonly linksSelector: Locator;
    private readonly imagesSelector: Locator;
    private readonly headerSelector: Locator;

    constructor(page: Page) {
        super(page);
        this.tryButtonSelector = page.locator('button:has-text("Try Calm for Free")').first();
        this.loginButtonSelector = page.locator('button:has-text("Login"), button:has-text("Login In"), button:has-text("Log In"), a:has-text("Login"), a:has-text("Log In")').first();
        this.signInButtonSelector = page.locator('button:has-text("Sign In"), button:has-text("Sign in"), a:has-text("Sign In")').first();
        this.linksSelector = page.locator('a[href]');
        this.imagesSelector = page.locator('img');
        this.headerSelector = page.locator('header, .header, nav');
    }

    // Page Actions
    async navigateTo(url: string): Promise<void> {
        await this.page.goto(url);
        await this.waitForPageLoad();
    }

    async clickTryButton(): Promise<void> {
        await this.clickElement(this.tryButtonSelector);
        await this.waitForPageLoad();
    }

    async clickLoginButton(): Promise<void> {
        const loginLocators = [
            this.page.getByRole('link', { name: /^(log in|login|sign in)$/i }).first(),
            this.page.getByRole('button', { name: /^(log in|login|sign in)$/i }).first(),
            this.loginButtonSelector,
            this.page.locator('a[href*="sign_in"], a[href*="login"]').first(),
            this.page.locator('[data-testid*="login" i], [class*="login" i], [href*="login" i]').first()
        ];

        for (const locator of loginLocators) {
            if (await locator.isVisible({ timeout: 3000 }).catch(() => false)) {
                const href = await locator.getAttribute('href').catch(() => null);
                try {
                    await locator.click({ timeout: 5000 });
                } catch (error) {
                    if (!href) {
                        throw error;
                    }

                    const newPage = await this.page.context().newPage();
                    await newPage.goto(href);
                }
                await this.page.waitForTimeout(1000);
                return;
            }
        }

        throw new Error('No visible login/sign-in control found on the page');
    }

    async verifySignInButtonVisible(): Promise<void> {
        console.log('🔍 Checking Sign In button visibility...');
        await expect(this.signInButtonSelector).toBeVisible({ timeout: 10000 });
        console.log('✅ Sign In button is visible');
    }

    // Verification Methods
    async verifyPageStructure(): Promise<void> {
        await expect(this.page).toHaveTitle(/./);
        await expect(this.page.locator('body')).toBeVisible();
    }

    async verifyTryButtonVisible(): Promise<void> {
        await expect(this.tryButtonSelector).toBeVisible({ timeout: 10000 });
    }

    async verifyLinks(maxLinks: number = 10): Promise<void> {
        const links = await this.linksSelector.all();
        console.log(`Found ${links.length} links to verify`);
        
        for (let i = 0; i < Math.min(links.length, maxLinks); i++) {
            const link = links[i];
            const href = await link.getAttribute('href');
            const isVisible = await link.isVisible();
            
            if (isVisible && href && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                console.log(`Verifying link: ${href}`);
                expect(href).toBeTruthy();
                expect(href).toMatch(/^https?:\/\//);
            }
        }
    }

    async verifyImages(maxImages: number = 10): Promise<void> {
        const images = await this.imagesSelector.all();
        let verifiedCount = 0;
        let brokenCount = 0;
        
        for (let i = 0; i < Math.min(images.length, maxImages); i++) {
            const img = images[i];
            const isVisible = await img.isVisible();
            if (isVisible) {
                const src = await img.getAttribute('src');
                if (src) {
                    try {
                        const naturalWidth = await img.evaluate(img => (img as HTMLImageElement).naturalWidth);
                        expect(naturalWidth).toBeGreaterThan(0);
                        console.log(`✅ Image ${i + 1} loaded successfully (width: ${naturalWidth}px)`);
                        verifiedCount++;
                    } catch (error) {
                        console.log(`❌ Image ${i + 1} failed to load: ${error.message}`);
                        brokenCount++;
                    }
                }
            }
        }
        console.log(`Verified ${verifiedCount} images, ${brokenCount} images failed to load`);
    }

    async verifyPageHealth(): Promise<void> {
        await this.verifyPageStructure();
        
        const pageTitle = await this.page.title();
        expect(pageTitle.length).toBeGreaterThan(0);
        console.log(`Page title: ${pageTitle}`);
        
        const hasHeader = await this.headerSelector.isVisible().catch(() => false);
        const hasContent = await this.page.locator('main, .main, .content').isVisible().catch(() => false);
        
        console.log(`Header visible: ${hasHeader}, Content visible: ${hasContent}`);
    }
}
