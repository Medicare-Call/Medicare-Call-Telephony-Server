import { TWILIO_CALLER_NUMBERS } from '../config/env';
import logger from '../config/logger';

const activeCallerNumbers = new Set<string>();
export const callToCallerNumber = new Map<string, string>();

export function getAvailableCallerNumber(): string | null {
    for (const number of TWILIO_CALLER_NUMBERS) {
        if (!activeCallerNumbers.has(number)) {
            return number;
        }
    }
    return null;
}

export function startUsingCallerNumber(number: string): void {
    activeCallerNumbers.add(number);
    logger.info(
        `발신 번호 사용 시작: ${number} (사용 중: ${activeCallerNumbers.size}/${TWILIO_CALLER_NUMBERS.length})`
    );
}

export function stopUsingCallerNumber(number: string): void {
    if (activeCallerNumbers.has(number)) {
        activeCallerNumbers.delete(number);
        logger.info(
            `발신 번호 사용 종료: ${number} (사용 중: ${activeCallerNumbers.size}/${TWILIO_CALLER_NUMBERS.length})`
        );
    }
}

export function getActiveCallerCount(): number {
    return activeCallerNumbers.size;
}
