import { Zalo } from "zca-js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig, getTempRoot } from "./config/AppConfig.js";

// __dirname tương đương, không phụ thuộc vào nơi lệnh `node` được chạy
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../../.."); // zalo-service/
const TMP_DIR = path.join(ROOT_DIR, "tmp");

async function getStorageTmpDir() {
    const config = await ensureConfig();
    return getTempRoot(config);
}
const SESSION_FILE = path.join(TMP_DIR, "session.json");
const QR_FILE = path.join(TMP_DIR, "qr.png");

const log = {
    info: (msg) => console.log(`[ZALO_SERVICE:login] ${msg}`),
    warn: (msg) => console.warn(`[ZALO_SERVICE:login] ${msg}`),
    error: (msg, err) => console.error(`[ZALO_SERVICE:login] ${msg}`, err?.message ?? err ?? ""),
};

/**
 * Đọc và validate session đã lưu.
 * @returns {Promise<{cookie: any, imei: string, userAgent: string} | null>}
 */
async function loadSession() {
    const tmpDir = await getStorageTmpDir();
    const sessionFile = path.join(tmpDir, "session.json");
    let raw;
    try {
        raw = await fs.readFile(sessionFile, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") {
            log.info("session.json not found, falling back to QR login.");
        } else {
            log.error("Failed to read session.json:", err);
        }
        return null;
    }

    try {
        const session = JSON.parse(raw);
        const { cookie, imei, userAgent } = session;

        if (!cookie || !imei || !userAgent) {
            log.warn("session.json is missing cookie, imei, or userAgent.");
            return null;
        }

        log.info("Found valid session.json.");
        return session;
    } catch (err) {
        log.error("session.json is not valid JSON:", err);
        return null;
    }
}

/**
 * Trích xuất credential hiện tại từ api context, có fallback về session cũ.
 */
function extractCredentials(api, oldSession) {
    const context = api.getContext();

    const cookie =
        context.cookie?.toJSON?.()?.cookies ??
        context.cookie?.cookies ??
        oldSession?.cookie ??
        null;

    const imei = context.imei ?? oldSession?.imei ?? null;
    const userAgent = context.userAgent ?? oldSession?.userAgent ?? null;

    return { cookie, imei, userAgent };
}

/**
 * Lưu session xuống đĩa. Trả về true nếu thành công.
 */
async function saveSession(api, oldSession = null) {
    const tmpDir = await getStorageTmpDir();
    const sessionFile = path.join(tmpDir, "session.json");
    const credentials = extractCredentials(api, oldSession);
    const { cookie, imei, userAgent } = credentials;

    if (!cookie || !imei || !userAgent) {
        log.warn("Insufficient info to save session, skipping.");
        return false;
    }

    try {
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(sessionFile, JSON.stringify(credentials, null, 2), "utf8");
        log.info(`Saved session to ${sessionFile}`);
        return true;
    } catch (err) {
        log.error("Failed to save session:", err);
        return false;
    }
}

/**
 * zca-js (bản hiện tại) không tự lưu file QR — nó trả về ảnh QR dạng base64
 * (PNG) ngay trong object callback, tại data.image. Ta tự giải mã và ghi
 * thẳng thành tmp/qr.png, không cần đụng tới file nào của thư viện nữa.
 *
 * Lưu ý: callback này được zca-js gọi lại nhiều lần cho nhiều sự kiện khác
 * nhau trong tiến trình QR login (tạo QR, quét xong, đăng nhập thành công...),
 * chỉ sự kiện tạo QR mới có data.image — các lần gọi khác bỏ qua trong im lặng,
 * không phải lỗi.
 */
async function saveQrImage(qrCallbackArg) {
    const tmpDir = await getStorageTmpDir();
    const qrFile = path.join(tmpDir, "qr.png");
    const base64Image = qrCallbackArg?.data?.image;

    if (!base64Image || typeof base64Image !== "string") {
        return null; // sự kiện khác (đã quét, đăng nhập thành công...), không phải lỗi
    }

    try {
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(qrFile, Buffer.from(base64Image, "base64"));
        log.info(`Saved QR code to ${qrFile}`);
        return qrFile;
    } catch (err) {
        log.warn(`Failed to save QR image to tmp/: ${err?.message ?? err}`);
        return null;
    }
}

/**
 * Thử đăng nhập lại bằng session đã lưu.
 * @returns {Promise<{zalo: Zalo, api: any, restored: true} | null>}
 */
async function tryRestoreSession(session) {
    log.info("Restoring session from cache...");
    const zalo = new Zalo();

    try {
        const api = await zalo.login({
            cookie: session.cookie,
            imei: session.imei,
            userAgent: session.userAgent,
        });

        log.info("Session restored successfully.");
        // Chờ ghi xong session mới trả kết quả — tránh race condition với nơi
        // đọc lại session.json ngay sau khi loginZalo() resolve (vd getLoginInfo.js)
        await saveSession(api, session);
        return { zalo, api, restored: true };
    } catch (err) {
        log.warn(`Invalid session: ${err?.message ?? err}`);
        return null;
    }
}

/**
 * Đăng nhập bằng mã QR.
 * @returns {Promise<{zalo: Zalo, api: any, restored: false}>}
 */
async function loginWithQR() {
    log.info("Generating login QR code...");
    const zalo = new Zalo();

    const api = await zalo.loginQR({}, (qrCallbackArg) => {
        // zca-js trả về ảnh QR dạng base64 trong callback; tự lưu thành tmp/qr.png
        saveQrImage(qrCallbackArg);
    });

    log.info("QR login successful.");
    await saveSession(api);

    return { zalo, api, restored: false };
}

/**
 * Đăng nhập Zalo: ưu tiên session cũ, fallback sang QR nếu thất bại.
 *
 * `restored` trong kết quả trả về cho biết đăng nhập đến từ session cũ (true)
 * hay vừa đăng nhập QR mới (false) — dùng để quyết định có cần chạy lại các
 * bước chỉ cần thiết sau một lần đăng nhập mới hay không (vd getLoginInfo).
 *
 * @returns {Promise<{zalo: Zalo, api: any, restored: boolean}>}
 */
export async function loginZalo() {
    const session = await loadSession();

    if (session) {
        const restored = await tryRestoreSession(session);
        if (restored) return restored;
        log.info("Falling back to QR login...");
    }

    return loginWithQR();
}
