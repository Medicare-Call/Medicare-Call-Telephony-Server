export interface TwilioMessage {
    event: string;
    sequenceNumber?: string;
    start?: {
        streamSid: string;
        accountSid: string;
        callSid: string;
        tracks: string[];
        customParameters: Record<string, string>;
        mediaFormat: {
            encoding: string;
            sampleRate: number;
            channels: number;
        };
    };
    media?: {
        track: string;
        chunk: string;
        timestamp: string;
        payload: string;
    };
    stop?: {
        accountSid: string;
        callSid: string;
    };
}
