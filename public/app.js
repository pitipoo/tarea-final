(() => {
  const appRoot = document.getElementById('app');
  const toastRegion = document.getElementById('toast-region');
  const state = {
    topics: [],
    user: null,
    token: sessionStorage.getItem('atlasToken'),
    view: 'home',
    selectedTopicId: 'mali-empire',
    topicSearch: '',
    category: 'All',
    favoriteIds: new Set(),
    favorites: [],
    bookmarks: [],
    sessions: [],
    discussions: [],
    comments: {},
    commentsOpen: new Set(),
    adminUsers: [],
    settings: { siteTitle: 'Atlas Research' },
    modal: null,
    pendingRoute: null,
    brainTipOpen: false,
    mediaUrl: null,
    mediaForTopic: null,
    dataLoading: false,
    routeRequestId: 0
  };

  const roleNames = {
    standard: 'Standard User',
    investigator: 'Investigator',
    admin: 'Admin'
  };

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
  }

  function formatDate(value) {
    if (!value) return 'Just now';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Recently';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function initialFor(title = '') {
    return title.trim().charAt(0).toUpperCase() || 'A';
  }

  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast${type === 'error' ? ' error' : ''}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    node.textContent = message;
    toastRegion.append(node);
    window.setTimeout(() => node.remove(), 4200);
  }

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...options, headers });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.token) {
        clearAuth();
        if (isProtectedView(state.view)) {
          state.pendingRoute = window.location.hash || '#/home';
          state.view = 'home';
          state.modal = { type: 'auth', mode: 'login' };
          history.replaceState(null, '', '#/home');
          render();
        }
      }
      const error = new Error(payload?.error || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    return payload;
  }

  function clearAuth() {
    state.token = null;
    state.user = null;
    state.favoriteIds = new Set();
    state.favorites = [];
    state.bookmarks = [];
    sessionStorage.removeItem('atlasToken');
  }

  function isProtectedView(view) {
    return ['bookmarks', 'sessions', 'discussion', 'admin'].includes(view);
  }

  function findTopic(id = state.selectedTopicId) {
    return state.topics.find((topic) => topic.id === id);
  }

  function setTheme(topic) {
    document.documentElement.dataset.theme = topic?.theme || 'mali-empire';
  }

  function routeTo(route) {
    if (window.location.hash === route) {
      handleRoute();
    } else {
      window.location.hash = route;
    }
    document.body.classList.remove('menu-open');
  }

  function parseRoute() {
    const parts = (window.location.hash.replace(/^#\/?/, '') || 'home').split('/');
    return { page: parts[0] || 'home', id: decodeURIComponent(parts[1] || '') };
  }

  function handleRoute() {
    const { page, id } = parseRoute();
    const routeMap = {
      home: 'home',
      topics: 'topics',
      topic: 'detail',
      discussion: 'discussion',
      bookmarks: 'bookmarks',
      sessions: 'sessions',
      admin: 'admin',
      'reset-password': 'reset'
    };
    const view = routeMap[page];
    if (!view) {
      history.replaceState(null, '', '#/home');
      state.view = 'home';
      render();
      return;
    }
    if (isProtectedView(view) && !state.token) {
      state.pendingRoute = window.location.hash || '#/home';
      history.replaceState(null, '', '#/home');
      state.view = 'home';
      state.modal = { type: 'auth', mode: 'login' };
      render();
      return;
    }
    if (view === 'admin' && state.user?.role !== 'admin') {
      history.replaceState(null, '', '#/home');
      state.view = 'home';
      render();
      toast('Administrator access is required for that page.', 'error');
      return;
    }
    if ((view === 'detail' || view === 'discussion') && !findTopic(id)) {
      if (!state.topics.length) {
        state.selectedTopicId = id;
      } else {
        history.replaceState(null, '', '#/topics');
        state.view = 'topics';
        render();
        toast('That research topic could not be found.', 'error');
        return;
      }
    } else if (view === 'detail' || view === 'discussion') {
      state.selectedTopicId = id;
    }
    state.view = view;
    state.dataLoading = ['discussion', 'bookmarks', 'sessions', 'admin'].includes(view);
    const requestId = ++state.routeRequestId;
    if (view === 'reset') {
      state.modal = { type: 'auth', mode: 'reset', token: id };
      state.view = 'home';
    } else if (view !== 'reset') {
      state.modal = null;
    }
    setTheme(findTopic());
    render();
    loadRouteData(view, id, requestId);
  }

  async function loadRouteData(view, routeId, requestId = state.routeRequestId) {
    try {
      if (view === 'bookmarks') {
        const [favoriteData, bookmarkData] = await Promise.all([
          api('/api/favorites'),
          api('/api/bookmarks')
        ]);
        if (state.routeRequestId !== requestId) return;
        state.favorites = favoriteData.favorites;
        state.favoriteIds = new Set(favoriteData.favorites.map((item) => item.id));
        state.bookmarks = bookmarkData.bookmarks;
      } else if (view === 'sessions') {
        const data = await api('/api/sessions');
        if (state.routeRequestId !== requestId) return;
        state.sessions = data.sessions;
        state.sessionLimit = data.limit;
      } else if (view === 'discussion') {
        const topicId = routeId || state.selectedTopicId;
        const data = await api(`/api/topics/${encodeURIComponent(topicId)}/discussions`);
        if (state.routeRequestId !== requestId) return;
        state.discussions = data.discussions;
      } else if (view === 'admin') {
        const [userData, settingsData] = await Promise.all([
          api('/api/admin/users'),
          api('/api/admin/settings')
        ]);
        if (state.routeRequestId !== requestId) return;
        state.adminUsers = userData.users;
        state.settings = Object.fromEntries(settingsData.settings.map(({ key, value }) => [key, value]));
        state.settings.siteTitle ||= 'Atlas Research';
      }
      if (state.view === view && state.routeRequestId === requestId) {
        state.dataLoading = false;
        render();
      }
    } catch (error) {
      if (state.view === view && state.routeRequestId === requestId) {
        state.dataLoading = false;
        render();
        toast(error.message, 'error');
      }
    }
  }

  function navItem(icon, label, route, active) {
    return `<button class="nav-item${active ? ' active' : ''}" type="button" data-route="${route}">
      <span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span>
    </button>`;
  }

  function sidebar() {
    const roleLabel = state.user ? (roleNames[state.user.role] || 'Member') : 'Guest researcher';
    const displayName = state.user?.displayName || 'Your research desk';
    const siteTitle = state.settings.siteTitle || 'Atlas Research';
    return `<aside class="sidebar" aria-label="Main navigation">
      <a class="brand" href="#/home" aria-label="Atlas Research home">
        <span class="brand-mark">A</span>
        <span class="brand-copy"><strong>${escapeHtml(siteTitle)}</strong><span>Field notes for the curious</span></span>
      </a>
      <div class="nav-caption">Explore</div>
      <nav class="side-nav">
        ${navItem('⌂', 'Overview', '#/home', state.view === 'home')}
        ${navItem('⌕', 'Topic library', '#/topics', state.view === 'topics' || state.view === 'detail')}
      </nav>
      <div class="nav-caption">Your desk</div>
      <nav class="side-nav">
        ${navItem('☆', 'Saved research', '#/bookmarks', state.view === 'bookmarks')}
        ${navItem('◉', 'Active devices', '#/sessions', state.view === 'sessions')}
        ${state.user?.role === 'admin' ? navItem('⚙', 'Administration', '#/admin', state.view === 'admin') : ''}
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="field-card">
        <small>Today's field note</small>
        <p>Every map is an argument about what matters.</p>
        <button type="button" data-route="#/topics">Follow a question ↗</button>
      </div>
      <div class="profile-row">
        <span class="avatar">${escapeHtml(initialFor(displayName))}</span>
        <span class="profile-copy"><strong>${escapeHtml(displayName)}</strong><span>${escapeHtml(roleLabel)}</span></span>
        ${state.user
          ? '<button class="profile-action" type="button" data-action="logout" aria-label="Sign out" title="Sign out">↗</button>'
          : '<button class="profile-action" type="button" data-action="open-auth" aria-label="Sign in" title="Sign in">＋</button>'}
      </div>
    </aside>`;
  }

  function topbar() {
    const names = {
      home: 'Overview',
      topics: 'Topic library',
      detail: findTopic()?.title || 'Research topic',
      discussion: 'Topic discussions',
      bookmarks: 'Saved research',
      sessions: 'Active devices',
      admin: 'Administration'
    };
    return `<header class="topbar">
      <button class="mobile-menu" type="button" data-action="toggle-menu" aria-label="Open menu">☰</button>
      <div class="breadcrumb">${escapeHtml(state.settings.siteTitle || 'Atlas Research')} <span aria-hidden="true">&nbsp; / &nbsp;</span><strong>${escapeHtml(names[state.view] || 'Overview')}</strong></div>
      <div class="topbar-actions">
        ${state.view === 'home' || state.view === 'topics'
          ? `<label class="search-wrap"><span class="search-symbol" aria-hidden="true">⌕</span>
              <input id="topic-search" type="search" aria-label="Search research topics" placeholder="Search the archive…" value="${escapeHtml(state.topicSearch)}"></label>`
          : ''}
        ${state.user
          ? `<span class="role-label">${escapeHtml(roleNames[state.user.role] || 'Member')}</span>`
          : '<button class="button button-primary" type="button" data-action="open-auth">Sign in <span aria-hidden="true">↗</span></button>'}
      </div>
    </header>`;
  }

  function topicCard(topic) {
    return `<button class="topic-card" type="button" data-route="#/topic/${encodeURIComponent(topic.id)}">
      <span class="topic-card-top"><span class="topic-icon">${escapeHtml(initialFor(topic.title))}</span><span class="topic-period">${escapeHtml(topic.era)}</span></span>
      <h3>${escapeHtml(topic.title)}</h3>
      <p>${escapeHtml(topic.summary)}</p>
      <span class="topic-card-foot"><span>${escapeHtml(topic.region)} · ${escapeHtml(topic.category)}</span><span class="topic-arrow" aria-hidden="true">↗</span></span>
    </button>`;
  }

  function matchingTopics() {
    const term = state.topicSearch.trim().toLowerCase();
    return state.topics.filter((topic) => {
      const matchesTerm = !term || [topic.title, topic.subtitle, topic.region, topic.category, topic.summary]
        .some((value) => value.toLowerCase().includes(term));
      const matchesCategory = state.category === 'All' || topic.category === state.category;
      return matchesTerm && matchesCategory;
    });
  }

  function topicGrid(topics = state.topics) {
    if (!topics.length) {
      return `<div class="empty-state empty-filter"><strong>No field notes found</strong><p>Try a different search or clear the selected filters.</p>
        <button class="button button-light button-small" type="button" data-action="clear-search">Clear search</button></div>`;
    }
    return `<div class="topic-grid">${topics.map(topicCard).join('')}</div>`;
  }

  function renderHome() {
    const featured = state.topics.find((topic) => topic.id === 'mali-empire') || state.topics[0];
    const topics = matchingTopics().slice(0, 6);
    return `<main class="main-content">
      <div class="eyebrow">A living archive · ${state.topics.length} field guides</div>
      <div class="page-heading">
        <div><h1>Look closer.<br>Find a new story.</h1>
          <p>Explore civilizations, island worlds, and political landscapes through research made for curious minds.</p></div>
        <span class="heading-note">A place for careful questions<br>and unexpected connections.</span>
      </div>
      ${featured ? `<section class="hero-card" aria-label="Featured research topic">
        <div class="hero-copy">
          <span class="hero-label">Featured field guide</span>
          <h2>${escapeHtml(featured.title)}</h2>
          <p>${escapeHtml(featured.summary)}</p>
          <div class="hero-meta"><span>◷ ${escapeHtml(featured.era)}</span><span>⌖ ${escapeHtml(featured.region)}</span></div>
          <button class="button button-light hero-cta" type="button" data-route="#/topic/${encodeURIComponent(featured.id)}">Open field guide <span aria-hidden="true">↗</span></button>
        </div>
        <div class="hero-art" aria-hidden="true"><span class="hero-glyph">M</span><span class="hero-caption">Stories travel farther</span></div>
      </section>` : ''}
      <div class="section-head">
        <div><h2>Start with a story</h2><p>Distinct places, histories, and ways of seeing the world.</p></div>
        <button class="text-button" type="button" data-route="#/topics">Browse all ${state.topics.length} topics ↗</button>
      </div>
      ${topicGrid(topics)}
    </main>`;
  }

  function renderTopics() {
    const categories = ['All', ...new Set(state.topics.map((topic) => topic.category))];
    const topics = matchingTopics();
    return `<main class="main-content">
      <div class="eyebrow">The field archive</div>
      <div class="page-heading"><div><h1>Choose a thread.</h1><p>${state.topics.length} research trails across ancient worlds, island communities, and living political histories.</p></div>
        ${['investigator', 'admin'].includes(state.user?.role)
          ? '<button class="button button-accent" type="button" data-action="create-topic">＋ Create topic</button>'
          : `<span class="heading-note">${state.topics.length} topic guides</span>`}</div>
      <div class="topic-tools" aria-label="Filter topics">
        ${categories.map((category) => `<button class="filter-chip${category === state.category ? ' selected' : ''}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('')}
      </div>
      ${topicGrid(topics)}
    </main>`;
  }

  function favoriteButton(topicId) {
    const saved = state.favoriteIds.has(topicId);
    return `<button class="button button-light" type="button" data-action="toggle-favorite" data-topic-id="${escapeHtml(topicId)}">
      <span aria-hidden="true">${saved ? '★' : '☆'}</span>${saved ? 'Saved to favorites' : 'Add to favorites'}
    </button>`;
  }

  function renderDetail() {
    const topic = findTopic();
    if (!topic) return `<main class="main-content"><div class="empty-state"><strong>Opening field guide…</strong><p>Please wait a moment.</p></div></main>`;
    const canEdit = ['investigator', 'admin'].includes(state.user?.role);
    const media = state.user
      ? `<div class="protected-media">${state.mediaUrl && state.mediaForTopic === topic.id
        ? `<img id="topic-media" src="${state.mediaUrl}" alt="Protected illustrated cover for ${escapeHtml(topic.title)}">`
        : '<div class="media-lock"><span class="lock-icon" aria-hidden="true">◌</span><p>Loading protected archive image…</p></div>'}</div>`
      : `<div class="protected-media"><div class="media-lock"><span class="lock-icon" aria-hidden="true">⌑</span>
          <p>Archive imagery is available to signed-in researchers.</p>
          <button class="button button-small" type="button" data-action="open-auth">Sign in to view</button></div></div>`;
    return `<main class="main-content">
      <div class="eyebrow"><button class="text-button" type="button" data-route="#/topics">← Topic library</button> &nbsp; / &nbsp; ${escapeHtml(topic.category)}</div>
      <section class="topic-detail-head">
        <div class="detail-meta"><span>${escapeHtml(topic.region)}</span><span>${escapeHtml(topic.era)}</span><span>${escapeHtml(topic.category)}</span></div>
        <h1>${escapeHtml(topic.title)}</h1>
        <p>${escapeHtml(topic.summary)}</p>
        <div class="topic-detail-actions">
          ${state.user ? favoriteButton(topic.id) : '<button class="button button-light" type="button" data-action="open-auth">Sign in to save</button>'}
          ${state.user ? '<button class="button button-light" type="button" data-action="open-bookmark">＋ Bookmark a note</button>' : ''}
          ${state.user ? `<button class="button button-light" type="button" data-route="#/discussion/${encodeURIComponent(topic.id)}">◌ Discussions</button>` : '<button class="button button-light" type="button" data-action="open-auth">Sign in for discussions</button>'}
          ${canEdit ? '<button class="button button-light" type="button" data-action="edit-topic">Edit field guide</button>' : ''}
        </div>
      </section>
      <section class="detail-layout">
        <article class="paper-card"><div class="eyebrow">Research notes</div><h2>${escapeHtml(topic.subtitle)}</h2>
          <p>${escapeHtml(topic.body)}</p>
          <p class="muted">Approach this guide as a starting point. Compare sources, question inherited labels, and make room for the perspectives of people connected to these histories.</p>
        </article>
        <aside class="paper-card"><div class="eyebrow">At a glance</div><h2>Field record</h2>
          <div class="fact-row"><span>Region</span><strong>${escapeHtml(topic.region)}</strong></div>
          <div class="fact-row"><span>Period</span><strong>${escapeHtml(topic.era)}</strong></div>
          <div class="fact-row"><span>Type</span><strong>${escapeHtml(topic.category)}</strong></div>
          <div class="section-head archive-image-head"><div><h2>Archive image</h2></div></div>
          ${media}
        </aside>
      </section>
    </main>`;
  }

  function discussionCard(item) {
    const open = state.commentsOpen.has(item.id);
    const comments = state.comments[item.id] || [];
    return `<article class="discussion-card">
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.body)}</p>
      <div class="discussion-meta"><span>By ${escapeHtml(item.author)}</span><span>${escapeHtml(formatDate(item.createdAt))}</span><span>${item.commentCount} ${item.commentCount === 1 ? 'reply' : 'replies'}</span>
        <button class="text-button" type="button" data-action="toggle-comments" data-discussion-id="${escapeHtml(item.id)}">${open ? 'Hide replies' : 'View replies'}</button>
      </div>
      ${open ? `<div class="comments">
        ${comments.length ? comments.map((comment) => `<div class="comment"><strong>${escapeHtml(comment.author)}:</strong> ${escapeHtml(comment.body)}</div>`).join('') : '<div class="comment muted">No replies yet. Add the first thoughtful response.</div>'}
      </div>
      <form class="inline-form reply-form" data-form="comment" data-discussion-id="${escapeHtml(item.id)}">
        <div class="form-field"><label for="comment-${escapeHtml(item.id)}">Add a reply</label>
          <input id="comment-${escapeHtml(item.id)}" name="body" required minlength="2" maxlength="2000" placeholder="Add context, a question, or a source note…"></div>
        <button class="button button-primary button-small" type="submit">Post reply</button>
      </form>` : ''}
    </article>`;
  }

  function renderDiscussion() {
    const topic = findTopic();
    if (!topic) return `<main class="main-content"><div class="empty-state"><strong>Loading discussions…</strong></div></main>`;
    return `<main class="main-content">
      <div class="eyebrow"><button class="text-button" type="button" data-route="#/topic/${encodeURIComponent(topic.id)}">← ${escapeHtml(topic.title)}</button> &nbsp; / &nbsp; Community notes</div>
      <div class="page-heading"><div><h1>Open questions.</h1><p>Compare interpretations and add context to the ${escapeHtml(topic.title)} field guide.</p></div></div>
      <form class="paper-card discussion-create" data-form="discussion">
        <div class="eyebrow">Start a conversation</div><h2 class="discussion-create-title">What are you wondering about?</h2>
        <div class="form-grid">
          <div class="form-field form-span"><label for="thread-title">Discussion title</label><input id="thread-title" name="title" required minlength="4" maxlength="140" placeholder="A question, connection, or source to explore"></div>
          <div class="form-field form-span"><label for="thread-body">Context</label><textarea id="thread-body" name="body" required minlength="10" maxlength="3000" placeholder="Add enough context for other researchers to join in…"></textarea></div>
        </div>
        <div class="form-actions"><button class="button button-primary" type="submit">Post discussion ↗</button></div>
      </form>
      <div class="section-head"><div><h2>Community threads</h2><p>${state.discussions.length} conversations for this field guide.</p></div></div>
      ${state.discussions.length
        ? `<div class="discussion-list">${state.discussions.map(discussionCard).join('')}</div>`
        : `<div class="empty-state"><strong>Be the first to open a thread</strong><p>Good research often starts with a careful question.</p></div>`}
    </main>`;
  }

  function renderBookmarks() {
    return `<main class="main-content">
      <div class="eyebrow">Your research desk</div><div class="page-heading"><div><h1>Saved for later.</h1><p>Keep a trail of topics and the notes that matter to your investigation.</p></div></div>
      <div class="section-head"><div><h2>Favorite topics</h2><p>${state.favorites.length} saved field guides</p></div></div>
      ${state.favorites.length ? `<div class="list-stack">${state.favorites.map((item) => `<div class="saved-row">
        <button class="saved-main saved-topic-link text-button" type="button" data-route="#/topic/${encodeURIComponent(item.id)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.region)} · ${escapeHtml(item.summary)}</span></button>
        <button class="button button-light button-small" type="button" data-action="remove-favorite" data-topic-id="${escapeHtml(item.id)}">Remove</button>
      </div>`).join('')}</div>` : `<div class="empty-state"><strong>No favorite topics yet</strong><p>Use the star on any field guide to keep it close.</p><button class="button button-light button-small" data-route="#/topics" type="button">Explore topics</button></div>`}
      <div class="section-head"><div><h2>Research bookmarks</h2><p>Specific ideas and notes saved from the archive.</p></div></div>
      ${state.bookmarks.length ? `<div class="list-stack">${state.bookmarks.map((item) => `<div class="saved-row">
        <div class="saved-main"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.topicTitle)}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</span></div>
        <div class="admin-controls"><button class="button button-light button-small" type="button" data-route="#/topic/${encodeURIComponent(item.topicId)}">Open guide</button>
          <button class="button button-danger button-small" type="button" data-action="remove-bookmark" data-bookmark-id="${escapeHtml(item.id)}">Delete</button></div>
      </div>`).join('')}</div>` : `<div class="empty-state"><strong>No research notes saved</strong><p>Bookmark a question or finding from any field guide.</p></div>`}
    </main>`;
  }

  function renderSessions() {
    const sessions = state.sessions || [];
    return `<main class="main-content">
      <div class="eyebrow">Account security</div><div class="page-heading"><div><h1>Your active devices.</h1><p>Review and revoke sessions connected to your account. Atlas allows up to 2 active devices.</p></div>
        <button class="button button-light" type="button" data-action="change-password">Update password</button></div>
      <div class="section-head"><div><h2>Signed-in sessions</h2><p>${sessions.length} of ${state.sessionLimit || 2} device slots in use</p></div></div>
      ${sessions.length ? `<div class="list-stack">${sessions.map((session) => `<div class="session-row">
        <div class="session-main"><strong>${escapeHtml(session.device)} ${session.current ? '<span class="session-label current">This device</span>' : ''}</strong>
          <span>Started ${escapeHtml(formatDate(session.createdAt))} · Expires ${escapeHtml(formatDate(session.expiresAt))}</span></div>
        <button class="button ${session.current ? 'button-danger' : 'button-light'} button-small" type="button" data-action="revoke-session" data-session-id="${escapeHtml(session.id)}">${session.current ? 'Sign out here' : 'Revoke device'}</button>
      </div>`).join('')}</div>` : `<div class="empty-state"><strong>No active sessions</strong><p>Your current session may have just expired.</p></div>`}
    </main>`;
  }

  function renderAdmin() {
    const users = state.adminUsers || [];
    const settingTitle = state.settings.siteTitle || 'Atlas Research';
    return `<main class="main-content">
      <div class="eyebrow">Platform controls</div><div class="page-heading"><div><h1>Administration.</h1><p>Manage account roles, active sessions, and platform identity.</p></div></div>
      <section class="paper-card admin-settings-card"><div class="eyebrow">Platform settings</div><h2 class="admin-setting-title">Public identity</h2>
        <form class="inline-form" data-form="settings">
          <div class="form-field"><label for="site-title">Platform name</label><input id="site-title" name="siteTitle" required minlength="3" maxlength="80" value="${escapeHtml(settingTitle)}"></div>
          <button class="button button-primary button-small" type="submit">Save settings</button>
        </form>
      </section>
      <div class="section-head"><div><h2>People & permissions</h2><p>${users.length} accounts · role changes revoke active sessions.</p></div></div>
      ${users.length ? `<div class="list-stack">${users.map((user) => `<div class="user-row">
        <div class="user-main"><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.email)} · joined ${escapeHtml(formatDate(user.createdAt))}</span></div>
        <div class="admin-controls"><label class="muted role-control-label" for="role-${escapeHtml(user.id)}">Role</label>
          <select class="select" id="role-${escapeHtml(user.id)}" data-user-role="${escapeHtml(user.id)}">
            ${['standard', 'investigator', 'admin'].map((role) => `<option value="${role}"${user.role === role ? ' selected' : ''}>${escapeHtml(roleNames[role])}</option>`).join('')}
          </select>
          <button class="button button-light button-small" type="button" data-action="admin-sessions" data-user-id="${escapeHtml(user.id)}" data-user-name="${escapeHtml(user.displayName)}">Sessions</button>
        </div>
      </div>`).join('')}</div>` : `<div class="empty-state"><strong>No accounts yet</strong><p>New registrations will appear here.</p></div>`}
      <div id="admin-sessions-panel"></div>
    </main>`;
  }

  function renderContent() {
    if (state.dataLoading) {
      return `<main class="main-content"><div class="empty-state" role="status"><strong>Loading your research desk…</strong><p>Gathering the latest field notes.</p></div></main>`;
    }
    if (state.view === 'home') return renderHome();
    if (state.view === 'topics') return renderTopics();
    if (state.view === 'detail') return renderDetail();
    if (state.view === 'discussion') return renderDiscussion();
    if (state.view === 'bookmarks') return renderBookmarks();
    if (state.view === 'sessions') return renderSessions();
    if (state.view === 'admin') return renderAdmin();
    return renderHome();
  }

  function authModal(mode, token = '') {
    const modalTitle = {
      login: 'Welcome back.',
      register: 'Join the archive.',
      forgot: 'Reset your password.',
      reset: 'Choose a new password.',
      password: 'Update your password.',
      bookmark: 'Save a field note.',
      editTopic: 'Edit research guide.',
      newTopic: 'Create a field guide.'
    }[mode] || 'Sign in.';
    const descriptions = {
      login: 'Sign in to save discoveries, follow discussions, and keep your research close.',
      register: 'Create a researcher account. New accounts start with read-only access.',
      forgot: 'Enter your email and we’ll send a one-time reset link if an account exists.',
      reset: 'Choose a strong password. This single-use link expires after 20 minutes.',
      password: 'Confirm your current password before choosing a new one.',
      bookmark: 'Save a detail or question from this topic to your personal research desk.',
      editTopic: 'Update the field guide. Changes are saved for everyone.',
      newTopic: 'Add a research topic to the shared archive. Choose one of the catalog themes to set its visual identity.'
    }[mode] || '';
    const topic = findTopic();
    let form = '';
    if (mode === 'login') {
      form = `<form class="modal-form" data-form="login">
        <div class="form-field"><label for="login-email">Email address</label><input id="login-email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
        <div class="form-field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="128"></div>
        <button class="button button-primary" type="submit">Sign in to Atlas ↗</button>
      </form><div class="modal-switch"><button type="button" data-action="auth-mode" data-mode="forgot">Forgot password?</button></div>
      <div class="modal-switch">New to the archive? <button type="button" data-action="auth-mode" data-mode="register">Create an account</button></div>`;
    } else if (mode === 'register') {
      form = `<form class="modal-form" data-form="register">
        <div class="form-field"><label for="register-name">Your name</label><input id="register-name" name="displayName" autocomplete="name" required minlength="2" maxlength="80"></div>
        <div class="form-field"><label for="register-email">Email address</label><input id="register-email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
        <div class="form-field"><label for="register-password">Password</label><input id="register-password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="128">
          <small>At least 10 characters, including an uppercase letter, lowercase letter, and number.</small></div>
        <button class="button button-primary" type="submit">Create researcher account ↗</button>
      </form><div class="modal-switch">Already registered? <button type="button" data-action="auth-mode" data-mode="login">Sign in</button></div>`;
    } else if (mode === 'forgot') {
      form = `<form class="modal-form" data-form="recovery">
        <div class="form-field"><label for="recovery-email">Email address</label><input id="recovery-email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
        <button class="button button-primary" type="submit">Send reset instructions</button>
      </form><div class="modal-switch"><button type="button" data-action="auth-mode" data-mode="login">Back to sign in</button></div>`;
    } else if (mode === 'reset') {
      form = `<form class="modal-form" data-form="reset" data-reset-token="${escapeHtml(token)}">
        <div class="form-field"><label for="reset-password">New password</label><input id="reset-password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="128">
          <small>At least 10 characters, including an uppercase letter, lowercase letter, and number.</small></div>
        <button class="button button-primary" type="submit">Reset password</button>
      </form><div class="modal-switch"><button type="button" data-action="auth-mode" data-mode="login">Back to sign in</button></div>`;
    } else if (mode === 'password') {
      form = `<form class="modal-form" data-form="password">
        <div class="form-field"><label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></div>
        <div class="form-field"><label for="new-password">New password</label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" required minlength="10" maxlength="128">
          <small>At least 10 characters, including an uppercase letter, lowercase letter, and number. Other devices will be signed out.</small></div>
        <button class="button button-primary" type="submit">Update password</button>
      </form>`;
    } else if (mode === 'bookmark') {
      form = `<form class="modal-form" data-form="bookmark">
        <div class="form-field"><label for="bookmark-label">Bookmark title</label><input id="bookmark-label" name="label" required minlength="2" maxlength="120" placeholder="e.g. Trade routes across the Sahara"></div>
        <div class="form-field"><label for="bookmark-note">Your note</label><textarea id="bookmark-note" name="note" maxlength="500" placeholder="Why is this detail useful to your research?"></textarea></div>
        <button class="button button-primary" type="submit">Save to my research desk</button>
      </form>`;
    } else if (mode === 'editTopic' && topic) {
      form = `<form class="modal-form" data-form="edit-topic" data-topic-id="${escapeHtml(topic.id)}">
        <div class="form-field"><label for="edit-title">Title</label><input id="edit-title" name="title" required minlength="2" maxlength="120" value="${escapeHtml(topic.title)}"></div>
        <div class="form-field"><label for="edit-subtitle">Subtitle</label><input id="edit-subtitle" name="subtitle" maxlength="160" value="${escapeHtml(topic.subtitle)}"></div>
        <div class="form-field"><label for="edit-summary">Summary</label><textarea id="edit-summary" name="summary" required minlength="20" maxlength="500">${escapeHtml(topic.summary)}</textarea></div>
        <div class="form-field"><label for="edit-body">Research notes</label><textarea id="edit-body" name="body" required minlength="30" maxlength="5000">${escapeHtml(topic.body)}</textarea></div>
        <button class="button button-primary" type="submit">Publish updated guide</button>
      </form>`;
    } else if (mode === 'newTopic') {
      const themes = [...new Map(state.topics.map((item) => [item.theme, item])).values()];
      form = `<form class="modal-form" data-form="new-topic">
        <div class="form-grid">
          <div class="form-field"><label for="new-topic-title">Topic title</label><input id="new-topic-title" name="title" required minlength="2" maxlength="120"></div>
          <div class="form-field"><label for="new-topic-subtitle">Subtitle</label><input id="new-topic-subtitle" name="subtitle" maxlength="160"></div>
          <div class="form-field"><label for="new-topic-region">Region</label><input id="new-topic-region" name="region" required minlength="2" maxlength="120"></div>
          <div class="form-field"><label for="new-topic-era">Period</label><input id="new-topic-era" name="era" required minlength="2" maxlength="120"></div>
          <div class="form-field"><label for="new-topic-category">Category</label><input id="new-topic-category" name="category" required minlength="2" maxlength="60"></div>
          <div class="form-field"><label for="new-topic-theme">Visual theme</label><select id="new-topic-theme" name="theme" required>
            ${themes.map((item) => `<option value="${escapeHtml(item.theme)}">${escapeHtml(item.title)}</option>`).join('')}
          </select></div>
          <div class="form-field form-span"><label for="new-topic-summary">Summary</label><textarea id="new-topic-summary" name="summary" required minlength="20" maxlength="500"></textarea></div>
          <div class="form-field form-span"><label for="new-topic-body">Research notes</label><textarea id="new-topic-body" name="body" required minlength="30" maxlength="5000"></textarea></div>
        </div>
        <button class="button button-primary" type="submit">Add to the archive ↗</button>
      </form>`;
    }
    return `<div class="modal-backdrop" data-action="backdrop-close">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">×</button>
        <span class="modal-mark" aria-hidden="true">A</span><h2 id="modal-title">${modalTitle}</h2><p>${descriptions[mode] || ''}</p>
        ${form}
      </section></div>`;
  }

  function render() {
    setTheme(findTopic());
    document.title = `${state.settings.siteTitle || 'Atlas Research'} — Field notes for the curious`;
    appRoot.innerHTML = `<div class="app-shell">${sidebar()}<div class="main-column">${topbar()}${renderContent()}</div></div>
      <button class="brain-button" type="button" data-action="brain-tip" aria-label="Show Atlas research tip" title="A small research reminder">🧠</button>
      ${state.brainTipOpen ? '<div class="brain-tip" role="status">A good investigation follows the evidence, names its uncertainty, and makes room for local voices.</div>' : ''}
      ${state.modal ? authModal(state.modal.mode, state.modal.token) : ''}`;
    if (state.view === 'detail' && state.user) loadProtectedMedia();
    if (state.modal) {
      window.requestAnimationFrame(() => appRoot.querySelector('.modal-card input, .modal-card textarea')?.focus());
    }
  }

  async function loadProtectedMedia() {
    const topic = findTopic();
    if (!topic || state.mediaForTopic === topic.id) return;
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(topic.id)}/cover`, {
        headers: { Authorization: `Bearer ${state.token}` }
      });
      if (response.status === 401) {
        clearAuth();
        if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
        state.mediaUrl = null;
        state.mediaForTopic = null;
        if (isProtectedView(state.view)) {
          state.pendingRoute = window.location.hash || '#/home';
          state.view = 'home';
          state.modal = { type: 'auth', mode: 'login' };
          history.replaceState(null, '', '#/home');
        } else {
          toast('Your session expired. Sign in again to view protected media.', 'error');
        }
        render();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Unable to load archive image (${response.status}).`);
      }
      const blob = await response.blob();
      if (state.view !== 'detail' || findTopic()?.id !== topic.id || !state.user) return;
      if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
      state.mediaUrl = URL.createObjectURL(blob);
      state.mediaForTopic = topic.id;
      if (state.view === 'detail' && findTopic()?.id === topic.id) render();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function loadComments(discussionId) {
    try {
      const data = await api(`/api/discussions/${encodeURIComponent(discussionId)}/comments`);
      state.comments[discussionId] = data.comments;
      state.commentsOpen.add(discussionId);
      render();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function openAdminSessions(userId, userName) {
    try {
      const { sessions } = await api(`/api/admin/users/${encodeURIComponent(userId)}/sessions`);
      const panel = document.getElementById('admin-sessions-panel');
      if (!panel) return;
      panel.innerHTML = `<section class="paper-card admin-session-panel"><div class="section-head admin-session-heading">
        <div><h2>Sessions for ${escapeHtml(userName)}</h2><p>${sessions.length} active device(s)</p></div>
        <button class="button button-light button-small" type="button" data-action="close-admin-sessions">Close</button></div>
        ${sessions.length ? `<div class="list-stack">${sessions.map((session) => `<div class="session-row">
          <div class="session-main"><strong>${escapeHtml(session.device)}</strong><span>Started ${escapeHtml(formatDate(session.createdAt))}</span></div>
          <button class="button button-danger button-small" type="button" data-action="admin-revoke-session" data-user-id="${escapeHtml(userId)}" data-session-id="${escapeHtml(session.id)}">Revoke</button>
        </div>`).join('')}</div>` : '<div class="empty-state"><strong>No active sessions</strong></div>'}
      </section>`;
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function openAuth(mode = 'login') {
    state.modal = { type: 'auth', mode };
    render();
  }

  async function finishAuthentication(payload) {
    state.token = payload.token;
    state.user = payload.user;
    sessionStorage.setItem('atlasToken', payload.token);
    state.modal = null;
    state.favoriteIds = new Set();
    try {
      const data = await api('/api/favorites');
      state.favorites = data.favorites;
      state.favoriteIds = new Set(data.favorites.map((item) => item.id));
    } catch (error) {
      toast(error.message, 'error');
    }
    const route = state.pendingRoute;
    state.pendingRoute = null;
    if (route && route !== '#/home') routeTo(route);
    else render();
    toast(`Welcome, ${payload.user.displayName}.`);
  }

  async function handleClick(event) {
    const routeButton = event.target.closest('[data-route]');
    if (routeButton) {
      event.preventDefault();
      routeTo(routeButton.dataset.route);
      return;
    }
    const categoryButton = event.target.closest('[data-category]');
    if (categoryButton) {
      state.category = categoryButton.dataset.category;
      render();
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    if (action === 'backdrop-close' && event.target !== actionButton) return;
    if (action === 'open-auth') return openAuth('login');
    if (action === 'close-modal' || action === 'backdrop-close') {
      state.modal = null;
      render();
      return;
    }
    if (action === 'auth-mode') return openAuth(actionButton.dataset.mode);
    if (action === 'toggle-menu') {
      document.body.classList.toggle('menu-open');
      return;
    }
    if (action === 'brain-tip') {
      state.brainTipOpen = !state.brainTipOpen;
      render();
      return;
    }
    if (action === 'clear-search') {
      state.topicSearch = '';
      state.category = 'All';
      render();
      return;
    }
    if (action === 'logout') {
      try {
        if (state.token) await api('/api/auth/logout', { method: 'POST' });
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        clearAuth();
        state.view = 'home';
        state.modal = null;
        routeTo('#/home');
        toast('You have signed out.');
      }
      return;
    }
    if (action === 'toggle-favorite') {
      if (!state.token) return openAuth('login');
      const topicId = actionButton.dataset.topicId;
      try {
        if (state.favoriteIds.has(topicId)) {
          await api(`/api/favorites/${encodeURIComponent(topicId)}`, { method: 'DELETE' });
          state.favoriteIds.delete(topicId);
          state.favorites = state.favorites.filter((item) => item.id !== topicId);
          toast('Removed from your favorites.');
        } else {
          await api(`/api/favorites/${encodeURIComponent(topicId)}`, { method: 'PUT' });
          state.favoriteIds.add(topicId);
          toast('Added to your favorites.');
        }
        render();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    if (action === 'remove-favorite') {
      try {
        await api(`/api/favorites/${encodeURIComponent(actionButton.dataset.topicId)}`, { method: 'DELETE' });
        state.favoriteIds.delete(actionButton.dataset.topicId);
        state.favorites = state.favorites.filter((item) => item.id !== actionButton.dataset.topicId);
        render();
        toast('Favorite removed.');
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (action === 'open-bookmark') {
      state.modal = { type: 'auth', mode: 'bookmark' };
      render();
      return;
    }
    if (action === 'remove-bookmark') {
      try {
        await api(`/api/bookmarks/${encodeURIComponent(actionButton.dataset.bookmarkId)}`, { method: 'DELETE' });
        state.bookmarks = state.bookmarks.filter((item) => item.id !== actionButton.dataset.bookmarkId);
        render();
        toast('Bookmark deleted.');
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (action === 'change-password') {
      state.modal = { type: 'auth', mode: 'password' };
      render();
      return;
    }
    if (action === 'revoke-session') {
      const sessionId = actionButton.dataset.sessionId;
      try {
        const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
        if (result.current) {
          clearAuth();
          state.view = 'home';
          routeTo('#/home');
          toast('This device has been signed out.');
        } else {
          state.sessions = state.sessions.filter((session) => session.id !== sessionId);
          render();
          toast('Device session revoked.');
        }
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (action === 'edit-topic') {
      state.modal = { type: 'auth', mode: 'editTopic' };
      render();
      return;
    }
    if (action === 'create-topic') {
      state.modal = { type: 'auth', mode: 'newTopic' };
      render();
      return;
    }
    if (action === 'toggle-comments') {
      const id = actionButton.dataset.discussionId;
      if (state.commentsOpen.has(id)) {
        state.commentsOpen.delete(id);
        render();
      } else {
        await loadComments(id);
      }
      return;
    }
    if (action === 'admin-sessions') {
      await openAdminSessions(actionButton.dataset.userId, actionButton.dataset.userName);
      return;
    }
    if (action === 'admin-revoke-session') {
      try {
        await api(`/api/admin/users/${encodeURIComponent(actionButton.dataset.userId)}/sessions/${encodeURIComponent(actionButton.dataset.sessionId)}`, { method: 'DELETE' });
        await openAdminSessions(actionButton.dataset.userId, 'selected user');
        toast('Device session revoked.');
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (action === 'close-admin-sessions') {
      document.getElementById('admin-sessions-panel')?.replaceChildren();
    }
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function handleSubmit(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const values = formValues(form);
    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      if (form.dataset.form === 'login') {
        const payload = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
        await finishAuthentication(payload);
      } else if (form.dataset.form === 'register') {
        const payload = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(values) });
        await finishAuthentication(payload);
      } else if (form.dataset.form === 'recovery') {
        const payload = await api('/api/auth/recovery', { method: 'POST', body: JSON.stringify(values) });
        state.modal = null;
        render();
        toast(payload.message);
      } else if (form.dataset.form === 'reset') {
        const payload = await api('/api/auth/recovery/complete', {
          method: 'POST',
          body: JSON.stringify({ token: form.dataset.resetToken, password: values.password })
        });
        state.modal = null;
        history.replaceState(null, '', '#/home');
        state.view = 'home';
        render();
        toast(payload.message);
        openAuth('login');
      } else if (form.dataset.form === 'password') {
        const payload = await api('/api/auth/password', { method: 'POST', body: JSON.stringify(values) });
        clearAuth();
        state.modal = null;
        state.view = 'home';
        history.replaceState(null, '', '#/home');
        render();
        toast(payload.message);
        openAuth('login');
      } else if (form.dataset.form === 'bookmark') {
        const topic = findTopic();
        await api('/api/bookmarks', {
          method: 'POST',
          body: JSON.stringify({ ...values, topicId: topic.id })
        });
        state.modal = null;
        render();
        toast('Bookmark saved to your research desk.');
        if (state.view === 'bookmarks') await loadRouteData('bookmarks');
      } else if (form.dataset.form === 'discussion') {
        await api(`/api/topics/${encodeURIComponent(state.selectedTopicId)}/discussions`, {
          method: 'POST',
          body: JSON.stringify(values)
        });
        form.reset();
        const data = await api(`/api/topics/${encodeURIComponent(state.selectedTopicId)}/discussions`);
        state.discussions = data.discussions;
        render();
        toast('Your discussion has been posted.');
      } else if (form.dataset.form === 'comment') {
        const discussionId = form.dataset.discussionId;
        await api(`/api/discussions/${encodeURIComponent(discussionId)}/comments`, {
          method: 'POST',
          body: JSON.stringify(values)
        });
        const data = await api(`/api/discussions/${encodeURIComponent(discussionId)}/comments`);
        state.comments[discussionId] = data.comments;
        const discussionData = await api(`/api/topics/${encodeURIComponent(state.selectedTopicId)}/discussions`);
        state.discussions = discussionData.discussions;
        state.commentsOpen.add(discussionId);
        render();
        toast('Reply added.');
      } else if (form.dataset.form === 'edit-topic') {
        const data = await api(`/api/topics/${encodeURIComponent(form.dataset.topicId)}`, {
          method: 'PUT',
          body: JSON.stringify(values)
        });
        state.topics = state.topics.map((topic) => topic.id === data.topic.id ? data.topic : topic);
        state.modal = null;
        render();
        toast('Field guide updated.');
      } else if (form.dataset.form === 'new-topic') {
        const data = await api('/api/topics', { method: 'POST', body: JSON.stringify(values) });
        state.topics.push(data.topic);
        state.modal = null;
        routeTo(`#/topic/${encodeURIComponent(data.topic.id)}`);
        toast('Research topic added to the archive.');
      } else if (form.dataset.form === 'settings') {
        const data = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(values) });
        state.settings = Object.fromEntries(data.settings.map(({ key, value }) => [key, value]));
        render();
        toast('Platform settings saved.');
      }
    } catch (error) {
      toast(error.message, 'error');
      if (submitButton) submitButton.disabled = false;
    }
  }

  async function handleChange(event) {
    const select = event.target.closest('[data-user-role]');
    if (!select) return;
    const userId = select.dataset.userRole;
    const role = select.value;
    select.disabled = true;
    try {
      const { user } = await api(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      });
      state.adminUsers = state.adminUsers.map((item) => item.id === userId ? { ...item, role: user.role } : item);
      render();
      toast(`Role updated for ${user.displayName}. Their existing sessions have been revoked.`);
    } catch (error) {
      select.disabled = false;
      toast(error.message, 'error');
    }
  }

  let searchTimer;
  function handleInput(event) {
    if (event.target.id !== 'topic-search') return;
    state.topicSearch = event.target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      const input = document.getElementById('topic-search');
      const cursor = input?.selectionStart;
      render();
      const next = document.getElementById('topic-search');
      next?.focus();
      if (cursor !== null && cursor !== undefined) next?.setSelectionRange(cursor, cursor);
    }, 140);
  }

  async function init() {
    document.addEventListener('click', (event) => {
      handleClick(event).catch((error) => toast(error.message, 'error'));
    });
    document.addEventListener('submit', (event) => {
      handleSubmit(event).catch((error) => toast(error.message, 'error'));
    });
    document.addEventListener('change', (event) => {
      handleChange(event).catch((error) => toast(error.message, 'error'));
    });
    document.addEventListener('input', handleInput);
    window.addEventListener('hashchange', handleRoute);
    window.addEventListener('error', (event) => {
      fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: event.message || 'Unhandled browser error', stack: event.error?.stack || '' })
      }).catch(() => {});
    });
    window.addEventListener('unhandledrejection', (event) => {
      fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: event.reason?.message || 'Unhandled promise rejection', stack: event.reason?.stack || '' })
      }).catch(() => {});
    });
    try {
      const data = await api('/api/topics');
      state.topics = data.topics;
      if (state.token) {
        try {
          const current = await api('/api/auth/me');
          state.user = current.user;
          const favorites = await api('/api/favorites');
          state.favorites = favorites.favorites;
          state.favoriteIds = new Set(favorites.favorites.map((item) => item.id));
        } catch (error) {
          clearAuth();
          if (error.status !== 401) toast(error.message, 'error');
        }
      }
      handleRoute();
    } catch (error) {
      appRoot.innerHTML = `<main class="main-content"><div class="empty-state"><strong>Atlas could not reach the research archive</strong>
        <p>${escapeHtml(error.message)} Check that the server is running, then refresh.</p></div></main>`;
    }
  }

  init();
})();
