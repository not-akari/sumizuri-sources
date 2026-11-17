const PAGE_SIZE = 30;
const CLIENT = 'Sumizuri';
const VERSION = '1.0.0';
const TICKS_PER_MS = 10000;
const SESSION_KEY = 'session';
const DEVICE_KEY = 'device';
const SIGN_IN_RETRY_MS = 60 * 1000;

const FEEDS = [
  { id: 'added', name: 'Recently added', sortBy: 'DateCreated,SortName', sortOrder: 'Descending' },
  { id: 'all', name: 'All titles', sortBy: 'SortName', sortOrder: 'Ascending' },
];

const VIDEO_VIEWS = ['movies', 'tvshows', 'homevideos', 'musicvideos', 'mixed', undefined, null];

const state = App.createSourceStateManager();
const manager = App.createRequestManager({});
let lastFailedSignIn = 0;

function setting(key) {
  const value = App.getSourceSetting(key);
  return typeof value === 'string' ? value.trim() : '';
}

function serverAddress() {
  let server = setting('server');
  if (!server) throw new Error('Add your Jellyfin server address in this source\'s settings.');
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  return server.replace(/\/+$/, '');
}

function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

async function deviceId() {
  let id = await state.retrieve(DEVICE_KEY);
  if (!id) {
    id = `sumizuri-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    await state.store(DEVICE_KEY, id);
  }
  return id;
}

async function authorization(token) {
  const parts = [`Client="${CLIENT}"`, `Device="${CLIENT}"`, `DeviceId="${await deviceId()}"`, `Version="${VERSION}"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

async function signIn() {
  const user = setting('username');
  const password = App.getSourceSetting('password') || '';
  if (!user) throw new Error('Add your Jellyfin user name and password in this source\'s settings.');
  if (Date.now() - lastFailedSignIn < SIGN_IN_RETRY_MS) {
    throw new Error('Jellyfin did not accept the user name or password. Check them in this source\'s settings.');
  }
  const server = serverAddress();
  const response = await manager.schedule(
    App.createRequest({
      url: `${server}/Users/AuthenticateByName`,
      method: 'POST',
      headers: { Authorization: await authorization(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ Username: user, Pw: password }),
    }),
  );
  if (response.status === 401 || response.status === 403) {
    lastFailedSignIn = Date.now();
    throw new Error('Jellyfin did not accept the user name or password. Check them in this source\'s settings.');
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`Jellyfin answered ${response.status} when signing in`);
  const answer = JSON.parse(response.data);
  const session = { token: answer.AccessToken, userId: answer.User.Id, server, user };
  await state.store(SESSION_KEY, session);
  return session;
}

async function session() {
  const saved = await state.retrieve(SESSION_KEY);
  if (saved && saved.token && saved.server === serverAddress() && saved.user === setting('username')) return saved;
  return signIn();
}

async function getJSON(path) {
  let current = await session();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await manager.schedule(
      App.createRequest({
        url: `${current.server}${path.replace(/\{user\}|%7Buser%7D/g, current.userId)}`,
        method: 'GET',
        headers: { Authorization: await authorization(current.token), Accept: 'application/json' },
      }),
    );
    if (response.status === 401 && attempt === 0) {
      current = await signIn();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Jellyfin answered ${response.status} for ${path.split('?')[0].replace('{user}', 'user')}`);
    }
    return JSON.parse(response.data);
  }
  throw new Error('Jellyfin refused the sign in. Check this source\'s settings.');
}

function image(id, kind, size) {
  return `${serverAddress()}/Items/${id}/Images/${kind}?${qs({ maxHeight: size, quality: 90 })}`;
}

function timeOf(text) {
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

function cover(item) {
  const tags = item.ImageTags || {};
  if (tags.Primary) return image(item.Id, 'Primary', 600);
  if (tags.Thumb) return image(item.Id, 'Thumb', 600);
  if ((item.BackdropImageTags || []).length) return `${serverAddress()}/Items/${item.Id}/Images/Backdrop/0?maxWidth=900&quality=90`;
  return undefined;
}

function itemToTitle(item) {
  const title = {
    mangaId: item.Id,
    title: item.Name,
    image: cover(item),
    summary: item.Overview || '',
    tags: item.Genres || [],
    completed: item.Type === 'Movie' || item.Status === 'Ended',
    webURL: `${serverAddress()}/web/#/details?id=${item.Id}`,
  };
  if (typeof item.CommunityRating === 'number') title.rating = item.CommunityRating;
  return title;
}

function listParams(extra) {
  return qs({
    Recursive: true,
    IncludeItemTypes: 'Series,Movie',
    Fields: 'Overview,Genres,DateCreated,ProductionYear',
    EnableImageTypes: 'Primary,Thumb,Backdrop',
    ImageTypeLimit: 1,
    ...extra,
  });
}

class Source {
  getSourceFeeds() {
    return FEEDS.map((feed) => ({ id: feed.id, name: feed.name }));
  }

  async getSearchTags() {
    const [views, genres] = await Promise.all([
      getJSON('/Users/{user}/Views'),
      getJSON(`/Genres?${qs({ UserId: '{user}', IncludeItemTypes: 'Series,Movie', Recursive: true, SortBy: 'SortName' })}`),
    ]);
    const libraries = (views.Items || []).filter((v) => VIDEO_VIEWS.includes(v.CollectionType));
    const sections = [];
    if (libraries.length > 1) {
      sections.push({ id: 'library', title: 'Library', tags: libraries.map((l) => ({ id: `library:${l.Id}`, label: l.Name })) });
    }
    if ((genres.Items || []).length) {
      sections.push({ id: 'genre', title: 'Genre', tags: genres.Items.map((g) => ({ id: `genre:${g.Id}`, label: g.Name })) });
    }
    return sections;
  }

  async getSearchResults(request, metadata) {
    const start = (metadata && metadata.start) || 0;
    const feed = FEEDS.find((f) => f.id === request.feed) || FEEDS[0];
    const tags = (request.includedTags || []).map((t) => String(t.id));
    const library = tags.find((t) => t.startsWith('library:'));
    const genres = tags.filter((t) => t.startsWith('genre:')).map((t) => t.slice(6));
    const answer = await getJSON(
      `/Users/{user}/Items?${listParams({
        SearchTerm: request.title || undefined,
        ParentId: library ? library.slice(8) : undefined,
        GenreIds: genres.length ? genres.join('|') : undefined,
        SortBy: request.title ? 'SortName' : feed.sortBy,
        SortOrder: request.title ? 'Ascending' : feed.sortOrder,
        StartIndex: start,
        Limit: PAGE_SIZE,
      })}`,
    );
    const items = answer.Items || [];
    const next = start + items.length;
    return {
      results: items.map(itemToTitle),
      metadata: items.length === PAGE_SIZE && next < (answer.TotalRecordCount || 0) ? { start: next } : undefined,
    };
  }

  async getMangaDetails(mangaId) {
    const item = await getJSON(`/Users/{user}/Items/${encodeURIComponent(mangaId)}`);
    const title = itemToTitle(item);
    const directors = (item.People || []).filter((p) => p.Type === 'Director' || p.Type === 'Writer').map((p) => p.Name);
    const info = {
      ...title,
      desc: title.summary,
      author: directors.filter((n, i) => directors.indexOf(n) === i).slice(0, 3).join(', ') || undefined,
      publisher: (item.Studios || []).map((s) => s.Name).join(', ') || undefined,
      status: item.Type === 'Movie' || item.Status === 'Ended' ? 'COMPLETED' : item.Status === 'Continuing' ? 'ONGOING' : 'UNKNOWN',
    };
    if ((item.BackdropImageTags || []).length) info.banner = `${serverAddress()}/Items/${item.Id}/Images/Backdrop/0?maxWidth=1280&quality=90`;
    return { mangaInfo: info };
  }

  async getChapters(mangaId) {
    const item = await getJSON(`/Users/{user}/Items/${encodeURIComponent(mangaId)}`);
    if (item.Type !== 'Series') {
      return [{ id: item.Id, name: item.Name, number: 1, time: timeOf(item.DateCreated) || timeOf(item.PremiereDate) }];
    }
    const id = encodeURIComponent(mangaId);
    const [answer, seasons] = await Promise.all([
      getJSON(`/Shows/${id}/Episodes?${qs({ UserId: '{user}', Fields: 'DateCreated,PremiereDate' })}`),
      getJSON(`/Shows/${id}/Seasons?${qs({ UserId: '{user}' })}`),
    ]);
    const pictured = (seasons.Items || []).filter((s) => s.ImageTags && s.ImageTags.Primary).map((s) => s.Id);
    return (answer.Items || [])
      .map((episode) => {
        const entry = {
          id: episode.Id,
          name: episode.Name,
          time: timeOf(episode.DateCreated) || timeOf(episode.PremiereDate),
        };
        if (typeof episode.IndexNumber === 'number') entry.number = episode.IndexNumber;
        if (typeof episode.ParentIndexNumber === 'number') entry.season = String(episode.ParentIndexNumber);
        if (episode.SeasonName) entry.seasonName = episode.SeasonName;
        if (episode.SeasonId && pictured.includes(episode.SeasonId)) entry.seasonCover = image(episode.SeasonId, 'Primary', 600);
        return entry;
      })
      .reverse();
  }

  async getChapterDetails(mangaId, chapterId) {
    return { id: chapterId, mangaId, pages: [] };
  }

  async getVideos(mangaId, chapterId) {
    const current = await session();
    const id = encodeURIComponent(chapterId);
    const item = await getJSON(`/Users/{user}/Items/${id}`);
    const headers = { Authorization: await authorization(current.token) };
    let segments = [];
    try {
      segments = (await getJSON(`/MediaSegments/${id}`)).Items || [];
    } catch (error) {
      segments = [];
    }
    const range = (type) => {
      const found = segments.find((s) => s.Type === type);
      if (!found || !(found.EndTicks > found.StartTicks)) return undefined;
      return { start: Math.round(found.StartTicks / TICKS_PER_MS), end: Math.round(found.EndTicks / TICKS_PER_MS) };
    };
    const intro = range('Intro');
    const outro = range('Outro');
    const sources = item.MediaSources || [];
    if (!sources.length) throw new Error('Jellyfin has no playable file for this item.');
    return sources.map((source) => {
      const streams = source.MediaStreams || [];
      const video = streams.find((s) => s.Type === 'Video');
      const height = video && video.Height ? `${video.Height}p` : '';
      const subtitles = streams
        .filter((s) => s.Type === 'Subtitle' && s.IsExternal && s.IsTextSubtitleStream)
        .map((s) => ({
          url: `${current.server}/Videos/${id}/${encodeURIComponent(source.Id)}/Subtitles/${s.Index}/0/Stream.vtt`,
          label: s.DisplayTitle || s.Language || `Subtitle ${s.Index}`,
          language: s.Language || undefined,
        }));
      const entry = {
        url: `${current.server}/Videos/${id}/stream?${qs({ static: true, MediaSourceId: source.Id, Container: source.Container })}`,
        quality: [height, sources.length > 1 ? source.Name : 'Original'].filter(Boolean).join(' '),
        headers,
        subtitles,
      };
      if (intro) entry.intro = intro;
      if (outro) entry.outro = outro;
      return entry;
    });
  }
}

module.exports = { Source };
