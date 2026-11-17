const PAGE_SIZE = 30;

const FEEDS = [
  { id: 'added', name: 'Recently added', sortField: 2, isAscending: false },
  { id: 'updated', name: 'New chapters', sortField: 4, isAscending: false },
  { id: 'all', name: 'All series', sortField: 1, isAscending: true },
];

const FIELD_GENRES = 18;
const FIELD_LIBRARIES = 19;
const COMPARE_CONTAINS = 5;
const MATCH_ALL = 1;

const STATUS = ['ONGOING', 'HIATUS', 'COMPLETED', 'CANCELLED', 'COMPLETED'];

const FORMAT_EPUB = 3;
const FORMAT_PDF = 4;

const LOOSE = -100000;
const SPECIAL = 100000;

function setting(key) {
  const value = App.getSourceSetting(key);
  return typeof value === 'string' ? value.trim() : '';
}

function serverAddress() {
  let server = setting('server');
  if (!server) throw new Error('Add your Kavita server address in this source\'s settings.');
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  return server.replace(/\/+$/, '');
}

function apiKey() {
  const key = setting('apiKey');
  if (!key) throw new Error('Add your Kavita API key in this source\'s settings. Find it in Kavita under Settings, Account, API key.');
  return key;
}

function authHeaders() {
  return { 'x-api-key': apiKey() };
}

const manager = App.createRequestManager({});

async function call(path, body) {
  const server = serverAddress();
  const headers = { ...authHeaders(), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await manager.schedule(
    App.createRequest({
      url: `${server}${path}`,
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  if (response.status === 401 || response.status === 403) {
    throw new Error('Kavita refused the API key. Check it in this source\'s settings.');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Kavita answered ${response.status} for ${path.split('?')[0]}`);
  }
  return response.data ? JSON.parse(response.data) : null;
}

function timeOf(text) {
  if (!text || text.startsWith('0001')) return undefined;
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(time) ? time : undefined;
}

function cover(seriesId) {
  return `${serverAddress()}/api/Image/series-cover?seriesId=${seriesId}`;
}

function seriesToManga(series) {
  const id = series.id !== undefined ? series.id : series.seriesId;
  return {
    mangaId: String(id),
    title: series.localizedName || series.name,
    image: cover(id),
    headers: authHeaders(),
    webURL: `${serverAddress()}/library/${series.libraryId}/series/${id}`,
  };
}

function numberText(value) {
  return String(Math.round(value * 100) / 100);
}

function chapterName(volume, chapter) {
  const extra = chapter.titleName && chapter.titleName !== volume.name ? chapter.titleName : '';
  if (volume.minNumber === SPECIAL || chapter.isSpecial) return chapter.titleName || chapter.title || chapter.range;
  if (chapter.minNumber === LOOSE) {
    const name = `Volume ${volume.name}`;
    return extra ? `${name}: ${extra}` : name;
  }
  const name = `Chapter ${chapter.range || numberText(chapter.minNumber)}`;
  return extra ? `${name}: ${extra}` : name;
}

class Source {
  getSourceFeeds() {
    return FEEDS.map((feed) => ({ id: feed.id, name: feed.name }));
  }

  async getSearchTags() {
    const [libraries, genres] = await Promise.all([call('/api/Library/libraries'), call('/api/Metadata/genres')]);
    const sections = [];
    if (libraries.length > 1) {
      sections.push({ id: 'library', title: 'Library', tags: libraries.map((l) => ({ id: `library:${l.id}`, label: l.name })) });
    }
    if (genres.length) {
      sections.push({ id: 'genre', title: 'Genre', tags: genres.map((g) => ({ id: `genre:${g.id}`, label: g.title })) });
    }
    return sections;
  }

  async getSearchResults(request, metadata) {
    if (request.title) {
      const found = await call(`/api/Search/search?queryString=${encodeURIComponent(request.title)}&includeChapterAndFiles=false`);
      return { results: (found.series || []).map(seriesToManga), metadata: undefined };
    }
    const page = (metadata && metadata.page) || 1;
    const feed = FEEDS.find((f) => f.id === request.feed) || FEEDS[0];
    const tags = (request.includedTags || []).map((t) => String(t.id));
    const libraries = tags.filter((t) => t.startsWith('library:')).map((t) => t.slice(8));
    const genres = tags.filter((t) => t.startsWith('genre:')).map((t) => t.slice(6));
    const statements = [];
    if (libraries.length) statements.push({ comparison: COMPARE_CONTAINS, field: FIELD_LIBRARIES, value: libraries.join(',') });
    if (genres.length) statements.push({ comparison: COMPARE_CONTAINS, field: FIELD_GENRES, value: genres.join(',') });
    const list = await call(`/api/Series/all-v2?PageNumber=${page}&PageSize=${PAGE_SIZE}`, {
      statements,
      combination: MATCH_ALL,
      limitTo: 0,
      sortOptions: { sortField: feed.sortField, isAscending: feed.isAscending },
    });
    return {
      results: (list || []).map(seriesToManga),
      metadata: (list || []).length < PAGE_SIZE ? undefined : { page: page + 1 },
    };
  }

  async getMangaDetails(mangaId) {
    const id = encodeURIComponent(mangaId);
    const [series, meta] = await Promise.all([call(`/api/Series/${id}`), call(`/api/Series/metadata?seriesId=${id}`)]);
    const manga = seriesToManga(series);
    const writers = (meta.writers || []).map((p) => p.name).filter(Boolean);
    return {
      mangaInfo: {
        ...manga,
        desc: meta.summary || '',
        author: writers.join(', ') || undefined,
        tags: (meta.genres || []).map((g) => g.title).concat((meta.tags || []).map((t) => t.title)),
        status: STATUS[meta.publicationStatus] || 'UNKNOWN',
        completed: meta.publicationStatus === 2 || meta.publicationStatus === 4,
      },
    };
  }

  async getChapters(mangaId) {
    const volumes = await call(`/api/Series/volumes?seriesId=${encodeURIComponent(mangaId)}`);
    const chapters = [];
    for (const volume of volumes || []) {
      for (const chapter of volume.chapters || []) {
        const number = chapter.minNumber !== LOOSE ? chapter.minNumber : volume.minNumber;
        const entry = {
          id: String(chapter.id),
          name: chapterName(volume, chapter),
          time: timeOf(chapter.releaseDate) || timeOf(chapter.createdUtc) || timeOf(chapter.created),
        };
        if (typeof number === 'number' && number !== LOOSE && number !== SPECIAL) entry.number = number;
        if (volume.minNumber !== LOOSE && volume.minNumber !== SPECIAL && chapter.minNumber !== LOOSE) entry.volume = String(volume.name);
        chapters.push(entry);
      }
    }
    return chapters.sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
  }

  async getChapterDetails(mangaId, chapterId) {
    const server = serverAddress();
    const id = encodeURIComponent(chapterId);
    const chapter = await call(`/api/Chapter?chapterId=${id}`);
    const format = chapter.files && chapter.files[0] ? chapter.files[0].format : undefined;
    if (format === FORMAT_EPUB || format === FORMAT_PDF) {
      return { id: chapterId, mangaId, pages: [], book: { url: `${server}/api/Download/chapter?chapterId=${id}`, headers: authHeaders() } };
    }
    const key = encodeURIComponent(apiKey());
    const pages = [];
    for (let page = 0; page < (chapter.pages || 0); page++) {
      pages.push(`${server}/api/Reader/image?chapterId=${id}&page=${page}&apiKey=${key}&extractPdf=false`);
    }
    return { id: chapterId, mangaId, pages };
  }
}

module.exports = { Source };
