import { Page, Locator } from '@playwright/test';

export class BasePage {
    constructor(public page: Page) {}

    // Common utility methods
    async waitForPageLoad(): Promise<void> {
        await this.page.waitForLoadState('networkidle');
    }

    async isVisible(locator: Locator): Promise<boolean> {
        try {
            return await locator.isVisible({ timeout: 5000 });
        } catch {
            return false;
        }
    }

    async clickElement(locator: Locator): Promise<void> {
        await locator.waitFor({ state: 'visible' });
        await locator.click();
    }

    async fillInput(locator: Locator, value: string): Promise<void> {
        await locator.waitFor({ state: 'visible' });
        await locator.fill(value);
    }

    async getElementText(locator: Locator): Promise<string> {
        await locator.waitFor({ state: 'visible' });
        return await locator.textContent() || '';
    }
}
