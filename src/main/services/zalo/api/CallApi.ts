import type { AppConfig } from "../config/AppConfig.js";
import { NativeZCall, type ZCallConfig } from "../call/NativeZCall.js";

export class CallApi {
    readonly native: NativeZCall;
    private eventTimer: NodeJS.Timeout | null = null;
    private readonly listeners = new Set<(event: unknown) => void>();

    constructor(private readonly config: AppConfig) {
        this.native = new NativeZCall(config);
    }

    health() { return this.native.health(); }
    test() { return this.native.test(); }

    onEvent(listener: (event: unknown) => void): () => void {
        this.listeners.add(listener);
        this.native.load();
        this.native.setCallback((event) => this.emit(event));
        return () => this.listeners.delete(listener);
    }

    private emit(event: unknown) {
        for (const listener of this.listeners) {
            try { listener(event); } catch {}
        }
    }

    startEventPolling(intervalMs = 30): void {
        this.native.load();
        if (this.eventTimer) return;
        this.eventTimer = setInterval(() => {
            try {
                const event = this.native.getEventMessage();
                if (event != null && event !== -100) this.emit(event);
            } catch {
                // Native engine may return no event while idle.
            }
        }, Math.max(10, intervalMs));
    }

    stopEventPolling(): void {
        if (this.eventTimer) clearInterval(this.eventTimer);
        this.eventTimer = null;
    }

    configure(config: ZCallConfig, caller = true, video = true): void {
        this.native.setConfig(config, caller, video);
    }

    makeCall(config: ZCallConfig, video = true): void {
        this.configure(config, true, video);
        this.native.makeCall();
    }

    answerCall(config: ZCallConfig, video = true): void {
        this.configure(config, false, video);
        this.native.incomingCall();
    }

    stopCall(): void {
        this.stopEventPolling();
        this.native.stop();
    }

    controls() {
        return {
            mute: (value: boolean) => this.native.mute(value),
            holdAudio: (hold: boolean, local = false) => this.native.holdAudio(hold, local),
            stopCapture: (stop: boolean) => this.native.stopCapture(stop),
            changeAudioDevice: (inputId: number, outputId: number) => this.native.changeAudioDevice(inputId, outputId),
            changeVideoDevice: (id: string) => this.native.changeVideoDevice(id),
            setAgc: (auto: boolean) => this.native.setAgc(auto),
            setAudioVolume: (input: number, output: number) => this.native.setAudioVolume(input, output),
            startDesktopCapture: () => this.native.startDesktopCapture(),
            stopDesktopCapture: () => this.native.stopDesktopCapture(),
            changeBitrate: () => this.native.changeMinMaxMobileBitrate(),
            getDevices: () => this.native.getListDevices(),
            getCallInfo: () => this.native.getCallInfo(),
            getExtendData: () => this.native.getExtendData(),
            getActiveAudioCodecs: () => this.native.getActiveAudioCodecs(),
        };
    }
}
