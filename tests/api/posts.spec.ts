import { test, expect } from '@playwright/test';


test('should fetch all posts', async ({ request }) => {


  const response = await request.get('https://jsonplaceholder.typicode.com/posts');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(Array.isArray(body)).toBeTruthy();
  expect(body.length).toBeGreaterThan(0);
  console.log('Fetched all posts successfully');


  for (const post of body) {
    expect(post).toHaveProperty('userId');
    expect(post).toHaveProperty('id');
    expect(post).toHaveProperty('title');
    expect(post).toHaveProperty('body');
    console.log('Verified properties of the first post successfully');

    expect(post.userId).toEqual(expect.any(Number));
    expect(post.id).toEqual(expect.any(Number));
    const titleLength = post.title.length;
    expect(titleLength).toBeGreaterThan(0);
    const postLength = post.body.length;
    expect(postLength).toBeGreaterThan(10);
    console.log('Verified data types and content of the first post successfully');
  }

});


test('Edge case - 404', async ({ request }) => {
  const response = await request.get('https://jsonplaceholder.typicode.com/posts/999999');
  expect(response.status()).toBe(404);
  console.log('Edge case - 404: Post not found as expected');
});


test('Performance Response Time Test', async ({ request }) => {
  const start = performance.now();
  const response = await request.get('https://jsonplaceholder.typicode.com/posts');
  const duration = performance.now() - start;
  expect(response.status()).toBe(200);
  expect(duration, `Response took ${duration}ms`).toBeLessThan(1000); // Expect response time to be less than 1 seconds
  console.log(`Performance Test: Response time is ${duration} ms, which is within the acceptable range`);

  const body = await response.json();
  expect(body.length).toBeGreaterThan(50);
  console.log(`Performance Test: Fetched ${body.length} posts successfully, which is more than 50 posts as expected`);

});

