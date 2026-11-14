/* DOM shortcuts */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

Object.assign(Mapcast, { $, $$ });
})();
