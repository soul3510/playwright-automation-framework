import { Page, Locator } from '@playwright/test';

export type InterruptionHandlingResult = {
    handled: number;
    actions: string[];
};

const safeButtonNames = [
    'accept',
    'accept all',
    'agree',
    'i agree',
    'allow all',
    'ok',
    'got it',
    'continue',
    'skip',
    'no thanks',
    'not now',
    'decline',
    'reject all',
    'close',
    'dismiss',
    'אישור',
    'אשר',
    'מסכים',
    'קבל',
    'קבל הכל',
    'סגור',
    'המשך',
    'לא תודה'
];

const unsafeButtonPattern = /login|log in|sign in|register|buy|purchase|pay|checkout|delete|remove|download|submit|send|save/i;
const safeButtonPattern = new RegExp(`^\\s*(${safeButtonNames.map(escapeRegex).join('|')})\\s*$`, 'i');

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function visibleCount(locator: Locator): Promise<number> {
    return locator.count().catch(() => 0);
}

async function clickFirstVisible(locator: Locator, label: string, actions: string[]): Promise<boolean> {
    const count = Math.min(await visibleCount(locator), 8);

    for (let i = 0; i < count; i++) {
        const candidate = locator.nth(i);
        const text = ((await candidate.innerText({ timeout: 500 }).catch(() => '')) || '').trim();
        const aria = ((await candidate.getAttribute('aria-label').catch(() => '')) || '').trim();
        const name = text || aria || label;

        if (unsafeButtonPattern.test(name)) continue;

        const visible = await candidate.isVisible({ timeout: 700 }).catch(() => false);
        const enabled = await candidate.isEnabled({ timeout: 700 }).catch(() => true);
        if (!visible || !enabled) continue;

        await candidate.click({ timeout: 3000 }).catch(async () => {
            await candidate.click({ force: true, timeout: 3000 });
        });
        actions.push(`${label}: ${name}`);
        return true;
    }

    return false;
}

export async function handlePageInterruptions(
    page: Page,
    options: { maxRounds?: number; settleMs?: number } = {}
): Promise<InterruptionHandlingResult> {
    const maxRounds = options.maxRounds ?? 4;
    const settleMs = options.settleMs ?? 500;
    const actions: string[] = [];

    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(settleMs).catch(() => {});

    for (let round = 0; round < maxRounds; round++) {
        const before = actions.length;

        await page.keyboard.press('Escape').catch(() => {});

        const safeRoleButton = page.getByRole('button', { name: safeButtonPattern });
        if (await clickFirstVisible(safeRoleButton, 'safe button', actions)) {
            await page.waitForTimeout(settleMs).catch(() => {});
            continue;
        }

        const safeTextButton = page.locator('button, [role="button"], input[type="button"], input[type="submit"]').filter({
            hasText: safeButtonPattern
        });
        if (await clickFirstVisible(safeTextButton, 'safe text button', actions)) {
            await page.waitForTimeout(settleMs).catch(() => {});
            continue;
        }

        const closeIcon = page.locator([
            '[aria-label*="close" i]',
            '[aria-label*="dismiss" i]',
            '[title*="close" i]',
            '.modal button:has-text("×")',
            '[role="dialog"] button:has-text("×")',
            'button.close',
            '.close-button',
            '.modal-close',
            '.popup-close'
        ].join(', '));
        if (await clickFirstVisible(closeIcon, 'close icon', actions)) {
            await page.waitForTimeout(settleMs).catch(() => {});
            continue;
        }

        const interruptionContainers = page.locator([
            '[role="dialog"]',
            '[aria-modal="true"]',
            '[class*="cookie" i]',
            '[id*="cookie" i]',
            '[class*="consent" i]',
            '[id*="consent" i]',
            '[class*="privacy" i]',
            '[id*="privacy" i]',
            '[class*="modal" i]',
            '[class*="popup" i]',
            '[class*="overlay" i]'
        ].join(', '));

        const containerCount = Math.min(await visibleCount(interruptionContainers), 5);
        for (let i = 0; i < containerCount; i++) {
            const container = interruptionContainers.nth(i);
            if (!await container.isVisible({ timeout: 500 }).catch(() => false)) continue;

            const containerButton = container.locator('button, [role="button"], input[type="button"], input[type="submit"]').filter({
                hasText: safeButtonPattern
            });
            if (await clickFirstVisible(containerButton, 'interruption container button', actions)) break;

            const containerClose = container.locator('[aria-label*="close" i], [title*="close" i], button:has-text("×"), .close, .close-button');
            if (await clickFirstVisible(containerClose, 'interruption container close', actions)) break;
        }

        if (actions.length === before) break;
        await page.waitForTimeout(settleMs).catch(() => {});
    }

    if (actions.length > 0) {
        console.log(`[Interruption Handler] Dismissed ${actions.length} interruption(s): ${actions.join(' | ')}`);
    }

    return { handled: actions.length, actions };
}
