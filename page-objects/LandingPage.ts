import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class LandingPage extends BasePage {
    // Selectors
    private readonly tryButtonSelector: Locator;
    private readonly linksSelector: Locator;
    private readonly imagesSelector: Locator;
    private readonly headerSelector: Locator;

    constructor(page: Page) {
        super(page);
        this.tryButtonSelector = page.locator('button:has-text("Try Calm for Free")').first();
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
        
        for (const img of images.slice(0, maxImages)) {
            const isVisible = await img.isVisible();
            if (isVisible) {
                const src = await img.getAttribute('src');
                if (src) {
                    expect(src).toBeTruthy();
                    const naturalWidth = await img.evaluate(img => img.naturalWidth);
                    expect(naturalWidth).toBeGreaterThan(0);
                }
            }
        }
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
