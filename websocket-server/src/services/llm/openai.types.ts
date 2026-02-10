export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface LLMCallbacks {
    onFirstToken?: () => void;
    onToken?: (token: string) => void;
    onComplete?: (fullResponse: string) => void;
    onError?: (error: Error) => void;
}
