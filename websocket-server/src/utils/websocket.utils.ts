import { RawData, WebSocket } from 'ws';

/**
 * WebSocket 메시지를 JSON으로 파싱
 */
export function parseMessage(data: RawData): any {
    try {
        return JSON.parse(data.toString());
    } catch {
        return null;
    }
}

/**
 * WebSocket으로 JSON 객체 전송
 */
export function jsonSend(ws: WebSocket | undefined, obj: unknown): void {
    if (!isOpen(ws)) return;
    ws.send(JSON.stringify(obj));
}

/**
 * WebSocket 연결 상태 확인
 */
export function isOpen(ws?: WebSocket): ws is WebSocket {
    return !!ws && ws.readyState === WebSocket.OPEN;
}
