import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function inspectVideo(file) {
  let result;
  try { result = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 30000, maxBuffer: 1024 * 1024 }); }
  catch (e) { throw new Error(e.code === 'ENOENT' ? 'Cần cài ffmpeg (bao gồm ffprobe) trên máy chủ.' : 'Không đọc được video MP4. Hãy xuất lại video H.264/AAC.'); }
  const data = JSON.parse(result.stdout);
  const stream = data.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(data.format?.duration), width = Number(stream?.width), height = Number(stream?.height);
  const rotation = Number(stream?.side_data_list?.find(d => d.rotation !== undefined)?.rotation || stream?.tags?.rotate || 0);
  const [w, h] = Math.abs(rotation) % 180 === 90 ? [height, width] : [width, height];
  const [n, d = 1] = String(stream?.avg_frame_rate || '0').split('/').map(Number);
  const fps = n / d;
  if (!stream || !data.format?.format_name?.split(',').includes('mp4') || stream.codec_name !== 'h264') throw new Error('Chọn video MP4 mã hóa H.264.');
  if (!Number.isFinite(duration) || duration < 3 || duration > 90) throw new Error('Bản này hỗ trợ video 3–90 giây để dùng chung ba nền tảng.');
  if (w < 540 || h < 960 || Math.abs(w / h - 9 / 16) > 0.015 || fps < 24 || fps > 60.1) throw new Error('Video cần dọc 9:16, tối thiểu 540×960, 24–60 fps. Khuyến nghị 1080×1920.');
  const audio = data.streams.filter(s => s.codec_type === 'audio');
  if (audio.some(s => s.codec_name !== 'aac')) throw new Error('Âm thanh cần mã hóa AAC hoặc video không có âm thanh.');
  return { duration: Math.round(duration * 100) / 100, width: w, height: h, fps: Math.round(fps * 100) / 100 };
}
