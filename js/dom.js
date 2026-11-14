/* DOM shortcuts */
(() => {
'use strict';
const Topoforge = globalThis.Topoforge = globalThis.Topoforge || {};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

Object.assign(Topoforge, { $, $$ });
})();
