const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-more-than-32-characters';
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_URL = 'https://atlas.test';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'TestAdmin12345';

const { app, db, bootstrapAdmin } = require('../server');
const vercelApp = require('../index');
assert.equal(typeof vercelApp.listen, 'function');

test('research API enforces access, roles, device limits, and recovery', async (t) => {
  await bootstrapAdmin();
  const server = vercelApp.listen(0);
  t.after(() => {
    server.close();
    db.close();
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const request = async (path, { token, method = 'GET', body, userAgent } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (userAgent) headers['User-Agent'] = userAgent;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = response.status === 204 ? null
      : contentType.includes('application/json') ? await response.json()
        : await response.text();
    return { response, payload };
  };

  const topics = await request('/api/topics');
  assert.equal(topics.response.status, 200);
  assert.equal(topics.payload.topics.length, 20);
  const home = await request('/');
  assert.equal(home.response.status, 200);
  assert.match(home.response.headers.get('content-type'), /text\/html/);
  assert.match(home.payload, /Atlas Research/);
  assert.equal((await request('/api/topics/mali-empire')).response.status, 200);
  assert.equal((await request('/api/topics/mali-empire/discussions')).response.status, 401);
  assert.equal((await request('/api/media/mali-empire/cover')).response.status, 401);

  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.test', password: 'TestAdmin12345' }
  });
  assert.equal(adminLogin.response.status, 200);
  const adminToken = adminLogin.payload.token;
  const updatedSettings = await request('/api/admin/settings', {
    token: adminToken,
    method: 'PUT',
    body: { siteTitle: 'Atlas Field Notes' }
  });
  assert.equal(updatedSettings.response.status, 200);

  const registration = await request('/api/auth/register', {
    method: 'POST',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/125.0',
    body: { displayName: 'Researcher One', email: 'researcher@example.test', password: 'Researcher1234' }
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.payload.user.role, 'standard');
  const userId = registration.payload.user.id;

  const deniedEdit = await request('/api/topics/mali-empire', {
    token: registration.payload.token,
    method: 'PUT',
    body: { title: 'Edited title' }
  });
  assert.equal(deniedEdit.response.status, 403);
  const deniedCreate = await request('/api/topics', {
    token: registration.payload.token,
    method: 'POST',
    body: {
      title: 'Restricted Topic',
      region: 'Test region',
      era: 'Test era',
      category: 'Test',
      theme: 'mali-empire',
      summary: 'A sufficiently long summary for the new topic test.',
      body: 'These notes have enough detail to create a test topic successfully.'
    }
  });
  assert.equal(deniedCreate.response.status, 403);

  const promoted = await request(`/api/admin/users/${userId}/role`, {
    token: adminToken,
    method: 'PATCH',
    body: { role: 'investigator' }
  });
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.payload.user.role, 'investigator');
  assert.equal((await request('/api/auth/me', { token: registration.payload.token })).response.status, 401);

  const investigatorLogin = await request('/api/auth/login', {
    method: 'POST',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/125.0',
    body: { email: 'researcher@example.test', password: 'Researcher1234' }
  });
  assert.equal(investigatorLogin.payload.user.role, 'investigator');
  const investigatorToken = investigatorLogin.payload.token;
  const createdTopic = await request('/api/topics', {
    token: investigatorToken,
    method: 'POST',
    body: {
      title: 'Great Zimbabwe',
      subtitle: 'Stone cities of southern Africa',
      region: 'Southern Africa',
      era: 'c. 11th–15th century CE',
      category: 'Civilization',
      theme: 'kingdom-of-kush',
      summary: 'An influential stone-built center shaped by regional trade and settlement.',
      body: 'Research notes about Great Zimbabwe can be created by an investigator and use an existing thematic profile.'
    }
  });
  assert.equal(createdTopic.response.status, 201);
  assert.equal(createdTopic.payload.topic.id, 'great-zimbabwe');
  assert.equal(createdTopic.payload.topic.theme, 'kingdom-of-kush');

  const sessionList = await request('/api/sessions', { token: investigatorToken });
  assert.equal(sessionList.payload.sessions.length, 1);
  assert.match(sessionList.payload.sessions[0].device, /Chrome on Windows/);
  const image = await fetch(`${baseUrl}/api/media/mali-empire/cover`, {
    headers: { Authorization: `Bearer ${investigatorToken}` }
  });
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/svg\+xml/);

  const edit = await request('/api/topics/mali-empire', {
    token: investigatorToken,
    method: 'PUT',
    body: {
      title: 'Mali Empire: Updated',
      subtitle: 'Research update',
      summary: 'A sufficiently detailed updated summary for the field guide.',
      body: 'These updated notes contain enough material to meet the research body validation.'
    }
  });
  assert.equal(edit.response.status, 200);
  assert.equal(edit.payload.topic.title, 'Mali Empire: Updated');

  assert.equal((await request('/api/favorites/mali-empire', { token: investigatorToken, method: 'PUT' })).response.status, 200);
  assert.equal((await request('/api/favorites', { token: investigatorToken })).payload.favorites.length, 1);
  const bookmark = await request('/api/bookmarks', {
    token: investigatorToken,
    method: 'POST',
    body: { topicId: 'mali-empire', label: 'Trade routes', note: 'Review the trans-Saharan network.' }
  });
  assert.equal(bookmark.response.status, 201);
  assert.equal((await request('/api/bookmarks', { token: investigatorToken })).payload.bookmarks[0].label, 'Trade routes');

  const thread = await request('/api/topics/mali-empire/discussions', {
    token: investigatorToken,
    method: 'POST',
    body: { title: 'A question about the archive', body: 'How do family manuscript collections shape the historical record?' }
  });
  assert.equal(thread.response.status, 201);
  const comment = await request(`/api/discussions/${thread.payload.discussion.id}/comments`, {
    token: investigatorToken,
    method: 'POST',
    body: { body: 'Comparing catalogues and oral histories may help.' }
  });
  assert.equal(comment.response.status, 201);
  assert.equal((await request(`/api/discussions/${thread.payload.discussion.id}/comments`, { token: investigatorToken })).payload.comments.length, 1);

  const secondSession = await request('/api/auth/login', {
    method: 'POST',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605.1',
    body: { email: 'researcher@example.test', password: 'Researcher1234' }
  });
  assert.equal(secondSession.response.status, 200);
  const thirdLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'researcher@example.test', password: 'Researcher1234' }
  });
  assert.equal(thirdLogin.response.status, 409);
  assert.equal(thirdLogin.payload.code, 'DEVICE_LIMIT');
  const revoke = await request(`/api/sessions/${sessionList.payload.sessions[0].id}`, {
    token: investigatorToken,
    method: 'DELETE'
  });
  assert.equal(revoke.response.status, 200);
  const allowedLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'researcher@example.test', password: 'Researcher1234' }
  });
  assert.equal(allowedLogin.response.status, 200);

  const loggedInToken = allowedLogin.payload.token;
  const oldInfo = console.info;
  let resetLog = '';
  console.info = (...args) => { resetLog = args.join(' '); };
  try {
    const recovery = await request('/api/auth/recovery', {
      method: 'POST',
      body: { email: 'researcher@example.test' }
    });
    assert.equal(recovery.response.status, 200);
    assert.match(recovery.payload.message, /If an account exists/);
  } finally {
    console.info = oldInfo;
  }
  const resetToken = resetLog.match(/reset-password\/([a-f0-9]{64})$/)?.[1];
  assert.ok(resetToken, 'development recovery token should be logged for local testing');
  const reset = await request('/api/auth/recovery/complete', {
    method: 'POST',
    body: { token: resetToken, password: 'NewPassword5678' }
  });
  assert.equal(reset.response.status, 200);
  const reuse = await request('/api/auth/recovery/complete', {
    method: 'POST',
    body: { token: resetToken, password: 'AnotherPassword5678' }
  });
  assert.equal(reuse.response.status, 400);
  assert.equal((await request('/api/auth/me', { token: loggedInToken })).response.status, 401);
  const passwordLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'researcher@example.test', password: 'NewPassword5678' }
  });
  assert.equal(passwordLogin.response.status, 200);
  const passwordChange = await request('/api/auth/password', {
    token: passwordLogin.payload.token,
    method: 'POST',
    body: { currentPassword: 'NewPassword5678', newPassword: 'ChangedPassword9012' }
  });
  assert.equal(passwordChange.response.status, 200);
  assert.equal((await request('/api/auth/me', { token: passwordLogin.payload.token })).response.status, 401);
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'researcher@example.test', password: 'ChangedPassword9012' }
  })).response.status, 200);
});
