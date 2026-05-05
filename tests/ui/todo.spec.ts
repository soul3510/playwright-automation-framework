import {test,expect} from '@playwright/test';



  test.describe('Todo UI tests', () => {
    test.beforeEach(async ({ page }) => {
    await page.goto('https://demo.playwright.dev/todomvc');
  });



    test('should add a new todo item', async ({ page }) => {
        const input=page.getByPlaceholder('What needs to be done?');
        await input.fill('Buy groceries');
        await input.press('Enter');
        const todoItem=page.getByText('Buy groceries');
        await expect(todoItem).toBeVisible();
        await expect(todoItem).toHaveCount(1);
        await expect(todoItem.first()).toHaveText('Buy groceries');
        console.log('Todo item added successfully');
    });

    test('should mark a todo item as completed', async ({ page }) => {  
        const todoInput = page.getByPlaceholder('What needs to be done?');
        const todoItem = page.locator('.todo-list li');
        await todoInput.fill('Buy groceries');
        await todoInput.press('Enter');
        await todoItem.getByRole('checkbox').check();
        await expect(todoItem.first()).toHaveClass(/completed/);
    });
});