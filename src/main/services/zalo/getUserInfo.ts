import { AvatarSize } from "zca-js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig, getAvatarRoot, getTempRoot } from "./config/AppConfig.js";

// __dirname tương đương, không phụ thuộc vào nơi lệnh `node` được chạy
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../../..");
const TMP_DIR = path.join(ROOT_DIR, "tmp");


const log = {
    info: (msg) => console.log(`[ZALO_SERVICE:getUserInfo] ${msg}`),
    warn: (msg) => console.warn(`[ZALO_SERVICE:getUserInfo] ${msg}`),
    error: (msg, err) => console.error(`[ZALO_SERVICE:getUserInfo] ${msg}`, err?.message ?? err ?? ""),
};

/**
 * Đọc UserInfo.json hiện có. Trả về mảng rỗng nếu file chưa tồn tại hoặc hỏng.
 */
async function loadUserInfoList(userInfoFile: string) {
    try {
        const raw = await fs.readFile(userInfoFile, "utf8");
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
    } catch (err) {
        if (err.code !== "ENOENT") {
            log.warn(`Failed to read existing UserInfo.json, recreating: ${err?.message ?? err}`);
        }
        return [];
    }
}

/**
 * Gộp danh sách profile mới vào UserInfo.json — cập nhật displayName nếu id
 * đã tồn tại, thêm mới nếu chưa có. Không lưu avatar ở đây vì ảnh đã được
 * lưu riêng dưới tmp/avatar/<userId>.<ext>, tra theo id là đủ, không cần
 * trùng lặp đường dẫn trong file JSON này.
 */
async function persistUserInfo(profiles, userInfoFile: string, avatarDir: string) {
    if (profiles.length === 0) return;

    await fs.mkdir(path.dirname(userInfoFile), { recursive: true });

    const existing = await loadUserInfoList(userInfoFile);
    const byId = new Map(existing.map((entry) => [entry.userId, entry]));

    for (const profile of profiles) {
        if (!profile?.userId) continue;
        byId.set(profile.userId, {
            userId: profile.userId,
            displayName: profile.displayName ?? profile.zaloName ?? "",
        });
    }

    const merged = Array.from(byId.values());
    await fs.writeFile(userInfoFile, JSON.stringify(merged, null, 2), "utf8");
    log.info(`Saved info for ${profiles.length} users to ${userInfoFile} (${merged.length} total).`);
}

/**
 * Suy ra phần mở rộng file ảnh từ URL avatar. Mặc định .jpg nếu không đoán được.
 */
function guessExtension(avatarUrl) {
    try {
        const { pathname } = new URL(avatarUrl);
        const ext = path.extname(pathname);
        return ext && ext.length <= 5 ? ext : ".jpg";
    } catch {
        return ".jpg";
    }
}

/**
 * Tải avatar của một user về tmp/avatar/<userId>.<ext>, bỏ qua nếu đã tồn tại
 * (vì file trùng tên với id, chỉ cần tra theo id khi đọc lại — không cần tải lại).
 */
async function downloadAvatar(profile, avatarDir: string) {
    const { userId, avatar } = profile ?? {};
    if (!userId || !avatar) return;

    await fs.mkdir(avatarDir, { recursive: true });

    const ext = guessExtension(avatar);
    const targetPath = path.join(avatarDir, `${userId}${ext}`);

    try {
        await fs.access(targetPath);
        return; // đã có sẵn, không tải lại
    } catch {
        // chưa có, tải mới
    }

    try {
        const response = await fetch(avatar);
        if (!response.ok) {
            log.warn(`Failed to download avatar for ${userId} (HTTP ${response.status}).`);
            return;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(targetPath, buffer);
        log.info(`Downloaded avatar for ${userId} to ${targetPath}`);
    } catch (err) {
        log.warn(`Failed to download avatar for ${userId}: ${err?.message ?? err}`);
    }
}

/**
 * Lấy thông tin (tên hiển thị, avatar, giới tính, trạng thái...) của một hoặc
 * nhiều user Zalo cùng lúc — dùng chung một request thay vì gọi riêng lẻ từng
 * id, để tối ưu tốc độ khi chuẩn bị dữ liệu cho giao diện (ví dụ danh sách bạn
 * bè, danh sách thành viên nhóm...).
 *
 * Mỗi lần gọi sẽ tự động:
 *   - Lưu {userId, displayName} vào tmp/UserInfo.json (gộp, không ghi đè các
 *     user đã lưu trước đó).
 *   - Tải avatar về tmp/avatar/<userId>.<ext>, bỏ qua nếu ảnh đã tồn tại sẵn.
 *
 * @param {object} api - instance `api` trả về từ `loginZalo()` (zca-js)
 * @param {string | string[]} userId - 1 id hoặc mảng nhiều id cùng lúc
 * @param {number} [avatarSize] - kích thước avatar mong muốn (mặc định: AvatarSize.Small)
 *
 * @returns {Promise<object | object[] | null>}
 *   - Nếu truyền vào 1 id (string): trả về object thông tin user đó, hoặc
 *     `null` nếu Zalo không trả về thông tin (id không tồn tại/không có quyền xem).
 *   - Nếu truyền vào mảng id (string[]): trả về mảng object thông tin, theo
 *     đúng thứ tự các id còn tìm được — id nào không có dữ liệu sẽ bị bỏ qua.
 *
 * @throws {Error} nếu `api` hoặc `userId` không hợp lệ, hoặc request tới Zalo thất bại
 */
export async function getUserInfo(api, userId, avatarSize = AvatarSize.Small) {
    if (!api || typeof api.getUserInfo !== "function") {
        throw new Error("Invalid or missing 'api' — must provide the api object returned from loginZalo().");
    }
    if (!userId || (Array.isArray(userId) && userId.length === 0)) {
        throw new Error("Missing 'userId' — expected a string or an array of strings (string[]).");
    }

    const isSingleId = !Array.isArray(userId);
    const idList = isSingleId ? [userId] : userId;

    log.info(`Fetching info for ${idList.length} user(s)...`);

    const result = await api.getUserInfo(idList, avatarSize);

    const profiles = Object.values(result?.changed_profiles ?? {});
    const foundCount = profiles.length;
    const missingCount = idList.length - foundCount;

    if (missingCount > 0) {
        log.warn(`Failed to fetch info for ${missingCount}/${idList.length} ID(s) (non-existent or permission denied).`);
    }
    log.info(`Successfully fetched info for ${foundCount} user(s).`);

    const config = await ensureConfig();
    const tempRoot = getTempRoot(config);
    const userInfoFile = path.join(tempRoot, "UserInfo.json");
    const avatarDir = getAvatarRoot(config);

    await persistUserInfo(profiles, userInfoFile, avatarDir);
    await Promise.all(profiles.map((profile) => downloadAvatar(profile, avatarDir)));

    if (isSingleId) {
        return profiles[0] ?? null;
    }
    return profiles;
}
