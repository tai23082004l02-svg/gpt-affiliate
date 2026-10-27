# Affiliate Studio

Công cụ web tiếng Việt cho một chủ sở hữu: tải video một lần, chọn các kênh và gửi đến **YouTube Shorts, Facebook Page Reels và TikTok**. Có xem trước video, caption, lựa chọn quyền xem, kết nối OAuth và lịch sử trạng thái riêng cho từng nền tảng.

**Chưa kết nối tài khoản thì công cụ không thể đăng thật.** Đây là ứng dụng Node.js có máy chủ, không chạy bằng GitHub Pages. Việc đẩy mã lên GitHub không tự triển khai website.

## Bắt đầu

Cần **Node.js 24.5+**, npm và **FFmpeg/ffprobe** trong PATH. Không có thư viện npm ngoài, không cần `npm install` hoặc cơ sở dữ liệu.

```bash
# Ubuntu/Debian, nếu máy chưa có ffmpeg:
sudo apt-get update && sudo apt-get install -y ffmpeg

# Trong thư mục gpt-affiliate:
cp .env.example .env
chmod 600 .env
npm start
```

Mở địa chỉ `APP_URL` (mặc định `http://localhost:3100`) trên chính máy chạy ứng dụng. Chỉnh `.env` rồi khởi động lại nếu cần kết nối tài khoản. Không ghi secret/token vào Git, caption hoặc trình duyệt. Cổng mặc định là **3100**, không trùng app `game-mobile` ở cổng 3000.

1. Cấu hình ứng dụng developer cho các nền tảng bên dưới.
2. Bấm **Kết nối tài khoản**, cấp quyền ở trang chính thức của nền tảng. Với Facebook, chọn đúng Trang nhận video.
3. Tải MP4 H.264, âm thanh AAC hoặc không có âm thanh; video dọc 9:16, tối thiểu 540×960, 24–60 fps, dài 3–90 giây, tối đa 256 MiB. Nên xuất 1080×1920. Máy chủ kiểm tra lại bằng ffprobe; không tự crop, chuyển mã, thêm nhạc hoặc sửa video.
4. Nhập tiêu đề/caption, chọn các kênh, quyền xem/đối tượng YouTube và khai báo thương mại/AI phù hợp. Kiểm tra video trước khi đồng ý và gửi.
5. Theo dõi trong **Lịch sử đăng**. TikTok nháp cần thao tác hoàn tất trong TikTok.

## Khả năng và giới hạn thực tế

| Kênh | Khi bấm gửi | Điều kiện / giới hạn |
| --- | --- | --- |
| YouTube | Upload video bằng resumable upload; kiểm tra xử lý và quyền xem thực tế | Cần OAuth + YouTube Data API v3. YouTube tự quyết định phân loại Shorts theo video/quy định; `#shorts` không bảo đảm. Dự án chưa qua audit có thể bị ép private. |
| Facebook | Upload rồi gửi lệnh xuất bản Reel công khai lên **Trang** đã chọn | Cần quyền quản lý nội dung Trang, quyền API/app review khi áp dụng. Không hỗ trợ profile cá nhân. Kiểm tra/bổ sung nhãn Paid partnership trên Trang nếu cần. |
| TikTok mặc định | Gửi video vào **hộp nháp/inbox** qua `video.upload` | Mở thông báo trong TikTok, nhập caption/hashtag, khai báo quảng cáo, chọn quyền xem và bấm Đăng. API inbox không áp dụng caption; có nút sao chép nội dung trong lịch sử. |
| TikTok Direct Post (tùy chọn) | Gửi trực tiếp bằng `video.publish`, theo quyền xem người dùng chọn | Chỉ bật khi ứng dụng đủ điều kiện/quyền. Client chưa audit bị giới hạn private. TikTok nêu rõ tiện ích chỉ đăng cho tài khoản cá nhân/nhóm nội bộ không phải trường hợp đủ điều kiện để audit. Không bảo đảm công cụ riêng của bạn sẽ được duyệt. |

Công cụ không tự gắn sản phẩm TikTok Shop/Shopee, không tạo link affiliate, không tạo video, không lên lịch đăng và không tự đăng lại. Link dán trong caption chỉ là văn bản; khả năng bấm link phụ thuộc nền tảng. Công cụ chỉ gửi video người dùng tự chọn, không tải/copy video từ mạng xã hội khác.

Khai báo nội dung thương mại gửi sang YouTube (`hasPaidProductPlacement`) và TikTok Direct (`brand_content_toggle` / `brand_organic_toggle`). Với Facebook và TikTok inbox, chủ tài khoản cần hoàn tất nhãn phù hợp trên nền tảng. Các trường AI được gửi sang các API hỗ trợ; TikTok inbox hoàn tất trong ứng dụng.

## Cấu hình OAuth

Điền giá trị vào `.env` **trên máy chủ**, không gửi secret qua chat. Giao diện hiển thị chính xác callback dựa trên `APP_URL`. Không cần cấu hình tất cả các nền tảng: có thể chạy với một kênh đã sẵn sàng.

### YouTube

- Tạo Google Cloud project, bật **YouTube Data API v3**; cấu hình OAuth consent screen/test users.
- Tạo OAuth client **Web application**; điền `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- Authorized redirect URI: `APP_URL/oauth/youtube/callback`, ví dụ `http://localhost:3100/oauth/youtube/callback` khi phát triển trên máy cá nhân. Origin/callback cần khớp chính xác.
- Quyền: `youtube.upload`, `youtube.readonly` (đọc tên kênh và trạng thái xử lý). Dùng OAuth server-side + PKCE, xin refresh token. Không dùng YouTube API key để upload.
- Tài khoản Google phải có kênh YouTube. Chọn quyền xem và đối tượng trẻ em cho từng lượt đăng. Quota, audit, OAuth verification và hạn dùng refresh token vẫn do Google quản lý.

### Facebook Page Reels

- Tạo Meta app hỗ trợ Facebook Login; cấu hình sản phẩm/use case và domain theo Meta dashboard.
- Điền `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`; `META_GRAPH_VERSION` mặc định `v26.0`, thay theo phiên bản ứng dụng được Meta hỗ trợ khi cần.
- Valid OAuth Redirect URI: `APP_URL/oauth/facebook/callback`.
- Quyền: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`; người kết nối phải có task tạo nội dung trên Trang.
- Server đổi user token sang long-lived token, đọc Page access token. Chọn Trang rõ ràng, không tự lấy Trang đầu tiên. App review/Advanced Access/Business Verification có thể cần khi phục vụ người ngoài app roles. Token bị thu hồi/hết quyền thì kết nối lại.

### TikTok

- Tạo ứng dụng trong TikTok for Developers, thêm **Login Kit** và **Content Posting API**.
- Điền `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
- Redirect URI: `APP_URL/oauth/tiktok/callback`. Dùng domain HTTPS hợp lệ đã cấu hình với TikTok; localhost không đáp ứng yêu cầu redirect web production của TikTok.
- Mặc định `TIKTOK_DIRECT_POST_ENABLED=false`: xin `user.info.basic,video.upload`, dùng Upload API đưa vào inbox.
- Chỉ bật `TIKTOK_DIRECT_POST_ENABLED=true` khi ứng dụng đủ điều kiện và có `video.publish`, rồi **kết nối lại TikTok** để cấp scope mới. Nếu chưa được audit, không hứa hẹn đăng công khai/affiliate trực tiếp.
- Direct Post đọc creator info mới, hiển thị tên tài khoản/quyền xem; không chọn sẵn quyền xem hoặc bật sẵn comment/duet/stitch. Kiểm tra giới hạn thời lượng, đồng ý Music Usage Confirmation và Branded Content Policy khi áp dụng. Branded content không chấp nhận `SELF_ONLY`.

## Chạy trên máy chủ / dùng từ điện thoại

Chạy trên máy luôn bật có ổ đĩa bền vững. Ứng dụng này dành cho **một chủ sở hữu**, không phải SaaS nhiều người dùng. Giữ `HOST=127.0.0.1`; đặt reverse proxy HTTPS phía trước nếu muốn mở từ điện thoại. GitHub Pages không thể chạy backend này.

- Đặt `APP_URL=https://ten-mien-cua-ban.example` và `ADMIN_PASSWORD` ngẫu nhiên **ít nhất 20 ký tự**; tên đăng nhập Basic Auth là `admin`. Server từ chối khởi động với domain ngoài nếu thiếu HTTPS/mật khẩu. Nên đặt mật khẩu cả khi dùng localhost.
- Proxy cần giữ `Host` đúng domain `APP_URL`, chuyển toàn bộ đường dẫn (kể cả `/oauth/*`) về port 3100, giới hạn body khoảng 270 MB và timeout upload tối thiểu 600 giây. Không expose trực tiếp cổng Node ra Internet. Không dùng domain dùng chung cho nội dung không tin cậy.
- Đổi các redirect URI trong ba developer console tương ứng domain HTTPS này. Không đổi qua lại `localhost` và `127.0.0.1`; server kiểm tra Host/Origin.
- Node chạy với `--use-env-proxy`, giữ HTTP(S)_PROXY và CA trust của môi trường cloud. TLS/checksum verification không bị tắt. Mạng cần các endpoint OAuth/API: `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `www.facebook.com`, `graph.facebook.com`, `rupload.facebook.com`, `www.tiktok.com`, `open.tiktokapis.com`, `open-upload.tiktokapis.com` và host upload vùng do TikTok trả về như `upload.us.tiktokapis.com`. Với mạng restricted, chỉ thêm đúng host bị chặn qua cài đặt môi trường.
- Không bật log URL callback, body OAuth, token hoặc URL upload có chữ ký ở reverse proxy. Dùng HTTPS cho mọi người truy cập từ xa.

## Lưu trữ và lỗi giữa chừng

- `.data/` được Git bỏ qua: video cục bộ tối đa tổng 2 GiB; `state.enc` chứa tài khoản, token và lịch sử mã hóa AES-256-GCM; `encryption.key` quyền 0600. Mã hóa không thay thế việc bảo vệ máy chủ: người đọc được cả key và state có thể giải mã. Không backup/chia sẻ dữ liệu này công khai.
- Giữ lại **cả key và state** nếu di chuyển máy. Không chạy nhiều process/replica cùng `DATA_DIR`. Không đổi key khi còn muốn dùng token cũ.
- Mỗi lượt gửi có idempotency key; gửi lại cùng request không tạo upload mới. Mỗi nền tảng xử lý độc lập, không rollback video đã gửi nếu kênh khác lỗi. Không tự retry upload khi mất phản hồi, tránh đăng trùng.
- Khi server restart, các bước đang upload được đánh dấu **chưa xác nhận**. Dùng Kiểm tra trạng thái và kiểm tra trực tiếp kênh trước khi tạo lượt mới. Không tự tiếp tục upload sau restart. Nếu chưa có remote ID/session thì cần kiểm tra tài khoản thủ công.
- Máy chủ lưu trạng thái; giao diện đang mở tự kiểm tra các lượt xử lý gần đây mỗi 15 giây, tối đa 20 phút. Lượt cũ có nút kiểm tra thủ công. Đóng trình duyệt không hủy upload đang chạy trên máy chủ, nhưng không có worker polling nền sau đó.
- “Đang xử lý” không có nghĩa “đã đăng”. TikTok inbox chỉ báo cần hoàn tất khi API xác nhận đã gửi vào inbox. YouTube hiển thị quyền xem thực tế do API trả về.
- Nút Ngắt kết nối xóa token khỏi máy chủ, không thay thế việc thu hồi quyền trong cài đặt Google/Facebook/TikTok. Xóa video chỉ xóa tệp cục bộ, không xóa bài đã đăng hoặc lịch sử.

## Kiểm thử

```bash
npm run check
npm test
```

Bộ kiểm thử tạo MP4 thật bằng ffmpeg và dùng ffprobe, kiểm tra HTTP upload/range/delete, OAuth code/state/PKCE, token refresh, lưu trữ mã hóa/restart, kiểm tra dữ liệu trước đăng, gửi ba adapter, chống gửi trùng, lỗi riêng từng nền tảng và chunk upload TikTok Direct. Mạng xã hội được **giả lập**; không sử dụng tài khoản hoặc đăng bài thật trong kiểm thử. CI chạy Node 24 và FFmpeg trên Ubuntu.

Giao diện có thể chạy và kiểm tra ngay khi chưa có OAuth. Việc đăng thật chỉ được xác nhận sau khi chủ tài khoản cấu hình app, cấp quyền và thực hiện một lượt kiểm tra có chủ ý trên tài khoản của mình.

## Tài liệu chính thức

- [YouTube resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
- [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [Facebook Reels Publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing/)
- [TikTok Direct Post](https://developers.tiktok.com/doc/content-posting-api-get-started)
- [TikTok Upload API](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video)
- [TikTok media transfer/chunks](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
- [TikTok content sharing guidelines / eligibility](https://developers.tiktok.com/doc/content-sharing-guidelines)
