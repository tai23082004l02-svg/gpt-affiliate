import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { inspectVideo } from '../src/media.js';
import { Providers, configuration, authorizationUrl, uploadUrl, validateTikTok } from '../src/providers.js';
const exec = promisify(execFile);
let fixtureDir, fixture;
before(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'affiliate-fixtures-'));
  const file = path.join(fixtureDir, 'vertical.mp4');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=540x960:r=24', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', file], { timeout: 30000 });
  fixture = await readFile(file);
});
after(async () => { await rm(fixtureDir, { recursive: true, force: true }); });
const env = { APP_URL: 'http://localhost:3100', GOOGLE_CLIENT_ID: 'test-google', GOOGLE_CLIENT_SECRET: 'test-google-secret', FACEBOOK_APP_ID: 'test-meta', FACEBOOK_APP_SECRET: 'test-meta-secret', TIKTOK_CLIENT_KEY: 'test-tiktok', TIKTOK_CLIENT_SECRET: 'test-tiktok-secret' };
async function appFor(t, fetcher) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'affiliate-app-'));
  const app = await createApp({ env: { ...env, DATA_DIR: directory }, fetcher });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.providers.config.appUrl = base;
  app.call = (url, options = {}) => fetch(base + url, { ...options, headers: { 'X-Requested-With': 'affiliate-studio', ...options.headers }, redirect: 'manual' });
  app.post = (url, body, headers = {}) => app.call(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return app;
}
async function upload(app) {
  const r = await app.call('/api/videos', { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: fixture });
  assert.equal(r.status, 201, await (r.status !== 201 ? r.text() : Promise.resolve(''))); return r.json();
}
function connect(app) {
  app.store.state.accounts = {
    youtube: { id: 'channel-1', label: 'Test YouTube', access_token: 'secret-youtube-token', expires_at: Date.now() + 3600000 },
    tiktok: { id: 'creator-1', label: 'Test TikTok', access_token: 'secret-tiktok-token', expires_at: Date.now() + 3600000 },
    facebook: { pageId: 'page-1', label: 'Test Page', pages: [{ id: 'page-1', name: 'Test Page', access_token: 'secret-page-token' }] },
  };
}
function postInput(videoId) { return { videoId, platforms: ['youtube', 'facebook', 'tiktok'], title: 'Review sản phẩm', caption: 'Trải nghiệm #affiliate', youtubePrivacy: 'private', madeForKids: false, commercial: true, brandedContent: true, aiGenerated: false, consent: true }; }
async function finished(app) {
  for (let i = 0; i < 200; i++) {
    const jobs = await (await app.call('/api/jobs')).json();
    if (jobs.length && Object.values(jobs[0].results).every(r => !['queued', 'uploading'].includes(r.state))) return jobs[0];
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('Job did not finish');
}
function mockNetwork({ facebookFails = false } = {}) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    url = String(url); const entry = { url, options }; calls.push(entry);
    if (options.body?.pipe) { let bytes = 0; for await (const chunk of options.body) bytes += chunk.length; entry.bytes = bytes; }
    if (url.includes('uploadType=resumable')) return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/mock-upload?session=test-session-secret' } });
    if (url.includes('/mock-upload')) return Response.json({ id: 'yt-video-1' }, { status: 201 });
    if (url.includes('youtube/v3/videos?part=status')) return Response.json({ items: [{ status: { uploadStatus: 'processed', privacyStatus: 'private' } }] });
    if (url.includes('video_reels')) {
      if (facebookFails) return Response.json({ error: { message: 'private diagnostic secret-page-token' } }, { status: 503 });
      const body = JSON.parse(options.body);
      return Response.json(body.upload_phase === 'start' ? { video_id: 'fb-video-1', upload_url: 'https://rupload.facebook.com/video-upload/fb-video-1' } : { success: true });
    }
    if (url.startsWith('https://rupload.facebook.com/')) return Response.json({ success: true });
    if (url.includes('fb-video-1?fields=status')) return Response.json({ status: { publishing_phase: { publish_status: 'published' } } });
    if (url.includes('/creator_info/query/')) return Response.json({ data: { creator_nickname: 'Creator', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], max_video_post_duration_sec: 60 }, error: { code: 'ok' } });
    if (url.includes('/inbox/video/init/') || url.includes('/publish/video/init/')) return Response.json({ data: { publish_id: 'tt-publish-1', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_token=test' }, error: { code: 'ok' } });
    if (url.startsWith('https://open-upload.tiktokapis.com/')) return new Response('', { status: 201 });
    if (url.includes('/status/fetch/')) return Response.json({ data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } });
    throw new Error('Unexpected mock URL: ' + url);
  };
  return { calls, fetcher };
}

test('real video probe accepts common vertical MP4 and rejects non-video', async () => {
  const info = await inspectVideo(path.join(fixtureDir, 'vertical.mp4'));
  assert.equal(info.width, 540); assert.equal(info.height, 960); assert.equal(info.duration, 3); assert.equal(info.fps, 24);
  const bad = path.join(fixtureDir, 'bad.mp4'); await writeFile(bad, 'not a video');
  await assert.rejects(inspectVideo(bad), /Không đọc được/);
});

test('HTTP serves the app, streams validated video ranges, rejects cross-origin and deletes files', async t => {
  const app = await appFor(t);
  const home = await app.call('/'); assert.equal(home.status, 200); assert.match(await home.text(), /Affiliate Studio/); assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const status = await (await app.call('/api/status')).json(); assert.equal(status.tiktokMode, 'inbox'); assert.equal(status.accounts.youtube.connected, false); assert.ok(!JSON.stringify(status).includes('test-google-secret'));
  const cross = await app.post('/api/publish', {}, { Origin: 'https://evil.example' }); assert.equal(cross.status, 403);
  const noCsrf = await app.call('/api/videos', { method: 'POST', headers: { 'X-Requested-With': '', 'Content-Type': 'video/mp4' }, body: fixture }); assert.equal(noCsrf.status, 403);
  const bad = await app.call('/api/videos', { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('bad fixture data') }); assert.equal(bad.status, 400);
  assert.deepEqual(await (await app.call('/api/videos')).json(), []);
  const video = await upload(app);
  const range = await app.call('/api/videos/' + video.id, { headers: { Range: 'bytes=0-15' } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), fixture.subarray(0, 16));
  const rangeBad = await app.call('/api/videos/' + video.id, { headers: { Range: 'bytes=999999999-' } }); assert.equal(rangeBad.status, 416);
  const deleted = await app.call('/api/videos/' + video.id, { method: 'DELETE' }); assert.equal(deleted.status, 200);
  await assert.rejects(stat(app.store.videoPath(video.id)), { code: 'ENOENT' });
});

test('one request sends three uploads, deduplicates retries and reports TikTok inbox honestly', async t => {
  const mock = mockNetwork(), app = await appFor(t, mock.fetcher); connect(app); const video = await upload(app), input = postInput(video.id), key = randomUUID();
  const first = await app.post('/api/publish', input, { 'Idempotency-Key': key }); assert.equal(first.status, 202);
  const duplicate = await app.post('/api/publish', input, { 'Idempotency-Key': key }); assert.equal(duplicate.status, 200);
  let job = await finished(app); assert.deepEqual(Object.values(job.results).map(r => r.state), ['processing', 'processing', 'processing']);
  assert.equal(mock.calls.filter(c => c.url.includes('uploadType=resumable')).length, 1);
  assert.equal(mock.calls.filter(c => c.url.includes('/inbox/video/init/')).length, 1);
  assert.equal(mock.calls.filter(c => c.bytes === fixture.length).length, 3);
  const ytBody = JSON.parse(mock.calls.find(c => c.url.includes('uploadType=resumable')).options.body); assert.equal(ytBody.status.privacyStatus, 'private'); assert.equal(ytBody.paidProductPlacementDetails.hasPaidProductPlacement, true);
  const ttBody = JSON.parse(mock.calls.find(c => c.url.includes('/inbox/video/init/')).options.body); assert.equal(ttBody.post_info, undefined, 'Inbox does not pretend to apply a caption');
  job = await (await app.post(`/api/jobs/${key}/refresh`, {})).json(); assert.equal(job.results.youtube.state, 'published'); assert.equal(job.results.youtube.actualPrivacy, 'private'); assert.equal(job.results.facebook.state, 'published'); assert.equal(job.results.tiktok.state, 'needs_action');
  const payload = JSON.stringify(job); assert.ok(!payload.includes('test-session-secret')); assert.ok(!payload.includes('secret-youtube-token'));
  const conflict = await app.post('/api/publish', { ...input, title: 'Changed' }, { 'Idempotency-Key': key }); assert.equal(conflict.status, 409);
});

test('one provider failure does not undo or resend successful uploads', async t => {
  const mock = mockNetwork({ facebookFails: true }), app = await appFor(t, mock.fetcher); connect(app); const video = await upload(app), key = randomUUID();
  const sent = await app.post('/api/publish', postInput(video.id), { 'Idempotency-Key': key }); assert.equal(sent.status, 202);
  const job = await finished(app); assert.equal(job.results.facebook.state, 'failed'); assert.equal(job.results.youtube.state, 'processing'); assert.equal(job.results.tiktok.state, 'processing'); assert.ok(!JSON.stringify(job).includes('private diagnostic'));
  await app.post('/api/publish', postInput(video.id), { 'Idempotency-Key': key }); assert.equal(mock.calls.filter(c => c.url.includes('uploadType=resumable')).length, 1);
});

test('publishing requires a connection, explicit rights and YouTube audience', async t => {
  const app = await appFor(t); const video = await upload(app), input = postInput(video.id);
  let r = await app.post('/api/publish', input, { 'Idempotency-Key': randomUUID() }); assert.equal(r.status, 400);
  connect(app);
  for (const patch of [{ consent: false }, { madeForKids: null }, { youtubePrivacy: '' }, { title: '<script>' }, { commercial: true, brandedContent: false, ownBrand: false }]) { r = await app.post('/api/publish', { ...input, ...patch }, { 'Idempotency-Key': randomUUID() }); assert.equal(r.status, 400); }
  assert.equal(Object.keys(app.store.state.jobs).length, 0);
});

test('OAuth state is browser-bound, one-time and uses YouTube PKCE', async t => {
  const app = await appFor(t);
  const start = await app.post('/api/connect/youtube', {}); assert.equal(start.status, 200); const url = new URL((await start.json()).url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('redirect_uri'), app.providers.config.appUrl + '/oauth/youtube/callback');
  const callback = `/oauth/youtube/callback?state=${url.searchParams.get('state')}&code=bad`;
  assert.equal((await app.call(callback)).status, 400, 'Missing browser cookie rejects stolen state');
  const cookie = start.headers.get('set-cookie').split(';')[0]; assert.equal((await app.call(callback, { headers: { Cookie: cookie } })).status, 400, 'Used state is invalid');
  assert.equal((await app.call('/oauth/tiktok/callback?state=unknown&code=x')).status, 400);
});

test('encrypted state survives restart without plaintext tokens; interrupted uploads are not retried', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'affiliate-store-'));
  try {
    const store = new Store(directory); await store.init(); store.state.accounts.youtube = { access_token: 'token-must-not-be-readable' }; store.state.jobs.one = { results: { youtube: { state: 'uploading', remoteId: 'already-started' } } }; await store.save();
    const saved = await readFile(path.join(directory, 'state.enc'), 'utf8'); assert.ok(!saved.includes('token-must-not-be-readable'));
    const restored = new Store(directory); await restored.init(); assert.equal(restored.state.accounts.youtube.access_token, 'token-must-not-be-readable'); assert.equal(restored.state.jobs.one.results.youtube.state, 'interrupted'); assert.equal(restored.state.jobs.one.results.youtube.remoteId, 'already-started');
    assert.equal((await stat(path.join(directory, 'encryption.key'))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public deployments require HTTPS and an admin password; signed upload URLs cannot target arbitrary hosts', () => {
  assert.throws(() => configuration({ APP_URL: 'http://public.example' }), /HTTPS/);
  assert.throws(() => configuration({ APP_URL: 'https://public.example' }), /ADMIN_PASSWORD/);
  for (const url of ['http://www.googleapis.com/upload', 'https://attacker.example/upload', 'https://www.googleapis.com.attacker.example/upload', 'https://user:pass@www.googleapis.com/upload']) assert.throws(() => uploadUrl(url, 'youtube'));
  assert.equal(uploadUrl('https://upload.us.tiktokapis.com/video/?token=test', 'tiktok'), 'https://upload.us.tiktokapis.com/video/?token=test');
});

test('TikTok Direct Post requires current visibility, music consent, duration and branded disclosure compatibility', () => {
  const info = { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 60 };
  const post = { title: 'Review', caption: '', tiktokPrivacy: 'PUBLIC_TO_EVERYONE', musicConsent: true, brandedContent: true };
  assert.doesNotThrow(() => validateTikTok(post, info, { duration: 30 }));
  for (const patch of [{ tiktokPrivacy: '' }, { musicConsent: false }, { tiktokPrivacy: 'SELF_ONLY' }]) assert.throws(() => validateTikTok({ ...post, ...patch }, info, { duration: 30 }));
  assert.throws(() => validateTikTok(post, info, { duration: 61 }));
  const config = configuration({ ...env, TIKTOK_DIRECT_POST_ENABLED: 'true' });
  assert.match(authorizationUrl(config, 'tiktok', 'state'), /video.publish/);
});

test('expired YouTube token is refreshed once for concurrent requests and the new token is saved', async () => {
  const state = { accounts: { youtube: { access_token: 'old', refresh_token: 'refresh', expires_at: 0 } } }; let saves = 0, calls = 0;
  const provider = new Providers(configuration(env), { state, save: async () => saves++ }, async () => { calls++; return Response.json({ access_token: 'new', expires_in: 3600 }); });
  assert.deepEqual(await Promise.all([provider.token('youtube'), provider.token('youtube')]), ['new', 'new']); assert.equal(calls, 1); assert.equal(saves, 1); assert.equal(state.accounts.youtube.refresh_token, 'refresh');
});

test('TikTok Direct Post chunks a large video and carries chosen privacy, interaction and commercial flags', async () => {
  const { truncate } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'affiliate-chunks-'));
  try {
    const store = new Store(directory); await store.init();
    store.state.accounts.tiktok = { id: 'creator', access_token: 'test-access', expires_at: Date.now() + 3600000 };
    const video = { id: randomUUID(), size: 70 * 1024 * 1024, duration: 30 };
    await writeFile(store.videoPath(video.id), ''); await truncate(store.videoPath(video.id), video.size);
    const mock = mockNetwork(), provider = new Providers(configuration({ ...env, TIKTOK_DIRECT_POST_ENABLED: 'true' }), store, mock.fetcher), changes = [];
    const result = await provider.publish('tiktok', video, { title: 'Review', caption: 'Affiliate', tiktokPrivacy: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, brandedContent: true, ownBrand: false, musicConsent: true, aiGenerated: true }, async patch => changes.push(patch));
    assert.equal(result.mode, 'direct'); assert.equal(result.state, 'processing');
    const init = JSON.parse(mock.calls.find(c => c.url.includes('/publish/video/init/')).options.body);
    assert.equal(init.source_info.total_chunk_count, 2); assert.equal(init.source_info.chunk_size, 32 * 1024 * 1024);
    assert.equal(init.post_info.privacy_level, 'PUBLIC_TO_EVERYONE'); assert.equal(init.post_info.brand_content_toggle, true); assert.equal(init.post_info.disable_comment, false); assert.equal(init.post_info.disable_duet, true); assert.equal(init.post_info.is_aigc, true);
    const uploads = mock.calls.filter(c => c.bytes); assert.deepEqual(uploads.map(c => c.bytes), [32 * 1024 * 1024, 38 * 1024 * 1024]);
    assert.equal(uploads[1].options.headers['Content-Range'], `bytes ${32 * 1024 * 1024}-${video.size - 1}/${video.size}`);
    assert.equal(changes[0].remoteId, 'tt-publish-1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OAuth exchanges a code server-side and only exposes account/page labels', async t => {
  const calls = [];
  const app = await appFor(t, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('oauth2.googleapis.com')) { assert.equal(options.body.get('code_verifier').length, 43); return Response.json({ access_token: 'google-private-token', refresh_token: 'google-private-refresh', expires_in: 3600 }); }
    if (String(url).includes('/channels?')) return Response.json({ items: [{ id: 'channel', snippet: { title: 'My channel' } }] });
    if (String(url).includes('/oauth/access_token')) return Response.json({ access_token: 'facebook-private-user-token' });
    if (String(url).includes('/me/accounts?')) return Response.json({ data: [{ id: 'page-42', name: 'My Page', access_token: 'facebook-private-page-token', tasks: ['CREATE_CONTENT'] }] });
    assert.fail('Unexpected OAuth request');
  });
  for (const p of ['youtube', 'facebook']) {
    const start = await app.post('/api/connect/' + p, {}), cookie = start.headers.get('set-cookie').split(';')[0], auth = new URL((await start.json()).url);
    const callback = `/oauth/${p}/callback?state=${auth.searchParams.get('state')}&code=test`;
    const r = await app.call(callback, { headers: { Cookie: cookie } }); assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/?connected=' + p);
  }
  const data = await (await app.call('/api/status')).json(); assert.equal(data.accounts.youtube.label, 'My channel'); assert.equal(data.accounts.facebook.pages[0].name, 'My Page'); assert.equal(data.accounts.facebook.pageId, undefined);
  assert.ok(!JSON.stringify(data).includes('private-token')); assert.ok(!JSON.stringify(data).includes('private-page-token'));
  const chosen = await app.post('/api/facebook/page', { pageId: 'page-42' }); assert.equal(chosen.status, 200); assert.equal(app.store.state.accounts.facebook.pageId, 'page-42');
  assert.equal((await app.post('/api/facebook/page', { pageId: 'unauthorized' })).status, 400);
});

test('Render uses its HTTPS hostname and public binding still requires explicit opt-in and strong password', async () => {
  const { listenOptions } = await import('../src/server.js');
  const hosted = { RENDER: 'true', RENDER_EXTERNAL_URL: 'https://studio-example.onrender.com', HOST: '0.0.0.0', PORT: '10000', ALLOW_PUBLIC_BIND: 'true', ADMIN_PASSWORD: 'test-password-at-least-twenty-characters' };
  assert.equal(configuration(hosted).appUrl, hosted.RENDER_EXTERNAL_URL);
  assert.deepEqual(listenOptions(hosted), { host: '0.0.0.0', port: 10000 });
  for (const patch of [{ ALLOW_PUBLIC_BIND: '' }, { ADMIN_PASSWORD: '' }, { APP_URL: 'http://localhost:10000' }, { PORT: 'NaN' }]) assert.throws(() => listenOptions({ ...hosted, ...patch }));
});

test('public health probe exposes only readiness while the app requires Basic authentication', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'affiliate-auth-'));
  const password = 'test-admin-password-at-least-twenty-characters';
  const app = await createApp({ env: { DATA_DIR: directory, ADMIN_PASSWORD: password } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`; app.providers.config.appUrl = base;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const health = await fetch(base + '/healthz'); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(base + '/')).status, 401);
  assert.equal((await fetch(base + '/api/status')).status, 401);
  const authorized = await fetch(base + '/api/status', { headers: { Authorization: 'Basic ' + Buffer.from('admin:' + password).toString('base64') } }); assert.equal(authorized.status, 200);
});
