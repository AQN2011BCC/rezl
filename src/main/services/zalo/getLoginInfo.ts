import * as crypto from "node:crypto";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig, getTempRoot } from "./config/AppConfig.js";

// __dirname tương đương, không phụ thuộc vào nơi lệnh `node` được chạy
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../../..");
const TMP_DIR = path.join(ROOT_DIR, "tmp");

// ============================================================
// CONFIG
// ============================================================

const API_TYPE = "30";
const CLIENT_VERSION = "690";
const TEST_ZCID_MASTER_KEY = "3FC4F0D2AB50057BCE0D90D9187A22B1";
const IV = Buffer.alloc(16, 0);

const SESSION_FILE = path.join(TMP_DIR, "session.json");
const OUTPUT_FILE = path.join(TMP_DIR, "getLoginInfo.json");

const log = {
    info: (msg) => console.log(`[ZALO_SERVICE:getLoginInfo] ${msg}`),
    warn: (msg) => console.warn(`[ZALO_SERVICE:getLoginInfo] ${msg}`),
    error: (msg, err) => console.error(`[ZALO_SERVICE:getLoginInfo] ${msg}`, err?.message ?? err ?? ""),
};

// ============================================================
// AES HELPERS
// ============================================================

/**
 * PyCryptodome tự nhận diện AES-128/192/256 dựa theo độ dài key (16/24/32 byte).
 * Node yêu cầu chỉ định rõ thuật toán, nên phải tự suy ra tương đương ở đây —
 * không được hardcode "aes-128-cbc" vì key trong luồng này thường dài 32 byte (AES-256).
 */
function getAesAlgorithm(keyBuffer: Buffer): string {
    switch (keyBuffer.length) {
        case 16:
            return "aes-128-cbc";
        case 24:
            return "aes-192-cbc";
        case 32:
            return "aes-256-cbc";
        default:
            throw new Error(
                `Invalid AES key length: ${keyBuffer.length} byte`
            );
    }
}

function aesEncrypt(
    key: string,
    plaintext: string
): Buffer {
    const keyBuffer = Buffer.from(key, "utf8");

    const cipher = crypto.createCipheriv(
        getAesAlgorithm(keyBuffer),
        keyBuffer,
        IV
    );

    return Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
}

function aesEncryptBase64(
    key: string,
    plaintext: string
): string {
    return aesEncrypt(key, plaintext).toString("base64");
}

function aesEncryptHexUpper(
    key: string,
    plaintext: string
): string {
    return aesEncrypt(key, plaintext)
        .toString("hex")
        .toUpperCase();
}

function aesDecryptBase64(
    key: string,
    ciphertextB64: string
): string {
    const raw = Buffer.from(ciphertextB64, "base64");
    const keyBuffer = Buffer.from(key, "utf8");

    const decipher = crypto.createDecipheriv(
        getAesAlgorithm(keyBuffer),
        keyBuffer,
        IV
    );

    const plaintext = Buffer.concat([
        decipher.update(raw),
        decipher.final(),
    ]);

    return plaintext.toString("utf8");
}

// ============================================================
// CIPHER & PARAM BUILDERS
// ============================================================

function randomHex(length = 12) {
    const chars = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < length; i++) {
        out += chars[crypto.randomInt(chars.length)];
    }
    return out;
}

function processStr(value) {
    if (!value || typeof value !== "string") return [null, null];
    let even = "";
    let odd = "";
    for (let i = 0; i < value.length; i++) {
        if (i % 2 === 0) even += value[i];
        else odd += value[i];
    }
    return [even, odd];
}

class ZaloParamCipher {
    apiType: string;
    clientId: string;
    firstLaunchTime: number;
    masterKey: string;
    encVer: string;
    zcid: string;
    zcidExt: string;
    encryptKey: string;

    constructor(apiType, clientId, firstLaunchTime, masterKey = TEST_ZCID_MASTER_KEY) {
        this.apiType = apiType;
        this.clientId = clientId;
        this.firstLaunchTime = firstLaunchTime;
        this.masterKey = masterKey;
        this.encVer = "v2";

        this.zcid = this.createZcid();
        this.zcidExt = randomHex(12);
        this.encryptKey = this.createEncryptKey();
    }

    createZcid() {
        const plaintext = `${this.apiType},${this.clientId},${this.firstLaunchTime}`;
        return aesEncryptHexUpper(this.masterKey, plaintext);
    }

    createEncryptKey() {
        const md5ZcidExt = crypto.createHash("md5").update(this.zcidExt).digest("hex").toUpperCase();
        const [md5Even] = processStr(md5ZcidExt);
        const [zcidEven, zcidOdd] = processStr(this.zcid);

        if (!md5Even || !zcidEven || !zcidOdd) {
            throw new Error("processStr failed");
        }

        const zcidOddReversed = zcidOdd.split("").reverse().join("");
        return md5Even.slice(0, 8) + zcidEven.slice(0, 12) + zcidOddReversed.slice(0, 12);
    }

    getParams() {
        return {
            zcid: this.zcid,
            zcid_ext: this.zcidExt,
            enc_ver: this.encVer,
        };
    }
}

function getSignKey(
    operation: string,
    params: ZaloRequestParams
): string {
    const keys = Object.keys(params).sort();

    let material = "zsecure" + operation;

    for (const key of keys) {
        material += String(params[key as keyof ZaloRequestParams]);
    }

    return crypto
        .createHash("md5")
        .update(material, "utf8")
        .digest("hex");
}

interface ZaloBaseParams {
    zcid: string;
    zcid_ext: string;
    enc_ver: string;
}

interface ZaloRequestParams extends ZaloBaseParams {
    params: string;
    type: string;
    client_version: string;
    nretry: string;
    signkey: string;
}

function encryptParam(
    data: unknown,
    operation: string,
    clientId: string
): {
    params: ZaloRequestParams;
    encryptionKey: string;
} {
    const cipher = new ZaloParamCipher(
        API_TYPE,
        clientId,
        Date.now()
    );

    const plaintext = JSON.stringify(data);
    const encryptedData = aesEncryptBase64(
        cipher.encryptKey,
        plaintext
    );

    const params: ZaloRequestParams = {
        ...cipher.getParams(),
        params: encryptedData,
        type: API_TYPE,
        client_version: CLIENT_VERSION,
        nretry: "0",
        signkey: "",
    };

    params.signkey = getSignKey(operation, params);

    return {
        params,
        encryptionKey: cipher.encryptKey,
    };
}

// ============================================================
// SESSION LOADING
// ============================================================

async function loadSession(sessionPath) {
    let raw;
    try {
        raw = await fs.readFile(sessionPath, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") {
            throw new Error(`session file not found at ${sessionPath}. Please log in again.`);
        }
        throw new Error(`failed to read session file at ${sessionPath}: ${err.message ?? err}`);
    }

    let session;
    try {
        session = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Invalid JSON in session file at "${sessionPath}". Details: ${err?.message ?? err}`);
    }

    if (!session.cookie || !session.imei || !session.userAgent) {
        throw new Error(`Invalid session file at "${sessionPath}": missing required fields (cookie, imei, userAgent).`);
    }

    return session;
}

/**
 * session.cookie có thể là mảng cookie object (dạng zca-js lưu) hoặc object key-value.
 * Chuẩn hóa về dạng { name: value } để build header Cookie.
 */
function normalizeCookies(cookie) {
    if (Array.isArray(cookie)) {
        const out = {};
        for (const c of cookie) {
            if (c?.key && c?.value !== undefined) out[c.key] = c.value;
            else if (c?.name && c?.value !== undefined) out[c.name] = c.value;
        }
        return out;
    }
    if (cookie && typeof cookie === "object") return cookie;
    return {};
}

function buildCookieHeader(cookieObj) {
    return Object.entries(cookieObj)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

// ============================================================
// LẤY THÔNG TIN ĐĂNG NHẬP TỪ SESSION ĐÃ LƯU
// ============================================================

/**
 * Đọc tmp/session.json, gửi request getLoginInfo tới Zalo, giải mã response
 * và lưu kết quả vào tmp/zalo_getLoginInfo_response.json.
 *
 * @returns {Promise<object>} dữ liệu response đã (được) giải mã
 */
export async function getLoginInfo() {
    const config = await ensureConfig();
    const tmpDir = getTempRoot(config);
    const session = await loadSession(path.join(tmpDir, "session.json"));
    const clientId = session.imei;
    const cookies = normalizeCookies(session.cookie);

    const loginInfo = {
        imei: clientId,
        computer_name: os.hostname() || "ZANONYMOUS",
        language: "vi",
        ts: Date.now(),
        localIP: "127.0.0.1",
        width: 1920,
        height: 1080,
    };

    // 1. Tạo parameters và key mã hóa
    const { params, encryptionKey } = encryptParam(loginInfo, "getlogininfo", clientId);

    // 2. Chuẩn bị request
    const url = new URL("https://wpa.chat.zalo.me/api/login/getLoginInfo");
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const headers = {
        "User-Agent": session.userAgent,
        Referer: "https://chat.zalo.me/",
        Origin: "https://chat.zalo.me",
        Cookie: buildCookieHeader(cookies),
    };

    log.info(`Sending GET request to: ${url.origin}${url.pathname}`);

    const response = await fetch(url, { method: "GET", headers });
    log.info(`HTTP Status: ${response.status}`);

    const rawBody = await response.text();

    if (!rawBody) {
        throw new Error(
            `Server returned an empty body (HTTP ${response.status}). ` +
            `The cookie, IMEI, or userAgent in session.json may be expired or invalid.`
        );
    }

    let resData;
    try {
        resData = JSON.parse(rawBody);
    } catch (err) {
        const preview = rawBody.slice(0, 300);
        throw new Error(
            `Failed to parse response as JSON (HTTP ${response.status}). ` +
            `Received content: ${preview}`
        );
    }

    // 3. Giải mã trường 'data' nếu server trả về mã hóa AES (error_code == 0)
    if (resData?.error_code === 0 && typeof resData.data === "string") {
        try {
            const decryptedStr = aesDecryptBase64(encryptionKey, resData.data);
            resData.data = JSON.parse(decryptedStr);
            log.info("Successfully decrypted Zalo response data.");
        } catch (err: any) {
            log.warn(`Failed to decrypt response payload: ${err?.message ?? err}`);
        }
    }

    // 4. Lưu kết quả ra file JSON
    const outputFile = path.join(tmpDir, "getLoginInfo.json");
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(outputFile, JSON.stringify(resData, null, 2), "utf8");
    log.info(`Results saved to: ${outputFile}`);

    return resData;
}
