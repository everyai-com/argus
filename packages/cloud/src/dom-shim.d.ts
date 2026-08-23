/**
 * Minimal ambient DOM declarations for code inside page.evaluate() callbacks.
 * Those closures execute in the browser, not the Worker — but they're
 * typechecked in the Worker's program, which (correctly) has no DOM lib.
 * Adding lib:["DOM"] would clash with @cloudflare/workers-types, so the few
 * globals evaluate-closures touch are declared loosely here instead.
 */
declare const document: any;
declare const window: any;
declare function getComputedStyle(el: any): any;
type HTMLElement = any;
type HTMLInputElement = any;
type HTMLButtonElement = any;
