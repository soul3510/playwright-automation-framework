import {test,expect} from '@playwright/test';

test.describe('API tests', () => {
    test.beforeEach(async ({ page }) => {
    await page.goto('https://demo.playwright.dev/todomvc');
  });


    test('should fetch all posts', async ({ request }) => {
        const response = await request.get('https://jsonplaceholder.typicode.com/posts');
        expect(response.status()).toBe(200);
        const body=await response.json();
        expect(body.length).toBeGreaterThan(0);
        console.log('Fetched all posts successfully');

        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('title');
        expect(body[0]).toHaveProperty('body');
 });

  });