declare module 'node-vad' {
    namespace VAD {
        enum Mode {
            NORMAL = 0,
            LOW_BITRATE = 1,
            AGGRESSIVE = 2,
            VERY_AGGRESSIVE = 3,
        }

        enum Event {
            ERROR = -1,
            SILENCE = 0,
            VOICE = 1,
        }
    }

    class VAD {
        constructor(mode: VAD.Mode);
        processAudio(audioBuffer: Buffer, sampleRate: number): Promise<VAD.Event>;
    }

    export = VAD;
}