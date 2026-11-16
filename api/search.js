// SNS横断検索のサーバー側中継。APIキーは環境変数にのみ置き、ブラウザへは出しません。
const UA = 'sns-search/1.0 (personal search app)';
const TIMEOUT = 9000;

const env = (k) => (process.env[k] || '').trim();

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status; err.detail = detail;
    throw err;
  }
  return res.json();
}

const clip = (s, n = 280) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// 各ソース: { needs: 必要な環境変数(配列), run(ctx) -> items[] }
// ctx = { q, tag, mode, sort }  ※ q は検索語、tag はタグ（#なし）
const SOURCES = {
  youtube: {
    name: 'YouTube', needs: ['YOUTUBE_API_KEY'],
    async run({ q, tag, mode, sort }) {
      const term = mode === 'tag' ? '#' + tag : q;
      const p = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '20', q: term, key: env('YOUTUBE_API_KEY'), regionCode: 'JP', relevanceLanguage: 'ja', order: sort === 'latest' ? 'date' : 'relevance' });
      const j = await getJson('https://www.googleapis.com/youtube/v3/search?' + p);
      return (j.items || []).map((it) => ({
        title: stripHtml(it.snippet.title), text: clip(stripHtml(it.snippet.description)),
        url: 'https://www.youtube.com/watch?v=' + it.id.videoId, author: it.snippet.channelTitle,
        date: it.snippet.publishedAt, thumb: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url,
      }));
    },
  },
  x: {
    name: 'X', needs: ['X_BEARER_TOKEN'],
    async run({ q, tag, mode, sort }) {
      const base = mode === 'tag' ? '#' + tag : q;
      const query = `${base} -is:retweet`;
      const p = new URLSearchParams({ query, max_results: '20', 'tweet.fields': 'created_at,public_metrics,author_id,lang', expansions: 'author_id', 'user.fields': 'username,name', sort_order: sort === 'latest' ? 'recency' : 'relevancy' });
      const j = await getJson('https://api.x.com/2/tweets/search/recent?' + p, { headers: { Authorization: 'Bearer ' + env('X_BEARER_TOKEN') } });
      const users = Object.fromEntries((j.includes?.users || []).map((u) => [u.id, u]));
      return (j.data || []).map((t) => {
        const u = users[t.author_id] || {};
        return { title: '', text: clip(t.text, 400), url: `https://x.com/${u.username || 'i'}/status/${t.id}`, author: u.name ? `${u.name} (@${u.username})` : '', date: t.created_at, metrics: `♥ ${t.public_metrics?.like_count ?? 0}  ↻ ${t.public_metrics?.retweet_count ?? 0}` };
      });
    },
  },
  reddit: {
    name: 'Reddit', needs: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
    async run({ q, tag, mode, sort }) {
      const basic = Buffer.from(env('REDDIT_CLIENT_ID') + ':' + env('REDDIT_CLIENT_SECRET')).toString('base64');
      const tok = await getJson('https://www.reddit.com/api/v1/access_token', { method: 'POST', headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
      const p = new URLSearchParams({ q: mode === 'tag' ? tag : q, limit: '20', sort: sort === 'latest' ? 'new' : 'relevance', raw_json: '1' });
      const j = await getJson('https://oauth.reddit.com/search?' + p, { headers: { Authorization: 'Bearer ' + tok.access_token } });
      return (j.data?.children || []).map(({ data: d }) => ({
        title: d.title, text: clip(d.selftext), url: 'https://www.reddit.com' + d.permalink, author: `r/${d.subreddit} · u/${d.author}`,
        date: new Date(d.created_utc * 1000).toISOString(), metrics: `▲ ${d.score}  💬 ${d.num_comments}`,
        thumb: /^https?:/.test(d.thumbnail || '') ? d.thumbnail : undefined,
      }));
    },
  },
  bluesky: {
    name: 'Bluesky', needs: [], optional: ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'],
    async run({ q, tag, mode, sort }) {
      let host = 'https://public.api.bsky.app', headers = {};
      if (env('BLUESKY_HANDLE') && env('BLUESKY_APP_PASSWORD')) {
        const s = await getJson('https://bsky.social/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: env('BLUESKY_HANDLE'), password: env('BLUESKY_APP_PASSWORD') }) });
        host = 'https://bsky.social'; headers = { Authorization: 'Bearer ' + s.accessJwt };
      }
      const p = new URLSearchParams({ q: mode === 'tag' ? '#' + tag : q, limit: '25', sort: sort === 'latest' ? 'latest' : 'top' });
      const j = await getJson(`${host}/xrpc/app.bsky.feed.searchPosts?` + p, { headers });
      return (j.posts || []).map((x) => ({
        title: '', text: clip(x.record?.text, 400), url: `https://bsky.app/profile/${x.author.handle}/post/${x.uri.split('/').pop()}`,
        author: `${x.author.displayName || x.author.handle} (@${x.author.handle})`, date: x.record?.createdAt || x.indexedAt, metrics: `♥ ${x.likeCount ?? 0}  ↻ ${x.repostCount ?? 0}`,
      }));
    },
  },
  mastodon: {
    name: 'Mastodon', needs: [], optional: ['MASTODON_TOKEN'],
    async run({ q, tag, mode }) {
      const host = env('MASTODON_INSTANCE') || 'mastodon.social';
      let statuses;
      if (env('MASTODON_TOKEN') && mode !== 'tag') {
        const p = new URLSearchParams({ q, type: 'statuses', limit: '20' });
        const j = await getJson(`https://${host}/api/v2/search?` + p, { headers: { Authorization: 'Bearer ' + env('MASTODON_TOKEN') } });
        statuses = j.statuses || [];
      } else {
        const t = (tag || q.split(/\s+/)[0] || '').replace(/^#/, '');
        statuses = await getJson(`https://${host}/api/v1/timelines/tag/${encodeURIComponent(t)}?limit=20`);
      }
      return statuses.map((s) => ({
        title: '', text: clip(stripHtml(s.content), 400), url: s.url, author: `${s.account.display_name || s.account.username} (@${s.account.acct})`,
        date: s.created_at, metrics: `★ ${s.favourites_count}  ↻ ${s.reblogs_count}`, thumb: s.media_attachments?.[0]?.preview_url,
      }));
    },
  },
  web: {
    // Instagram・TikTok・Facebook・Threads・Pinterest・LinkedIn は専用の検索APIが無いため、
    // Brave Search APIで「site:」検索した結果を取得します（Webに公開されている投稿のみ）。
    name: 'Web検索(Instagram等)', needs: ['BRAVE_SEARCH_API_KEY'],
    async run({ q, tag, mode }) {
      const term = mode === 'tag' ? '#' + tag : q;
      const sites = ['instagram.com', 'tiktok.com', 'facebook.com', 'threads.net', 'pinterest.com', 'linkedin.com'];
      const hdr = { headers: { 'X-Subscription-Token': env('BRAVE_SEARCH_API_KEY') } };
      const call = (query, count) => getJson('https://api.search.brave.com/res/v1/web/search?' + new URLSearchParams({ q: query, count: String(count), country: 'jp', search_lang: 'jp' }), hdr);
      // Instagram等は1回でまとめて検索。Threadsは埋もれやすいので別に1回検索（合計2リクエスト）
      const rest = sites.filter((s) => s !== 'threads.net');
      const [a, b] = await Promise.allSettled([
        call(`${term} (${rest.map((s) => 'site:' + s).join(' OR ')})`, 20),
        call(`${term} site:threads.net`, 10),
      ]);
      if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
      const seen = new Set();
      const merged = [...(a.value?.web?.results || []), ...(b.value?.web?.results || [])].filter((r) => !seen.has(r.url) && seen.add(r.url));
      const j = { web: { results: merged } };
      const labels = { 'instagram.com': 'Instagram', 'tiktok.com': 'TikTok', 'facebook.com': 'Facebook', 'threads.net': 'Threads', 'pinterest.com': 'Pinterest', 'linkedin.com': 'LinkedIn' };
      return (j.web?.results || []).map((r) => {
        const host = (r.meta_url?.hostname || new URL(r.url).hostname).replace(/^www\./, '');
        const key = Object.keys(labels).find((k) => host === k || host.endsWith('.' + k));
        return { srcLabel: key ? labels[key] : host, title: stripHtml(r.title), text: clip(stripHtml(r.description)), url: r.url, author: host, date: r.page_age || undefined, thumb: r.thumbnail?.src };
      });
    },
  },
  hatena: {
    name: 'はてなブックマーク', needs: [],
    async run({ q, tag, mode, sort }) {
      const path = mode === 'tag' ? 'tag' : 'text';
      const p = new URLSearchParams({ q: mode === 'tag' ? tag : q, mode: 'rss', sort: sort === 'latest' ? 'recent' : 'popular' });
      const res = await fetch('https://b.hatena.ne.jp/search/' + path + '?' + p, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': UA } });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      const xml = await res.text();
      const tagText = (blk, name) => { const m = blk.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>')); return m ? stripHtml(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : ''; };
      return (xml.match(/<item[\s\S]*?<\/item>/g) || []).slice(0, 20).map((b) => ({
        title: tagText(b, 'title'), text: clip(tagText(b, 'description')), url: tagText(b, 'link'), author: '', date: tagText(b, 'dc:date'),
        metrics: `B! ${tagText(b, 'hatena:bookmarkcount') || 0}`,
      }));
    },
  },
  hackernews: {
    name: 'Hacker News', needs: [],
    async run({ q, tag, mode, sort }) {
      const ep = sort === 'latest' ? 'search_by_date' : 'search';
      const p = new URLSearchParams({ query: mode === 'tag' ? tag : q, tags: 'story', hitsPerPage: '20' });
      const j = await getJson(`https://hn.algolia.com/api/v1/${ep}?` + p);
      return (j.hits || []).map((h) => ({
        title: h.title || h.story_title, text: '', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, author: h.author,
        date: h.created_at, metrics: `▲ ${h.points ?? 0}  💬 ${h.num_comments ?? 0}`,
      }));
    },
  },
  qiita: {
    name: 'Qiita', needs: [], optional: ['QIITA_TOKEN'],
    async run({ q, tag, mode, sort }) {
      const query = mode === 'tag' ? 'tag:' + tag : q;
      const p = new URLSearchParams({ query, per_page: '20', page: '1' });
      const headers = env('QIITA_TOKEN') ? { Authorization: 'Bearer ' + env('QIITA_TOKEN') } : {};
      let items = await getJson('https://qiita.com/api/v2/items?' + p, { headers });
      if (sort !== 'latest') items = items.slice().sort((a, b) => (b.likes_count || 0) - (a.likes_count || 0));
      return items.map((i) => ({
        title: i.title, text: clip(i.body.replace(/[#>*`\-\[\]]/g, ' '), 200), url: i.url, author: i.user.id, date: i.created_at, metrics: `♥ ${i.likes_count}`,
      }));
    },
  },
};

function configured(id) {
  const s = SOURCES[id];
  return s.needs.every((k) => env(k));
}

function json(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // 任意のパスワード保護（APIクォータの悪用防止）
  if (env('APP_PASSWORD') && req.headers['x-app-password'] !== env('APP_PASSWORD')) {
    return json(res, 401, { error: 'password_required' });
  }

  if (url.searchParams.get('status')) {
    const sources = {};
    for (const id of Object.keys(SOURCES)) sources[id] = { name: SOURCES[id].name, ready: configured(id), needs: SOURCES[id].needs, optional: SOURCES[id].optional || [], keyless: SOURCES[id].needs.length === 0 };
    return json(res, 200, { sources, passwordProtected: !!env('APP_PASSWORD') });
  }

  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const mode = url.searchParams.get('mode') === 'tag' ? 'tag' : 'kw';
  const sort = url.searchParams.get('sort') === 'latest' ? 'latest' : 'relevance';
  const tag = q.replace(/^[#＃]+/, '').trim().split(/\s+/)[0] || '';
  if (!q || (mode === 'tag' && !tag)) return json(res, 400, { error: 'q_required' });

  const want = (url.searchParams.get('sources') || Object.keys(SOURCES).join(',')).split(',').filter((id) => SOURCES[id]);
  const out = {};
  await Promise.all(want.map(async (id) => {
    if (!configured(id)) { out[id] = { ok: false, reason: 'no_key', needs: SOURCES[id].needs }; return; }
    try {
      const items = await SOURCES[id].run({ q, tag, mode, sort });
      out[id] = { ok: true, items: items.filter((i) => /^https?:\/\//.test(i.url || '')) };
    } catch (e) {
      const hint = e.status === 401 || e.status === 403 ? 'キーが無効、または権限/契約プランが不足しています' : e.status === 429 ? 'リクエスト上限に達しました。しばらく待ってください' : e.name === 'TimeoutError' ? 'タイムアウトしました' : '取得に失敗しました';
      out[id] = { ok: false, reason: 'error', message: `${hint} (${e.status || e.name})` };
    }
  }));
  return json(res, 200, { q, mode, sort, results: out }, 'private, max-age=60');
};
