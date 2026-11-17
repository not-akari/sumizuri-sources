const PAGE_SIZE = 30;

const FEEDS = [
  { id: 'added', name: 'Recently added', sort: 'createdDate,desc' },
  { id: 'updated', name: 'Recently updated', sort: 'lastModified,desc' },
  { id: 'all', name: 'All series', sort: 'metadata.titleSort,asc' },
];

const STATUS = {
  ONGOING: 'ONGOING',
  ENDED: 'COMPLETED',
  HIATUS: 'HIATUS',
  ABANDONED: 'CANCELLED',
};

function setting(key) {
  const value = App.getSourceSetting(key);
  return typeof value === 'string' ? value.trim() : '';
}

function serverAddress() {
  let server = setting('server');
  if (!server) throw new Error('Add your Komga server address in this source\'s settings.');
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  return server.replace(/\/+$/, '');
}

function apiKey() {
  const key = setting('apiKey');
  if (!key) throw new Error('Add a Komga API key in this source\'s settings. Make one in Komga under Account settings, API keys.');
  return key;
}

function authHeaders() {
  return { 'X-API-Key': apiKey() };
}

function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => {
      const value = params[k];
      if (Array.isArray(value)) return value.map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
      return `${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`;
    })
    .filter((part) => part)
    .join('&');
}

const manager = App.createRequestManager({});

async function getJSON(path) {
  const server = serverAddress();
  const response = await manager.schedule(
    App.createRequest({
      url: `${server}${path}`,
      method: 'GET',
      headers: { ...authHeaders(), Accept: 'application/json' },
    }),
  );
  if (response.status === 401 || response.status === 403) {
    throw new Error('Komga refused the API key. Check it in this source\'s settings.');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Komga answered ${response.status} for ${path.split('?')[0]}`);
  }
  return JSON.parse(response.data);
}

function timeOf(text) {
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

function authorsOf(series) {
  const people = (series.booksMetadata && series.booksMetadata.authors) || [];
  const writers = people.filter((p) => p.role === 'writer' || p.role === 'author');
  const names = (writers.length ? writers : people).map((p) => p.name).filter(Boolean);
  return names.filter((name, index) => names.indexOf(name) === index).join(', ') || undefined;
}

function seriesToManga(series) {
  const server = serverAddress();
  const meta = series.metadata || {};
  const summary = meta.summary || (series.booksMetadata && series.booksMetadata.summary) || '';
  const age = typeof meta.ageRating === 'number' ? meta.ageRating : undefined;
  return {
    mangaId: series.id,
    title: meta.title || series.name,
    image: `${server}/api/v1/series/${series.id}/thumbnail`,
    headers: authHeaders(),
    author: authorsOf(series),
    summary,
    tags: (meta.genres || []).concat(meta.tags || []),
    chapters: typeof series.booksCount === 'number' ? series.booksCount : undefined,
    completed: meta.status === 'ENDED',
    publisher: meta.publisher || undefined,
    ageRating: age === undefined ? undefined : age >= 18 ? 18 : age >= 16 ? 16 : 0,
    webURL: `${server}/series/${series.id}`,
  };
}

class Source {
  getSourceFeeds() {
    return FEEDS.map((feed) => ({ id: feed.id, name: feed.name }));
  }

  async getSearchTags() {
    const [libraries, genres] = await Promise.all([getJSON('/api/v1/libraries'), getJSON('/api/v1/genres')]);
    const sections = [];
    if (libraries.length > 1) {
      sections.push({ id: 'library', title: 'Library', tags: libraries.map((l) => ({ id: `library:${l.id}`, label: l.name })) });
    }
    if (genres.length) {
      sections.push({ id: 'genre', title: 'Genre', tags: genres.map((g) => ({ id: `genre:${g}`, label: g })) });
    }
    return sections;
  }

  async getSearchResults(request, metadata) {
    const page = (metadata && metadata.page) || 0;
    const feed = FEEDS.find((f) => f.id === request.feed) || FEEDS[0];
    const tags = (request.includedTags || []).map((t) => String(t.id));
    const libraries = tags.filter((t) => t.startsWith('library:')).map((t) => t.slice(8));
    const genres = tags.filter((t) => t.startsWith('genre:')).map((t) => t.slice(6));
    const params = {
      search: request.title || undefined,
      library_id: libraries,
      genre: genres,
      sort: request.title ? undefined : feed.sort,
      page,
      size: PAGE_SIZE,
    };
    const answer = await getJSON(`/api/v1/series?${qs(params)}`);
    return {
      results: (answer.content || []).map(seriesToManga),
      metadata: answer.last ? undefined : { page: page + 1 },
    };
  }

  async getMangaDetails(mangaId) {
    const series = await getJSON(`/api/v1/series/${encodeURIComponent(mangaId)}`);
    const manga = seriesToManga(series);
    const meta = series.metadata || {};
    return {
      mangaInfo: {
        ...manga,
        desc: manga.summary,
        status: STATUS[meta.status] || 'UNKNOWN',
      },
    };
  }

  async getChapters(mangaId) {
    const answer = await getJSON(`/api/v1/series/${encodeURIComponent(mangaId)}/books?${qs({ unpaged: true, sort: 'metadata.numberSort,desc' })}`);
    return (answer.content || [])
      .filter((book) => !book.deleted)
      .map((book) => {
        const meta = book.metadata || {};
        return {
          id: book.id,
          name: meta.title || book.name,
          number: typeof meta.numberSort === 'number' ? meta.numberSort : book.number,
          time: timeOf(meta.releaseDate) || timeOf(book.created),
        };
      });
  }

  async getChapterDetails(mangaId, chapterId) {
    const server = serverAddress();
    const id = encodeURIComponent(chapterId);
    const book = await getJSON(`/api/v1/books/${id}`);
    const media = book.media || {};
    if (media.status && media.status !== 'READY') {
      throw new Error(`Komga has not finished reading this book yet (${media.status.toLowerCase()}). Try again after its next scan.`);
    }
    if (media.mediaProfile === 'EPUB' || media.mediaProfile === 'PDF') {
      return { id: chapterId, mangaId, pages: [], book: { url: `${server}/api/v1/books/${id}/file`, headers: authHeaders() } };
    }
    const pages = await getJSON(`/api/v1/books/${id}/pages`);
    return {
      id: chapterId,
      mangaId,
      pages: pages.map((p) => `${server}/api/v1/books/${id}/pages/${p.number}`),
      headers: authHeaders(),
    };
  }
}

module.exports = { Source };
