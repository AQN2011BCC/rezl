import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { AppConfig } from "../config/AppConfig.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("ZALO_SERVICE:NativeZCall");

export interface ZCallConfig {
    fromId: string | number;
    toId?: string | number;
    protocol: number;
    callId: string | number;
    sessId: string;
    settings?: Record<string, unknown>;
    audioConfig?: string;
    extendData?: unknown;
    zrtc_config?: unknown;
    rtpIP?: string;
    rtcpIP?: string;
    servers?: Array<{ rtcpaddr: string; rtpaddr: string }>;
    changeZRTP?: { enable?: number; threshold?: number };
    clientVersion?: number | string;
}

/**
 * Thin adapter around Zalo's extracted zcall native addon.
 *
 * This adapter deliberately does not spawn or inject into ZaloCall.exe.
 * The native addon is the cleaner integration point because the extracted
 * source already exposes MainApp + the media/control methods used by Zalo PC.
 */
export class NativeZCall {
    private native: any = null;
    private instance: any = null;
    private running = false;
    private runtimePrepared = false;

    constructor(private readonly config: AppConfig) {}

    isSupported(): boolean {
        return process.platform === "win32" && process.arch === "ia32";
    }

    isLoaded(): boolean {
        return Boolean(this.instance);
    }

    getModulePath(): string {
        const configured = this.config.call.nativeModulePath.trim();
        if (configured) return path.resolve(configured);

        return path.resolve(
            process.cwd(),
            "native",
            "nativelibs",
            "zcall",
            "zcall_ia32.node",
        );
    }

    getRuntimeDir(): string {
        const configured = this.config.call.nativeRuntimePath?.trim?.() ?? "";
        if (configured) return path.resolve(configured);

        return path.resolve(process.cwd(), "native", "runtime", "win32-ia32");
    }

    private prepareRuntime(): void {
        if (this.runtimePrepared) return;

        const runtimeDir = this.getRuntimeDir();
        if (!fs.existsSync(runtimeDir)) {
            log.warn(`zcall runtime directory does not exist: ${runtimeDir}`);
            return;
        }

        // zcall_ia32.node imports an old Electron/Node-compatible node.dll.
        // Put only this private runtime directory at the front of PATH so the
        // Windows loader can resolve node.dll without touching System32.
        const separator = process.platform === "win32" ? ";" : path.delimiter;
        const current = process.env.PATH ?? "";
        const entries = current.split(separator).filter(Boolean);
        if (!entries.some((entry) => path.resolve(entry) === path.resolve(runtimeDir))) {
            process.env.PATH = `${runtimeDir}${separator}${current}`;
        }

        this.runtimePrepared = true;
    }

    load(): void {
        if (this.instance) return;
        if (!this.isSupported()) {
            throw new Error(`zcall native engine requires win32/ia32; got ${process.platform}/${process.arch}`);
        }

        const modulePath = this.getModulePath();
        if (!fs.existsSync(modulePath)) {
            throw new Error(`zcall native module not found: ${modulePath}`);
        }

        this.prepareRuntime();

        const require = createRequire(import.meta.url);
        try {
            this.native = require(modulePath);
        } catch (error: any) {
            const runtimeDir = this.getRuntimeDir();
            const nodeDll = path.join(runtimeDir, "node.dll");
            const detail = error?.message ?? String(error);
            throw new Error(
                `Failed to load zcall native module.\n` +
                `module=${modulePath}\n` +
                `runtime=${runtimeDir}\n` +
                `node.dll=${fs.existsSync(nodeDll) ? "present" : "missing"}\n` +
                `original=${detail}`,
            );
        }

        if (typeof this.native?.MainApp !== "function") {
            throw new Error("Loaded zcall module does not expose MainApp().");
        }

        this.instance = this.native.MainApp();
        if (!this.instance) throw new Error("zcall MainApp() returned no instance.");

        log.info(`native zcall loaded: ${modulePath}`);
    }

    private ensure(): any {
        this.load();
        if (!this.instance) throw new Error("zcall native instance unavailable.");
        return this.instance;
    }

    health(): { supported: boolean; loaded: boolean; modulePath: string } {
        return {
            supported: this.isSupported(),
            loaded: this.isLoaded(),
            modulePath: this.getModulePath(),
        };
    }

    test(): boolean {
        try {
            return this.ensure().test(123) === 123;
        } catch {
            return false;
        }
    }

    setCallback(callback: (event: unknown) => void): void {
        const instance = this.ensure();
        instance.setCallback((event: unknown) => callback(event));
    }

    setConfig(config: ZCallConfig, caller = true, isVideoCall = true, logPath = ""): void {
        const instance = this.ensure();
        const settingsJson = JSON.stringify(config.settings ?? {});
        const callConfig = JSON.stringify(config.zrtc_config ?? {});
        const servers = Array.isArray(config.servers) ? config.servers : [];
        const enableChangeZRTP = Boolean(config.changeZRTP?.enable);

        if (typeof instance.setConfig !== "function") {
            throw new Error("zcall native module does not expose setConfig().");
        }

        instance.setConfig(
            settingsJson,
            config.fromId,
            config.toId ?? 0,
            config.protocol,
            config.callId,
            config.sessId,
            callConfig,
            enableChangeZRTP,
            isVideoCall,
            logPath,
            `${process.platform} ${process.arch}`,
            Number(config.clientVersion ?? 0),
        );

        if (!caller && typeof instance.setMediaConfig === "function") {
            instance.setMediaConfig(config.audioConfig ?? "", config.extendData);
        }

        if (caller && servers.length && typeof instance.setListServers === "function") {
            instance.setListServers(JSON.stringify(servers));
        } else if (
            config.rtcpIP &&
            config.rtpIP &&
            typeof instance.setConfigServer === "function"
        ) {
            instance.setConfigServer(config.rtcpIP, config.rtpIP);
        }
    }

    makeCall(): void {
        this.ensure().makeCall();
        this.running = true;
    }

    incomingCall(): void {
        this.ensure().incomingCall();
        this.running = true;
    }

    stop(): void {
        try { this.instance?.stop?.(); } finally {
            this.running = false;
            this.instance = null;
            this.native = null;
        }
    }

    isRunning(): boolean {
        return this.running;
    }

    getEventMessage(): unknown {
        const value = this.ensure().getEventMessage();
        if (value === -100 || value == null) return value;
        if (typeof value === "string") {
            try { return JSON.parse(value); } catch { return value; }
        }
        return value;
    }

    getCallInfo(): unknown { return this.ensure().getCallInfo(); }
    getExtendData(): unknown { return this.ensure().getExtendData(); }
    getActiveAudioCodecs(): unknown { return this.ensure().getActiveAudioCodecs(); }
    getListDevices(): unknown { return this.ensure().getListDevices(); }

    getVideoFrame(buffer: Buffer): unknown { return this.ensure().getVideoFrame(buffer); }
    getVideoFrameLocal(buffer: Buffer): unknown { return this.ensure().getVideoFrameLocal(buffer); }

    mute(value: boolean): void { this.ensure().mute(Boolean(value)); }
    stopCapture(value: boolean): void { this.ensure().stopCapture(Boolean(value)); }
    holdAudio(hold: boolean, local = false): void { this.ensure().holdAudio(Boolean(hold), Boolean(local)); }
    changeAudioDevice(inputId: number, outputId: number): void { this.ensure().changeAudioDevice(inputId, outputId); }
    changeVideoDevice(id: string): void { this.ensure().changeVideoDevice(id || `__id_default__zzzz_${Date.now()}`); }
    setAgc(auto: boolean): void { this.ensure().setAgc(Boolean(auto)); }
    setAudioVolume(input: number, output: number): unknown { return this.ensure().setAudioVolume(input, output); }
    startDesktopCapture(): void { this.ensure().startDesktopCapture(); }
    stopDesktopCapture(): void { this.ensure().stopDesktopCapture(); }
    changeMinMaxMobileBitrate(): void { this.ensure().changeMinMaxMobileBitrate(); }
    updateCallerInfo(audioConfig: string, extendData: unknown): void { this.ensure().updateCallerInfo(audioConfig, extendData); }
    setState(session: string, peerId: number, config: string): void { this.ensure().setState(session, peerId, config); }
}
