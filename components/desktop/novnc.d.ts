declare module "@novnc/novnc/lib/rfb.js" {
  export default class RFB {
    constructor(target: HTMLElement, url: string);
    background: string;
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnect(): void;
    addEventListener(type: string, callback: EventListener): void;
  }
}
