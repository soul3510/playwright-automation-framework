import { expect, test } from '@playwright/test';



test.describe('Todo UI tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://demo.playwright.dev/todomvc');
  });



  test('should add a new todo item', async ({ page }) => {

    const taskA = 'Task A';
    const taskB = 'Task B';
    const taskC = 'Task C';
    let tasks = [taskA, taskB, taskC];

    const input = page.getByPlaceholder('What needs to be done?');

    for (const task of tasks) {
      
      await input.fill(task);
      await input.press('Enter');
      const todoItem = page.getByText(task);
      await expect(todoItem).toBeVisible();
      await expect(todoItem.first()).toHaveText(task);
      console.log(`Todo item: tasks added successfully`);
    }

    let allTodoItems = page.locator('.todo-list li');
    await expect(allTodoItems).toHaveCount(tasks.length);
    await expect(allTodoItems).toHaveText(tasks);

    console.log(`All todo items: ${tasks.length} tasks added successfully`);
    const inputTaskB = page.getByRole('listitem').filter({ hasText: 'Task B' }).getByLabel('Toggle Todo');
    await inputTaskB.check();


    const taskBItem  = page.getByRole('listitem').filter({ hasText: 'Task B' });
    await expect(taskBItem).toHaveClass(/completed/);
    console.log(`Task B: marked as completed successfully`);

    const taskAItem  = page.getByRole('listitem').filter({ hasText: 'Task A' });
    const taskCItem  = page.getByRole('listitem').filter({ hasText: 'Task C' });
    await expect(taskAItem).not.toHaveClass(/completed/);
    await expect(taskCItem).not.toHaveClass(/completed/);
    console.log(`Task A and Task C are NOT completed`); 


    await page.getByRole('link', { name: 'Completed' }).click();
    let allCompletedTodoItems = page.locator('.todo-list li');
    await expect(allCompletedTodoItems).toHaveCount(1);
    await expect(allCompletedTodoItems).toHaveText('Task B');
    console.log(`Task A and Task C are NOT completed`);

    const itemLeft = page.locator('.todo-count').filter({ hasText: '2 items left' });
    await expect(itemLeft).toContainText('2 items left');
    console.log(`Verifyied '2 items left'`);

  });

  test('should mark Task B todo item as completed', async ({ page }) => {
    // const input = page.getByRole('listitem').filter({ hasText: 'Task B' }).getByLabel('Toggle Todo').check();
  });
});