import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat, rm, open, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { inspectVideo } from './media.js';
import { Providers, PLATFORMS, configuration, configured, authorizationUrl, validateTikTok } from './providers.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_VIDEO = 256 * 1024 * 1024;
const MAX_STORAGE = 2 * 1024 * 1024 * 1024;
const idPattern = /^[a-f0-9-]{36}$/;
const active = job => Object.values(job.results).some(r => ['queued', 'uploading'].includes(r.state));
const identity = (state, p) => p === 'facebook' ? state.accounts[p]?.pageId : state.accounts[p]?.id;
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function publicJob(job) {
  return { id: job.id, title: job.post.title, caption: job.post.caption, createdAt: job.createdAt, results: Object.fromEntries(Object.entries(job.results).map(([p, r]) => [p, { state: r.state, message: r.message, remoteId: r.remoteId, url: r.url, mode: r.mode, actualPrivacy: r.actualPrivacy, accountLabel: r.accountLabel }])) };
}
async function bodyJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw httpError(413, 'Nội dung quá lớn.'); chunks.push(chunk); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString()); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v; }
  catch { throw httpError(400, 'JSON không hợp lệ.'); }
}
export function validatePost(input, state) {
  if (!idPattern.test(input.videoId || '') || !state.videos[input.videoId]) throw httpError(400, 'Hãy tải video hợp lệ lên trước.');
  if (!Array.isArray(input.platforms) || !input.platforms.length || input.platforms.some(p => !PLATFORMS.includes(p)) || new Set(input.platforms).size !== input.platforms.length) throw httpError(400, 'Chọn ít nhất một nền tảng hợp lệ.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const caption = typeof input.caption === 'string' ? input.caption.trim() : '';
  if (!title || [...title].length > 100 || /[<>]/.test(title)) throw httpError(400, 'Tiêu đề cần 1–100 ký tự, không chứa dấu < hoặc >.');
  if (Buffer.byteLength(caption, 'utf8') > 4500 || /[<>]/.test(caption)) throw httpError(400, 'Caption tối đa 4.500 byte UTF-8, không chứa dấu < hoặc >.');
  if (input.consent !== true) throw httpError(400, 'Cần xác nhận quyền sử dụng video và nội dung trước khi đăng.');
  if (input.platforms.includes('youtube') && (!['public', 'unlisted', 'private'].includes(input.youtubePrivacy) || typeof input.madeForKids !== 'boolean')) throw httpError(400, 'Hãy chọn quyền xem và đối tượng trẻ em cho YouTube.');
  for (const p of input.platforms) if (!state.accounts[p] || (p === 'facebook' && !state.accounts[p].pageId)) throw httpError(400, 'Hãy kết nối và chọn tài khoản cho ' + p + '.');
  if (input.commercial === true && !input.ownBrand && !input.brandedContent) throw httpError(400, 'Chọn thương hiệu của bạn hoặc nội dung hợp tác trả phí.');
  const booleans = ['madeForKids', 'aiGenerated', 'ownBrand', 'brandedContent', 'allowComment', 'allowDuet', 'allowStitch', 'musicConsent'];
  const clean = { title, caption, youtubePrivacy: input.youtubePrivacy, tiktokPrivacy: input.tiktokPrivacy };
  for (const key of booleans) clean[key] = input[key] === true;
  // A hidden disclosure checkbox must never silently carry over from a previous form state.
  clean.ownBrand = input.commercial === true && clean.ownBrand;
  clean.brandedContent = input.commercial === true && clean.brandedContent;
  return clean;
}
export async function createApp({ env = process.env, fetcher = fetch, probe = inspectVideo } = {}) {
  const config = configuration(env);
  const store = new Store(path.resolve(env.DATA_DIR || '.data')); await store.init();
  // Uploads interrupted before metadata was saved cannot be reused.
  for (const name of await readdir(path.join(store.dir, 'videos'))) if (/^[a-f0-9-]{36}\.mp4$/.test(name) && !store.state.videos[name.slice(0, -4)]) await rm(path.join(store.dir, 'videos', name));
  const providers = new Providers(config, store, fetcher);
  const oauth = new Map(), refreshing = new Map(); const running = new Set();
  let uploading = false;
  function send(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  function assertIdle() { if (Object.values(store.state.jobs).some(active)) throw httpError(409, 'Đang gửi video. Chờ hoàn tất trước khi thay đổi tài khoản.'); }
  async function run(job) {
    await Promise.all(job.platforms.map(async platform => {
      const result = job.results[platform];
      const progress = async patch => { Object.assign(result, patch); await store.save(); };
      try {
        await progress({ state: 'uploading', message: 'Đang gửi video…' });
        const data = await providers.publish(platform, store.state.videos[job.videoId], job.post, progress);
        await progress(data);
      } catch (e) {
        await progress({ state: result.remoteId || result.session ? 'interrupted' : 'failed', message: e.message });
      }
    }));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    try {
      if (req.headers.host !== new URL(config.appUrl).host) throw httpError(403, 'Host không hợp lệ. Dùng đúng APP_URL.');
      if (env.ADMIN_PASSWORD) {
        const expected = createHash('sha256').update('Basic ' + Buffer.from(`admin:${env.ADMIN_PASSWORD}`).toString('base64')).digest();
        const actual = createHash('sha256').update(req.headers.authorization || '').digest();
        if (!timingSafeEqual(expected, actual)) { res.setHeader('WWW-Authenticate', 'Basic realm="Affiliate Studio", charset="UTF-8"'); return send(res, 401, { error: 'Cần đăng nhập quản trị.' }); }
      }
      const u = new URL(req.url, config.appUrl), route = u.pathname;
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw httpError(405, 'Phương thức không hỗ trợ.');
      if (['POST', 'DELETE'].includes(req.method) && (req.headers['x-requested-with'] !== 'affiliate-studio' || (req.headers.origin && req.headers.origin !== config.appUrl))) throw httpError(403, 'Yêu cầu không cùng nguồn. Hãy dùng giao diện ứng dụng.');
      if (req.method === 'GET' && route === '/api/status') {
        const accounts = {};
        for (const p of PLATFORMS) {
          const a = store.state.accounts[p];
          accounts[p] = { configured: configured(config, p), connected: Boolean(a), label: a?.label, pageId: a?.pageId, pages: a?.pages?.map(v => ({ id: v.id, name: v.name })) || [] };
        }
        return send(res, 200, { accounts, tiktokMode: config.direct ? 'direct' : 'inbox', callbacks: Object.fromEntries(PLATFORMS.map(p => [p, `${config.appUrl}/oauth/${p}/callback`])), maxVideoMB: MAX_VIDEO / 1024 / 1024 });
      }
      if (req.method === 'POST' && /^\/api\/connect\/(youtube|facebook|tiktok)$/.test(route)) {
        assertIdle(); const p = route.split('/').at(-1);
        for (const [key, entry] of oauth) if (entry.expires < Date.now()) oauth.delete(key);
        if (oauth.size > 100) throw httpError(429, 'Quá nhiều yêu cầu kết nối. Thử lại sau.');
        const state = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url'), nonce = randomBytes(24).toString('hex');
        const url = authorizationUrl(config, p, state, createHash('sha256').update(verifier).digest('base64url'));
        oauth.set(state, { platform: p, verifier, nonce, expires: Date.now() + 600000 });
        res.setHeader('Set-Cookie', `oauth_${p}=${nonce}; HttpOnly; SameSite=Lax; Path=/oauth/${p}/callback; Max-Age=600${config.appUrl.startsWith('https:') ? '; Secure' : ''}`);
        return send(res, 200, { url });
      }
      if (req.method === 'GET' && /^\/oauth\/(youtube|facebook|tiktok)\/callback$/.test(route)) {
        const p = route.split('/')[2], state = u.searchParams.get('state'), entry = oauth.get(state);
        oauth.delete(state);
        const nonce = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`oauth_${p}=`))?.split('=')[1];
        res.setHeader('Set-Cookie', `oauth_${p}=; HttpOnly; SameSite=Lax; Path=/oauth/${p}/callback; Max-Age=0${config.appUrl.startsWith('https:') ? '; Secure' : ''}`);
        if (!entry || entry.platform !== p || entry.expires < Date.now() || nonce !== entry.nonce) throw httpError(400, 'Phiên OAuth không hợp lệ hoặc hết hạn. Kết nối lại từ ứng dụng.');
        assertIdle();
        if (!u.searchParams.get('code') || u.searchParams.has('error')) throw httpError(400, 'Bạn chưa cấp quyền kết nối. Quay lại ứng dụng để thử lại.');
        await providers.connect(p, u.searchParams.get('code'), entry.verifier);
        res.writeHead(303, { Location: '/?connected=' + p }); return res.end();
      }
      if (req.method === 'DELETE' && /^\/api\/accounts\/(youtube|facebook|tiktok)$/.test(route)) {
        assertIdle(); delete store.state.accounts[route.split('/').at(-1)]; await store.save(); return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/facebook/page') {
        assertIdle(); const { pageId } = await bodyJson(req), a = store.state.accounts.facebook;
        const page = a?.pages.find(p => p.id === pageId);
        if (!page) throw httpError(400, 'Trang chưa được cấp quyền.');
        a.pageId = page.id; a.label = page.name; await store.save(); return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/api/tiktok/creator') return send(res, 200, await providers.creator());
      if (req.method === 'POST' && route === '/api/videos') {
        if (uploading) throw httpError(409, 'Đang nhận một video khác. Chờ tải xong.');
        const size = Number(req.headers['content-length']);
        if (req.headers['content-type'] !== 'video/mp4' || !Number.isSafeInteger(size) || size < 12 || size > MAX_VIDEO) throw httpError(400, 'Cần video MP4 từ 12 byte đến 256 MB, có Content-Length.');
        if (Object.values(store.state.videos).reduce((sum, v) => sum + v.size, 0) + size > MAX_STORAGE) throw httpError(413, 'Đã đầy 2 GB lưu trữ. Xóa video cũ trước khi tải thêm.');
        uploading = true;
        const id = randomUUID(), file = store.videoPath(id); let handle;
        try {
          handle = await open(file, 'wx', 0o600); let received = 0;
          for await (const chunk of req) {
            received += chunk.length;
            if (received > size) throw httpError(413, 'Video vượt kích thước khai báo.');
            await handle.writeFile(chunk);
          }
          await handle.close(); handle = undefined;
          if (received !== size) throw httpError(400, 'Video tải lên chưa đầy đủ.');
          const metadata = await probe(file);
          const video = { id, size, ...metadata, createdAt: new Date().toISOString() };
          store.state.videos[id] = video; await store.save(); return send(res, 201, video);
        } catch (e) { await handle?.close(); delete store.state.videos[id]; await rm(file, { force: true }); throw httpError(e.status || 400, e.message); }
        finally { uploading = false; }
      }
      if (req.method === 'GET' && route === '/api/videos') return send(res, 200, Object.values(store.state.videos).reverse());
      if (/^\/api\/videos\/[a-f0-9-]{36}$/.test(route)) {
        const id = route.split('/').at(-1), video = store.state.videos[id];
        if (!video) throw httpError(404, 'Không tìm thấy video.');
        if (req.method === 'DELETE') {
          if (Object.values(store.state.jobs).some(j => j.videoId === id && active(j))) throw httpError(409, 'Video đang được gửi, chưa thể xóa.');
          await rm(store.videoPath(id), { force: true }); delete store.state.videos[id]; await store.save(); return send(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
          const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), video.size - 1) : video.size - 1;
          if ((req.headers.range && !range) || start > end || start >= video.size) { res.setHeader('Content-Range', `bytes */${video.size}`); return send(res, 416, { error: 'Range không hợp lệ.' }); }
          await stat(store.videoPath(id));
          res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.size}` } : {}) });
          createReadStream(store.videoPath(id), { start, end }).on('error', () => res.destroy()).pipe(res); return;
        }
      }
      if (req.method === 'POST' && route === '/api/publish') {
        const input = await bodyJson(req), key = req.headers['idempotency-key'];
        if (!idPattern.test(key || '')) throw httpError(400, 'Thiếu mã lượt đăng hợp lệ.');
        const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        if (store.state.jobs[key]) {
          if (store.state.jobs[key].digest !== digest) throw httpError(409, 'Mã lượt đăng đã dùng cho nội dung khác.');
          return send(res, 200, publicJob(store.state.jobs[key]));
        }
        if (Object.values(store.state.jobs).some(active)) throw httpError(409, 'Một lượt đăng đang gửi. Hãy chờ hoàn tất.');
        const post = validatePost(input, store.state);
        const destinations = Object.fromEntries(input.platforms.map(p => [p, identity(store.state, p)]));
        for (const p of input.platforms) if (!configured(config, p)) throw httpError(400, `Chưa cấu hình OAuth cho ${p}.`);
        if (config.direct && input.platforms.includes('tiktok')) validateTikTok(post, await providers.creator(), store.state.videos[input.videoId]);
        // Another request can arrive during the creator-info network call.
        if (store.state.jobs[key]) {
          if (store.state.jobs[key].digest !== digest) throw httpError(409, 'Mã lượt đăng đã dùng cho nội dung khác.');
          return send(res, 200, publicJob(store.state.jobs[key]));
        }
        if (input.platforms.some(p => !destinations[p] || identity(store.state, p) !== destinations[p])) throw httpError(409, 'Tài khoản đã thay đổi. Kiểm tra lại kênh nhận video.');
        if (Object.values(store.state.jobs).some(active)) throw httpError(409, 'Đang gửi một lượt đăng khác.');
        const job = { id: key, digest, videoId: input.videoId, post, platforms: input.platforms, createdAt: new Date().toISOString(), results: {} };
        for (const p of input.platforms) job.results[p] = { state: 'queued', accountId: identity(store.state, p), accountLabel: store.state.accounts[p].label, videoSize: store.state.videos[input.videoId].size, message: 'Đang chờ gửi.' };
        store.state.jobs[key] = job; await store.save();
        const task = run(job).catch(() => {}).finally(() => running.delete(task)); running.add(task);
        return send(res, 202, publicJob(job));
      }
      if (req.method === 'GET' && route === '/api/jobs') return send(res, 200, Object.values(store.state.jobs).reverse().map(publicJob));
      if (req.method === 'POST' && /^\/api\/jobs\/[a-f0-9-]{36}\/refresh$/.test(route)) {
        const id = route.split('/')[3], job = store.state.jobs[id];
        if (!job) throw httpError(404, 'Không tìm thấy lượt đăng.');
        if (!refreshing.has(id)) {
          const task = (async () => {
            await Promise.all(Object.entries(job.results).map(async ([p, r]) => {
              if (!['processing', 'interrupted'].includes(r.state) || (!r.remoteId && !r.session)) return;
              try {
                if (identity(store.state, p) !== r.accountId) throw new Error('Kết nối lại đúng tài khoản đã dùng để đăng trước khi kiểm tra trạng thái.');
                const update = await providers.status(p, r); Object.assign(r, update);
              } catch (e) { r.message = e.message; }
            }));
            await store.save();
          })().finally(() => refreshing.delete(id));
          refreshing.set(id, task);
        }
        await refreshing.get(id); return send(res, 200, publicJob(job));
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && files[route]) { const [file, type] = files[route]; const contents = await readFile(path.join(publicDir, file)); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(contents); }
      throw httpError(404, 'Không tìm thấy đường dẫn.');
    } catch (e) {
      if (res.headersSent) return res.destroy();
      const expected = e.status || /nền tảng|API |OAuth|TikTok|YouTube|Facebook|tài khoản|quyền|Phiên|Hãy|Video|Caption|Tiêu đề|Music|Branded|Ứng dụng/.test(e.message);
      send(res, e.status || 502, { error: expected ? e.message : 'Lỗi máy chủ. Kiểm tra cấu hình, bộ nhớ và quyền ghi thư mục dữ liệu.' });
    }
  });
  server.requestTimeout = 10 * 60 * 1000;
  return { server, store, providers, async close() { await Promise.allSettled([...running, ...refreshing.values()]); await new Promise(resolve => server.close(resolve)); await store.chain; } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp(); const port = Number(process.env.PORT || 3100), host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('HOST phải là loopback. Dùng reverse proxy HTTPS có bảo vệ nếu triển khai bên ngoài.');
  app.server.listen(port, host, () => console.log(`Affiliate Studio: ${configuration(process.env).appUrl}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { app.server.close(); app.close().then(() => process.exit(0)); });
}
