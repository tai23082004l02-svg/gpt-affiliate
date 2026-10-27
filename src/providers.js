import { createReadStream } from 'node:fs';

export const PLATFORMS = ['youtube', 'facebook', 'tiktok'];
const TOKEN_URL = { youtube: 'https://oauth2.googleapis.com/token', tiktok: 'https://open.tiktokapis.com/v2/oauth/token/' };
const SCOPES = {
  youtube: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
  facebook: 'pages_show_list,pages_read_engagement,pages_manage_posts',
};
export function configuration(env) {
  const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 3100}`).replace(/\/$/, '');
  const base = new URL(appUrl);
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password || !['http:', 'https:'].includes(base.protocol)) throw new Error('APP_URL phải là origin HTTP(S), không kèm đường dẫn.');
  if (!['localhost', '127.0.0.1'].includes(base.hostname) && (base.protocol !== 'https:' || (env.ADMIN_PASSWORD || '').length < 20)) throw new Error('Tên miền công khai cần HTTPS và ADMIN_PASSWORD ít nhất 20 ký tự.');
  return {
    appUrl, direct: env.TIKTOK_DIRECT_POST_ENABLED === 'true',
    youtube: { client: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET },
    facebook: { client: env.FACEBOOK_APP_ID, secret: env.FACEBOOK_APP_SECRET, version: env.META_GRAPH_VERSION || 'v26.0' },
    tiktok: { client: env.TIKTOK_CLIENT_KEY, secret: env.TIKTOK_CLIENT_SECRET },
  };
}
export function configured(config, platform) { return Boolean(config[platform]?.client && config[platform]?.secret); }
export function callbackUrl(config, platform) { return `${config.appUrl}/oauth/${platform}/callback`; }
export function authorizationUrl(config, platform, state, challenge) {
  if (!configured(config, platform)) throw new Error('Chưa cấu hình thông tin OAuth trên máy chủ.');
  const c = config[platform];
  const url = new URL(platform === 'youtube' ? 'https://accounts.google.com/o/oauth2/v2/auth' : platform === 'facebook' ? `https://www.facebook.com/${c.version}/dialog/oauth` : 'https://www.tiktok.com/v2/auth/authorize/');
  url.search = new URLSearchParams({ [platform === 'tiktok' ? 'client_key' : 'client_id']: c.client, redirect_uri: callbackUrl(config, platform), response_type: 'code', state, scope: platform === 'tiktok' ? `user.info.basic,video.upload${config.direct ? ',video.publish' : ''}` : SCOPES[platform] });
  if (platform === 'youtube') { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent'); url.searchParams.set('code_challenge', challenge); url.searchParams.set('code_challenge_method', 'S256'); }
  return url.href;
}
// Do not echo provider response bodies: they can contain tokens, signed URLs or user data.
export async function request(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(options.body?.pipe ? 600000 : 45000), ...(options.body?.pipe ? { duplex: 'half' } : {}) }); }
  catch { throw new Error('Không xác nhận được phản hồi nền tảng. Kiểm tra kết nối/trạng thái trước khi gửi lại.'); }
  if (!response.ok) throw new Error(`Nền tảng trả HTTP ${response.status}. Kiểm tra quyền ứng dụng, token, quota và định dạng video.`);
  return response;
}
export async function json(url, options = {}, fetcher = fetch) {
  const data = await (await request(url, options, fetcher)).json();
  if (data.error && data.error.code !== 'ok') throw new Error('API từ chối yêu cầu. Kiểm tra quyền, hạn mức và cài đặt tài khoản trong developer console.');
  return data;
}
const bearer = token => ({ Authorization: `Bearer ${token}` });
const postJson = (token, body) => ({ method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const form = body => ({ method: 'POST', body: new URLSearchParams(body) });
export function uploadUrl(value, platform) {
  const u = new URL(value);
  const allowed = platform === 'youtube' ? u.hostname === 'www.googleapis.com' : platform === 'facebook' ? u.hostname === 'rupload.facebook.com' : /^(?:open-upload(?:-[a-z]+)?|upload(?:\.[a-z]+)?)\.tiktokapis\.com$/.test(u.hostname);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !allowed) throw new Error('Nền tảng trả địa chỉ tải video không hợp lệ.');
  return u.href;
}
function withExpiry(data, previous = {}) {
  if (!data.access_token) throw new Error('OAuth không trả access token. Kết nối lại tài khoản.');
  return { ...previous, access_token: data.access_token, refresh_token: data.refresh_token || previous.refresh_token, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 };
}
export class Providers {
  constructor(config, store, fetcher = fetch) { this.config = config; this.store = store; this.fetch = fetcher; this.refreshes = new Map(); }
  graph(path) {
    if (!/^v\d+\.0$/.test(this.config.facebook.version)) throw new Error('META_GRAPH_VERSION không hợp lệ.');
    return `https://graph.facebook.com/${this.config.facebook.version}/${path}`;
  }
  async connect(platform, code, verifier) {
    const c = this.config[platform];
    if (!configured(this.config, platform)) throw new Error('Chưa cấu hình OAuth.');
    let account;
    if (platform === 'facebook') {
      const short = await json(this.graph('oauth/access_token'), form({ client_id: c.client, client_secret: c.secret, redirect_uri: callbackUrl(this.config, platform), code }), this.fetch);
      const long = await json(this.graph('oauth/access_token'), form({ grant_type: 'fb_exchange_token', client_id: c.client, client_secret: c.secret, fb_exchange_token: short.access_token }), this.fetch);
      let after, pages = [];
      for (let i = 0; i < 20; i++) {
        const query = new URLSearchParams({ fields: 'id,name,access_token,tasks', limit: '100', ...(after ? { after } : {}) });
        const batch = await json(this.graph('me/accounts?' + query), { headers: bearer(long.access_token) }, this.fetch);
        pages.push(...(batch.data || []).filter(p => p.access_token && p.tasks?.some(t => ['CREATE_CONTENT', 'MANAGE', 'PROFILE_PLUS_CREATE_CONTENT'].includes(t))));
        if (!batch.paging?.next) break;
        after = batch.paging?.cursors?.after;
        if (!after || i === 19) throw new Error('Danh sách Trang vượt giới hạn. Hãy chỉ cấp quyền cho các Trang cần dùng.');
      }
      if (!pages.length) throw new Error('Không tìm thấy Trang Facebook có quyền tạo nội dung. Kiểm tra quyền pages_manage_posts và quyền quản lý Trang.');
      account = { label: 'Chọn Trang Facebook', pages: pages.map(p => ({ id: p.id, name: p.name, access_token: p.access_token })) };
    } else {
      const data = await json(TOKEN_URL[platform], form({ [platform === 'tiktok' ? 'client_key' : 'client_id']: c.client, client_secret: c.secret, code, grant_type: 'authorization_code', redirect_uri: callbackUrl(this.config, platform), ...(platform === 'youtube' ? { code_verifier: verifier } : {}) }), this.fetch);
      account = withExpiry(data);
      if (platform === 'youtube') {
        const channels = await json('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: bearer(account.access_token) }, this.fetch);
        if (!channels.items?.length) throw new Error('Tài khoản Google chưa có kênh YouTube.');
        account.label = channels.items[0].snippet.title; account.id = channels.items[0].id;
      } else {
        const user = await json('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: bearer(account.access_token) }, this.fetch);
        account.label = user.data?.user?.display_name || 'TikTok'; account.id = user.data?.user?.open_id;
      }
    }
    this.store.state.accounts[platform] = account;
    await this.store.save();
  }
  async token(platform) {
    const account = this.store.state.accounts[platform];
    if (!account) throw new Error('Hãy kết nối tài khoản trước.');
    if (platform === 'facebook') {
      const page = account.pages.find(p => p.id === account.pageId);
      if (!page) throw new Error('Hãy chọn Trang Facebook để đăng.');
      return page.access_token;
    }
    if (account.expires_at > Date.now() + 120000) return account.access_token;
    if (!account.refresh_token) throw new Error('Phiên đăng nhập hết hạn. Hãy kết nối lại tài khoản.');
    if (!this.refreshes.has(platform)) {
      const pending = (async () => {
        const c = this.config[platform];
        const data = await json(TOKEN_URL[platform], form({ [platform === 'tiktok' ? 'client_key' : 'client_id']: c.client, client_secret: c.secret, grant_type: 'refresh_token', refresh_token: account.refresh_token }), this.fetch);
        Object.assign(account, withExpiry(data, account)); await this.store.save(); return account.access_token;
      })().finally(() => this.refreshes.delete(platform));
      this.refreshes.set(platform, pending);
    }
    return this.refreshes.get(platform);
  }
  async creator() {
    if (!this.config.direct) throw new Error('Ứng dụng đang ở chế độ gửi nháp TikTok.');
    const data = await json('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', postJson(await this.token('tiktok'), {}), this.fetch);
    return data.data;
  }
  async publish(platform, video, post, progress) {
    const token = await this.token(platform), file = this.store.videoPath(video.id), size = video.size;
    if (platform === 'youtube') {
      const init = await request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,paidProductPlacementDetails', {
        ...postJson(token, { snippet: { title: post.title, description: post.caption, categoryId: '22' }, status: { privacyStatus: post.youtubePrivacy, selfDeclaredMadeForKids: post.madeForKids, containsSyntheticMedia: post.aiGenerated }, paidProductPlacementDetails: { hasPaidProductPlacement: post.brandedContent } }),
        headers: { ...bearer(token), 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
      }, this.fetch);
      const location = uploadUrl(init.headers.get('location'), platform);
      // Save the session so a lost response can be checked without inserting a second video.
      await progress({ session: location, state: 'uploading' });
      const data = await json(location, { method: 'PUT', headers: { ...bearer(token), 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: createReadStream(file) }, this.fetch);
      if (!data.id) throw new Error('YouTube chưa trả video ID. Kiểm tra kênh trước khi đăng lại.');
      return { remoteId: data.id, state: 'processing', url: `https://www.youtube.com/watch?v=${encodeURIComponent(data.id)}`, message: 'YouTube đã nhận video, đang kiểm tra trạng thái xử lý.' };
    }
    if (platform === 'facebook') {
      const pageId = this.store.state.accounts.facebook.pageId;
      const init = await json(this.graph(`${pageId}/video_reels`), postJson(token, { upload_phase: 'start' }), this.fetch);
      if (!init.video_id) throw new Error('Facebook chưa trả video ID.');
      await progress({ remoteId: init.video_id, state: 'uploading' });
      await json(uploadUrl(init.upload_url, platform), { method: 'POST', headers: { Authorization: `OAuth ${token}`, 'Content-Type': 'application/octet-stream', offset: '0', file_size: String(size), 'Content-Length': String(size) }, body: createReadStream(file) }, this.fetch);
      const finish = await json(this.graph(`${pageId}/video_reels`), postJson(token, { upload_phase: 'finish', video_id: init.video_id, video_state: 'PUBLISHED', title: post.title, description: post.caption, is_ai_generated: post.aiGenerated }), this.fetch);
      if (!finish.success) throw new Error('Facebook chưa xác nhận lệnh xuất bản. Kiểm tra Trang trước khi gửi lại.');
      return { remoteId: init.video_id, state: 'processing', url: `https://www.facebook.com/reel/${encodeURIComponent(init.video_id)}`, message: 'Facebook đã nhận lệnh đăng, đang xử lý Reel.' };
    }
    const direct = this.config.direct;
    let info;
    if (direct) {
      info = await this.creator();
      validateTikTok(post, info, video);
    }
    const chunkSize = Math.min(size, 32 * 1024 * 1024);
    const chunks = Math.max(1, Math.floor(size / chunkSize));
    const body = { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: chunks } };
    if (direct) body.post_info = { title: post.caption ? `${post.title}\n${post.caption}` : post.title, privacy_level: post.tiktokPrivacy, disable_comment: !post.allowComment || Boolean(info.comment_disabled), disable_duet: !post.allowDuet || Boolean(info.duet_disabled), disable_stitch: !post.allowStitch || Boolean(info.stitch_disabled), brand_content_toggle: post.brandedContent, brand_organic_toggle: post.ownBrand, is_aigc: post.aiGenerated };
    const init = await json(`https://open.tiktokapis.com/v2/post/publish/${direct ? 'video' : 'inbox/video'}/init/`, postJson(token, body), this.fetch);
    if (!init.data?.publish_id) throw new Error('TikTok chưa trả mã lượt đăng.');
    await progress({ remoteId: init.data.publish_id, mode: direct ? 'direct' : 'inbox', state: 'uploading' });
    const location = uploadUrl(init.data.upload_url, platform);
    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize, end = i === chunks - 1 ? size - 1 : start + chunkSize - 1;
      await request(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` }, body: createReadStream(file, { start, end }) }, this.fetch);
    }
    return { remoteId: init.data.publish_id, mode: direct ? 'direct' : 'inbox', state: 'processing', message: direct ? 'TikTok đang xử lý video.' : 'TikTok đang nhận video. Caption cần nhập và xác nhận trong TikTok.' };
  }
  async status(platform, result) {
    const token = await this.token(platform);
    if (platform === 'youtube') {
      let id = result.remoteId;
      if (!id && result.session) {
        const r = await request(uploadUrl(result.session, platform), { method: 'PUT', headers: { ...bearer(token), 'Content-Length': '0', 'Content-Range': `bytes */${result.videoSize}` } }, this.fetch);
        const data = await r.json(); id = data.id;
        if (!id) return {};
      }
      if (!id) return {};
      const data = await json(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, { headers: bearer(token) }, this.fetch);
      const v = data.items?.[0];
      if (!v) return { message: 'Chưa đọc được video trên kênh. Kiểm tra YouTube Studio.' };
      if (['failed', 'rejected', 'deleted'].includes(v.status?.uploadStatus) || ['failed', 'terminated'].includes(v.processingDetails?.processingStatus)) return { state: 'failed', message: 'YouTube không xử lý được video. Kiểm tra YouTube Studio.' };
      if (v.status?.uploadStatus === 'processed') return { remoteId: id, state: 'published', actualPrivacy: v.status.privacyStatus, url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, message: `YouTube đã xử lý video (${v.status.privacyStatus}). YouTube quyết định phân loại Shorts.` };
      return { remoteId: id, state: 'processing' };
    }
    if (!result.remoteId) return {};
    if (platform === 'facebook') {
      const data = await json(this.graph(`${encodeURIComponent(result.remoteId)}?fields=status`), { headers: bearer(token) }, this.fetch);
      const s = data.status;
      if (s?.publishing_phase?.publish_status === 'published' || s?.publishing_phase?.status === 'complete' || s?.publishing_phase?.status === 'completed') return { state: 'published', message: 'Facebook xác nhận Reel đã xuất bản.' };
      if ([s?.video_status, s?.processing_phase?.status, s?.publishing_phase?.status, s?.publishing_phase?.publish_status].includes('error')) return { state: 'failed', message: 'Facebook báo lỗi xử lý/xuất bản. Kiểm tra video trên Trang.' };
      return { message: 'Facebook đang xử lý; có thể mất vài phút.' };
    }
    const data = await json('https://open.tiktokapis.com/v2/post/publish/status/fetch/', postJson(token, { publish_id: result.remoteId }), this.fetch);
    if (data.data?.status === 'PUBLISH_COMPLETE') return { state: 'published', message: 'TikTok xác nhận video đã được đăng.' };
    if (data.data?.status === 'SEND_TO_USER_INBOX') return { state: 'needs_action', message: 'Mở thông báo trong TikTok, nhập caption, khai báo affiliate/quảng cáo và bấm Đăng để hoàn tất.' };
    if (data.data?.status === 'FAILED') return { state: 'failed', message: 'TikTok từ chối xử lý video. Kiểm tra quyền, video và trạng thái trong ứng dụng.' };
    return { message: 'TikTok đang xử lý video.' };
  }
}
export function validateTikTok(post, info, video) {
  if (!info?.privacy_level_options?.includes(post.tiktokPrivacy)) throw new Error('Hãy chọn quyền xem từ danh sách hiện tại của TikTok.');
  if (video.duration > info.max_video_post_duration_sec) throw new Error('Video dài hơn giới hạn tài khoản TikTok hiện tại.');
  if (!post.musicConsent) throw new Error('Cần đồng ý Music Usage Confirmation của TikTok.');
  if (post.brandedContent && post.tiktokPrivacy === 'SELF_ONLY') throw new Error('Branded content không thể đặt Chỉ mình tôi trên TikTok.');
  if ([...`${post.title}${post.caption ? '\n' + post.caption : ''}`].length > 2200) throw new Error('Tiêu đề và caption TikTok tối đa 2.200 ký tự.');
}
