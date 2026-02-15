declare module 'sse.js' {
    interface SSEOptions {
        headers?: Record<string, string>;
        payload?: string;
        method?: string;
    }

    class SSE extends EventTarget {
        constructor(url: string, options?: SSEOptions);
        stream(): void;
        close(): void;
        addEventListener(type: string, listener: (event: MessageEvent) => void): void;
    }

    export { SSE };
}
