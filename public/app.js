const $ = id => document.getElementById(id);
const names = { youtube: 'YouTube Shorts', facebook: 'Facebook Reels', tiktok: 'TikTok' };
const states = { queued: 'Đang chờ', uploading: 'Đang gửi', processing: 'Đang xử lý', published: 'Đã đăng / xử lý xong', needs_action: 'Cần hoàn tất trong TikTok', failed: 'Gửi thất bại', interrupted: 'Chưa xác nhận — kiểm tra trước khi gửi lại' };
let status, videos = [], selectedVideo, busy = false, creatorReady = false, lastJobs = [], pending;
try { pending = JSON.parse(sessionStorage.getItem('pending-publication') || 'null'); } catch { pending = null; }
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = 'notice' + (error ? ' error' : ''); $('notice').hidden = false; }
async function api(path, options = {}) {
  let r;
  try { r = await fetch(path, { ...options, headers: { 'X-Requested-With': 'affiliate-studio', ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); }
  catch { throw new Error('Mất kết nối máy chủ. Nếu đang đăng, hãy kiểm tra lịch sử trước khi gửi lại.'); }
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error || 'Yêu cầu thất bại.'), { status: r.status });
  return data;
}
function button(text, fn, className = 'subtle') { const b = el('button', text, className); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { notice(e.message, true); } finally { b.disabled = false; } }); return b; }
function selectedPlatforms() { return [...document.querySelectorAll('#targets input:checked')].map(n => n.value); }
async function loadStatus() {
  status = await api('/api/status');
  const previouslySelected = selectedPlatforms();
  $('connections').replaceChildren(); $('targets').replaceChildren(); $('callbacks').replaceChildren();
  for (const [p, a] of Object.entries(status.accounts)) {
    const card = el('article', undefined, 'channel'), top = el('div', undefined, 'channel-top');
    const ready = a.connected && (p !== 'facebook' || a.pageId);
    top.append(el('h3', names[p]), el('span', ready ? 'Đã kết nối' : a.configured ? 'Chưa kết nối' : 'Cần cấu hình', 'tag' + (ready ? ' ready' : '')));
    card.append(top, el('p', a.connected ? a.label : p === 'tiktok' ? 'Gửi vào hộp nháp hoặc Direct Post khi đủ quyền.' : p === 'facebook' ? 'Đăng Reels lên Trang bạn quản lý.' : 'Đăng video lên kênh YouTube của bạn.'));
    const actions = el('div', undefined, 'actions');
    const connect = button(a.connected ? 'Kết nối lại' : 'Kết nối tài khoản', async () => { const data = await api('/api/connect/' + p, { method: 'POST' }); location.assign(data.url); }, '');
    connect.disabled = !a.configured; actions.append(connect);
    if (a.connected) actions.append(button('Ngắt kết nối', async () => { await api('/api/accounts/' + p, { method: 'DELETE' }); creatorReady = false; await loadStatus(); notice('Đã xóa kết nối trên máy chủ. Bạn có thể thu hồi quyền trong cài đặt tài khoản nền tảng.'); }));
    card.append(actions);
    if (p === 'facebook' && a.pages.length) {
      const label = el('label', 'Trang nhận video'), select = el('select'); select.setAttribute('aria-label', 'Chọn Trang Facebook'); select.append(new Option('Chọn Trang…', ''));
      for (const page of a.pages) select.append(new Option(page.name, page.id));
      select.value = a.pageId || ''; select.addEventListener('change', async () => { if (!select.value) return; select.disabled = true; try { await api('/api/facebook/page', { method: 'POST', body: JSON.stringify({ pageId: select.value }) }); await loadStatus(); } catch (e) { notice(e.message, true); select.value = a.pageId || ''; } finally { select.disabled = false; } });
      label.append(select); card.append(label);
    }
    if (p === 'tiktok') card.append(el('p', status.tiktokMode === 'direct' ? 'Chế độ Direct Post · cần quyền video.publish.' : 'Chế độ hộp nháp · hoàn tất đăng trong TikTok.'));
    $('connections').append(card);
    const target = el('label'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = p; checkbox.disabled = !ready; checkbox.checked = ready && previouslySelected.includes(p); checkbox.addEventListener('change', updateOptions); target.append(checkbox, document.createTextNode(names[p])); $('targets').append(target);
    $('callbacks').append(el('dt', names[p]), el('dd', status.callbacks[p]));
  }
  if (Object.values(status.accounts).every(a => !a.configured)) $('setup').open = true;
  await updateOptions();
}
async function loadCreator() {
  creatorReady = false; $('tiktok-privacy').replaceChildren(new Option('Đang lấy quyền xem…', '')); updatePublish();
  try {
    const info = await api('/api/tiktok/creator');
    $('creator-name').textContent = `Tài khoản TikTok: ${info.creator_nickname || info.creator_username}. Giới hạn: ${info.max_video_post_duration_sec} giây.`;
    $('tiktok-privacy').replaceChildren(new Option('Chọn quyền xem…', ''));
    const labels = { PUBLIC_TO_EVERYONE: 'Công khai', MUTUAL_FOLLOW_FRIENDS: 'Bạn bè hai chiều', FOLLOWER_OF_CREATOR: 'Người theo dõi', SELF_ONLY: 'Chỉ mình tôi' };
    for (const value of info.privacy_level_options || []) $('tiktok-privacy').append(new Option(labels[value] || value, value));
    for (const [id, key] of [['allow-comment', 'comment_disabled'], ['allow-duet', 'duet_disabled'], ['allow-stitch', 'stitch_disabled']]) { $(id).checked = false; $(id).disabled = Boolean(info[key]); }
    creatorReady = true;
  } catch (e) { $('tiktok-privacy').replaceChildren(new Option('Không tải được — làm mới kết nối', '')); notice(e.message, true); }
  disclosure(); updatePublish();
}
async function updateOptions() {
  const targets = selectedPlatforms();
  $('youtube-options').hidden = !targets.includes('youtube');
  const wasHidden = $('tiktok-options').hidden;
  $('tiktok-options').hidden = !targets.includes('tiktok') || status?.tiktokMode !== 'direct';
  if (!$('tiktok-options').hidden && (wasHidden || !creatorReady)) await loadCreator();
  updatePublish();
}
function disclosure() {
  $('commercial-options').hidden = !$('commercial').checked;
  const branded = $('commercial').checked && $('branded').checked;
  $('disclosure-note').textContent = branded ? 'TikTok Direct Post: nhãn “Paid partnership”; không hỗ trợ quyền xem Chỉ mình tôi.' : $('own-brand').checked ? 'TikTok Direct Post: nhãn “Promotional content”.' : 'Chọn ít nhất một loại nội dung quảng bá.';
  $('music-label').textContent = branded ? 'Khi đăng, tôi đồng ý với Branded Content Policy và Music Usage Confirmation của TikTok.' : 'Khi đăng, tôi đồng ý với Music Usage Confirmation của TikTok.';
  const onlyMe = [...$('tiktok-privacy').options].find(o => o.value === 'SELF_ONLY');
  if (onlyMe) { onlyMe.disabled = branded; if (branded && $('tiktok-privacy').value === 'SELF_ONLY') $('tiktok-privacy').value = ''; }
  updatePublish();
}
function updatePublish() {
  if (pending) { $('publish').disabled = busy; $('publish').textContent = busy ? 'Đang xác nhận…' : 'Kiểm tra lượt gửi chưa xác nhận ↗'; $('publish-summary').textContent = 'Có yêu cầu chưa nhận được phản hồi. Nút này kiểm tra/gửi lại cùng mã lượt, giúp tránh tạo lượt trùng.'; return; }
  const targets = selectedPlatforms();
  const ytValid = !targets.includes('youtube') || ($('youtube-privacy').value && $('kids').value);
  const ttValid = !targets.includes('tiktok') || status?.tiktokMode !== 'direct' || (creatorReady && $('tiktok-privacy').value && $('music-consent').checked);
  const commercialValid = !$('commercial').checked || $('own-brand').checked || $('branded').checked;
  $('publish').disabled = busy || !selectedVideo || !targets.length || !$('title').value.trim() || !$('consent').checked || !ytValid || !ttValid || !commercialValid;
  $('publish').textContent = busy ? 'Đang gửi yêu cầu…' : targets.length === 3 ? 'Gửi video đến cả 3 kênh ↗' : `Gửi video đến ${targets.length || 'các'} kênh ↗`;
  $('publish-summary').textContent = targets.length ? targets.map(p => names[p] + (p === 'tiktok' && status?.tiktokMode === 'inbox' ? ' (hộp nháp)' : '')).join(' · ') + (targets.includes('facebook') ? ' · Facebook Reel sẽ công khai trên Trang.' : '') : 'Chọn video và kết nối tài khoản để bắt đầu.';
}
function selectVideo(id) {
  selectedVideo = videos.find(v => v.id === id); $('saved-video').value = selectedVideo?.id || ''; $('delete-video').disabled = !selectedVideo;
  $('preview').hidden = !selectedVideo;
  if (selectedVideo) { $('preview').src = '/api/videos/' + selectedVideo.id; $('video-info').textContent = `${selectedVideo.width} × ${selectedVideo.height} · ${selectedVideo.duration} giây · ${selectedVideo.fps} fps · ${(selectedVideo.size / 1024 / 1024).toFixed(1)} MB`; }
  else { $('preview').removeAttribute('src'); $('preview').load(); $('video-info').textContent = 'Khuyến nghị 1080 × 1920, 24–60 fps.'; }
  updatePublish();
}
async function loadVideos(id = selectedVideo?.id) {
  videos = await api('/api/videos'); $('saved-video').replaceChildren(new Option('Chọn video đã lưu…', ''));
  for (const v of videos) $('saved-video').append(new Option(`${new Date(v.createdAt).toLocaleString('vi-VN')} · ${v.duration}s · ${(v.size / 1024 / 1024).toFixed(1)} MB`, v.id));
  selectVideo(id);
}
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; if (!file) return;
  if (file.size > 256 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.mp4')) { notice('Chọn video .mp4 không quá 256 MB.', true); $('file').value = ''; return; }
  $('file').disabled = true; busy = true; updatePublish(); $('upload-progress').hidden = false; $('upload-progress').textContent = 'Đang tải video…';
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/videos'); xhr.setRequestHeader('Content-Type', 'video/mp4'); xhr.setRequestHeader('X-Requested-With', 'affiliate-studio'); xhr.timeout = 600000;
      xhr.upload.onprogress = e => { if (e.lengthComputable) $('upload-progress').textContent = `Đã gửi ${Math.round(e.loaded / e.total * 100)}% — đang nhận và kiểm tra video…`; };
      xhr.onerror = xhr.ontimeout = () => reject(new Error('Mất kết nối hoặc hết thời gian tải video. Kiểm tra danh sách video trước khi tải lại.'));
      xhr.onload = () => { try { const data = JSON.parse(xhr.responseText); if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || 'Tải video thất bại.')); } catch { reject(new Error('Máy chủ không trả phản hồi hợp lệ.')); } }; xhr.send(file);
    });
    await loadVideos(data.id); notice('Video đã sẵn sàng. Nhập nội dung và chọn kênh để gửi.');
  } catch (e) { notice(e.message, true); }
  finally { $('file').disabled = false; $('file').value = ''; $('upload-progress').hidden = true; busy = false; updatePublish(); }
});
$('saved-video').addEventListener('change', () => selectVideo($('saved-video').value));
$('delete-video').addEventListener('click', async () => { if (!selectedVideo || !confirm('Xóa tệp video khỏi máy chủ? Lịch sử đăng và video đã gửi lên các kênh vẫn được giữ.')) return; try { await api('/api/videos/' + selectedVideo.id, { method: 'DELETE' }); await loadVideos(''); } catch (e) { notice(e.message, true); } });
$('compose').addEventListener('input', updatePublish);
for (const id of ['commercial', 'own-brand', 'branded']) $(id).addEventListener('change', disclosure);
$('compose').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  if (!pending) {
    pending = { id: crypto.randomUUID(), input: { videoId: selectedVideo.id, platforms: selectedPlatforms(), title: $('title').value, caption: $('caption').value, youtubePrivacy: $('youtube-privacy').value, madeForKids: $('kids').value === '' ? null : $('kids').value === 'true', tiktokPrivacy: $('tiktok-privacy').value, allowComment: $('allow-comment').checked, allowDuet: $('allow-duet').checked, allowStitch: $('allow-stitch').checked, commercial: $('commercial').checked, ownBrand: $('own-brand').checked, brandedContent: $('branded').checked, aiGenerated: $('ai').checked, musicConsent: $('music-consent').checked, consent: $('consent').checked } };
    sessionStorage.setItem('pending-publication', JSON.stringify(pending));
  }
  busy = true; updatePublish();
  try {
    await api('/api/publish', { method: 'POST', headers: { 'Idempotency-Key': pending.id }, body: JSON.stringify(pending.input) });
    pending = null; sessionStorage.removeItem('pending-publication'); $('consent').checked = false; notice('Đã tiếp nhận lượt gửi. Xem trạng thái từng kênh trong lịch sử.'); await loadJobs(); $('history-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { if (e.status && e.status < 500) { pending = null; sessionStorage.removeItem('pending-publication'); } notice(e.message, true); }
  finally { busy = false; updatePublish(); }
});
function renderJobs() {
  $('jobs').replaceChildren();
  if (!lastJobs.length) { $('jobs').append(el('p', 'Chưa có lượt đăng nào. Video tiếp theo bắt đầu từ bạn.', 'muted')); return; }
  for (const job of lastJobs) {
    const article = el('article', undefined, 'job'), heading = el('div', undefined, 'job-title'), title = el('div');
    title.append(el('h3', job.title)); const time = el('time', new Date(job.createdAt).toLocaleString('vi-VN')); time.dateTime = job.createdAt; title.append(time); heading.append(title); article.append(heading);
    const results = el('div', undefined, 'results');
    for (const [p, r] of Object.entries(job.results)) {
      const card = el('div', undefined, 'result ' + r.state); card.append(el('strong', names[p]), el('span', states[r.state] || r.state, 'state'));
      if (r.accountLabel) card.append(el('p', r.accountLabel));
      card.append(el('p', r.message || ''));
      if (r.url && /^https:\/\/(www\.youtube\.com|www\.facebook\.com)\//.test(r.url)) { const a = el('a', 'Mở video ↗'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; card.append(a); }
      results.append(card);
    }
    const actions = el('div', undefined, 'job-actions');
    if (Object.values(job.results).some(r => ['processing', 'interrupted'].includes(r.state))) actions.append(button('Kiểm tra trạng thái', async () => { const updated = await api('/api/jobs/' + job.id + '/refresh', { method: 'POST' }); lastJobs = lastJobs.map(j => j.id === job.id ? updated : j); renderJobs(); }));
    actions.append(button('Sao chép tiêu đề + caption', async () => { try { await navigator.clipboard.writeText(job.title + (job.caption ? '\n' + job.caption : '')); notice('Đã sao chép nội dung.'); } catch { notice('Trình duyệt không cho sao chép. Xem nội dung trong mục bên dưới.', true); } }));
    article.append(results, actions);
    const details = el('details'), summary = el('summary', 'Xem nội dung đã gửi'); details.append(summary, el('p', job.title + '\n' + job.caption)); article.append(details); $('jobs').append(article);
  }
}
async function loadJobs() {
  lastJobs = await api('/api/jobs');
  if (pending && lastJobs.some(j => j.id === pending.id)) { pending = null; sessionStorage.removeItem('pending-publication'); updatePublish(); }
  renderJobs();
}
$('reload').addEventListener('click', () => { creatorReady = false; loadStatus().catch(e => notice(e.message, true)); });
$('reload-jobs').addEventListener('click', () => loadJobs().catch(e => notice(e.message, true)));
let polling = false;
setInterval(async () => {
  if (polling || document.hidden) return; polling = true;
  try {
    // Only poll recent unfinished requests; old interrupted jobs are checked explicitly.
    for (const job of lastJobs.slice(0, 5)) if (Object.values(job.results).some(r => r.state === 'processing') && Date.now() - new Date(job.createdAt).getTime() < 20 * 60 * 1000) await api('/api/jobs/' + job.id + '/refresh', { method: 'POST' });
    if (lastJobs.some(j => Object.values(j.results).some(r => ['queued', 'uploading', 'processing'].includes(r.state)))) await loadJobs();
  } catch (e) { notice(e.message, true); } finally { polling = false; }
}, 15000);
(async () => { try { await Promise.all([loadStatus(), loadVideos(), loadJobs()]); if (new URL(location.href).searchParams.has('connected')) { notice('Đã kết nối tài khoản. Chọn kênh và kiểm tra nội dung trước khi đăng.'); history.replaceState({}, '', '/'); } } catch (e) { notice(e.message, true); } })();
